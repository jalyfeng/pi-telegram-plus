import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTelegramMyCommands } from "./telegram-api.ts";
import { log } from "./logger.ts";
import { loadRecentCommands } from "./command-usage.ts";
import { getTuiCommands, tuiBridge, type TuiCommand, type TuiHost } from "./tui-bridge.ts";
import { isTerminalOnlyCommand } from "./terminal-only-commands.ts";
import { getTelegramCommandDescriptions } from "./telegram-command-descriptions.ts";

const menuLog = log.child("menu-commands");

// Names and order of the menu entries. Commands the plugin serves on Telegram
// carry no description here: their description is the one they registered.
const TELEGRAM_MENU_COMMANDS: Array<{ command: string; description?: string }> = [
  // Keep the built-in pi commands in the same order as the TUI slash menu.
  { command: "login", description: "Configure provider authentication" },
  { command: "logout", description: "Remove stored credentials" },
  { command: "model", description: "Show or change the current model" },
  { command: "scoped-models", description: "Enable/disable models for cycling" },
  { command: "settings", description: "Open settings menu" },
  { command: "resume", description: "Resume a previous session" },
  { command: "new" },
  { command: "name", description: "Set or show session name" },
  { command: "session", description: "Show session statistics" },
  { command: "trust", description: "Save project trust decision" },
  { command: "fork", description: "Fork from a previous message" },
  { command: "clone", description: "Clone at a previous message" },
  { command: "compact", description: "Compact session context" },
  { command: "export", description: "Export session" },
  { command: "share", description: "Share session as gist" },
  { command: "reload" },
  { command: "hotkeys" },
  { command: "changelog", description: "Show changelog" },
  { command: "quit" },

  // Additional pi-telegram-plus commands.
  { command: "cwd" },
  { command: "cd" },
  { command: "import" },
  { command: "stop" },
  { command: "status" },
  // Consolidated Telegram management menu — replaces all flat /tg-* commands.
  { command: "tg" },
];

/**
 * Host commands that should stay near the top of the 100-entry BotMenu. These
 * are the common interactive entry points, not an attempt to mirror the full
 * (unbounded) TUI catalog.
 */
const CORE_COMMAND_PRIORITY = [
  "tools", "mcp", "agents", "permissions", "hooks", "skills", "plugins", "marketplace",
  "plan", "goal", "review", "theme", "trust", "init", "help", "commands",
  "clear", "cost", "context", "diff", "undo", "redo",
];

// Commands the plugin itself dispatches from Telegram (handlers in
// telegramCommands, or the /tg hub), valid on every host regardless of the
// captured catalog.
const TELEGRAM_SERVED_COMMANDS = new Set([
  "tg", "cwd", "cd", "status", "stop",
]);

const toTelegramCommandName = (name: string): string | undefined => {
  // Telegram bot menu commands allow only [A-Za-z0-9_] and max 32 chars.
  const telegramName = name.replace(/-/g, "_").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(telegramName)) return undefined;
  return telegramName;
};

export type MenuCommandOptions = {
  /** Recently used commands, newest first. */
  recent?: readonly string[];
  /** Host builtin/autocomplete catalog captured by the TUI bridge. */
  tuiCommands?: readonly TuiCommand[];
  /** Host kind; decides which terminal-only commands are left out. Defaults to "unknown". */
  host?: TuiHost;
  /** Descriptions the plugin registered for the commands it serves on Telegram, keyed by command name. */
  pluginDescriptions?: ReadonlyMap<string, string>;
};

export type TelegramMenuBuildResult = {
  /** The list sent to setMyCommands: at most 100 entries; the last is `more` when there is an overflow. */
  commands: Array<{ command: string; description: string }>;
  /** Commands that fit no more in the 100-entry menu; served by the /more inline keyboard. */
  overflow: Array<{ command: string; description: string }>;
};

export function buildTelegramMenuCommandsFull(
  pi: Pick<ExtensionAPI, "getCommands">,
  options: MenuCommandOptions = {},
): TelegramMenuBuildResult {
  const commands = new Map<string, string>();
  const host = options.host ?? "unknown";
  // The single place that decides a menu description. A command the plugin serves
  // on Telegram shows the plugin's own text: the host's text describes the
  // terminal command. Otherwise the host's text, then the static fallback.
  const pluginDescriptions = new Map<string, string>();
  for (const [name, description] of options.pluginDescriptions ?? []) {
    const n = toTelegramCommandName(name);
    if (n && description.trim()) pluginDescriptions.set(n, description.trim());
  }
  const addCommand = (name: string, description?: string) => {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName || commands.has(telegramName)) return;
    // Terminal-only commands (and /cd on OMP) are never offered in Telegram.
    if (isTerminalOnlyCommand(name, host)) return;
    const text = pluginDescriptions.get(telegramName) || description?.trim() || `Run /${telegramName}`;
    commands.set(telegramName, text.slice(0, 256));
  };

  // When the TUI bridge has captured the host catalog, a static entry the host
  // does not actually serve would reach no handler and fall through to the
  // model as prompt text (e.g. `clone` on OMP, or `thinking` where the host has
  // no native command). Filter static entries against the live catalog; keep
  // plugin-served commands. With no captured catalog, keep the curated list.
  // Host descriptions come from the host's structured lists: pi's getCommands()
  // (the raw extension text) and OMP's builtin list. The autocomplete text is a
  // display string: pi prefixes it with a source tag ("[t] ..."), so it is used
  // only for a name no structured list describes.
  const catalogNames = new Set<string>();
  const structuredDescriptions = new Map<string, string | undefined>();
  const autocompleteDescriptions = new Map<string, string>();
  const noteCatalog = (name: string, description: string | undefined, structured: boolean) => {
    const n = toTelegramCommandName(name);
    if (!n) return;
    catalogNames.add(n);
    const trimmed = description?.trim() || undefined;
    if (structured) {
      if (!structuredDescriptions.has(n)) structuredDescriptions.set(n, trimmed);
    } else if (trimmed && !autocompleteDescriptions.has(n)) {
      autocompleteDescriptions.set(n, trimmed);
    }
  };
  const hostDescription = (n: string | undefined): string | undefined => {
    if (!n) return undefined;
    return structuredDescriptions.has(n) ? structuredDescriptions.get(n) : autocompleteDescriptions.get(n);
  };
  for (const command of options.tuiCommands ?? []) {
    noteCatalog(command.name, command.description, command.source === "builtin");
  }
  for (const command of pi.getCommands()) noteCatalog(command.name, command.description, true);
  const catalogAvailable = (options.tuiCommands?.length ?? 0) > 0;
  // One rule for every entry, static or recent: with a captured catalog, a name
  // is offered only if the host serves it or the plugin serves it on Telegram.
  const offeredHere = (n: string | undefined): boolean =>
    !catalogAvailable || !n || catalogNames.has(n) || TELEGRAM_SERVED_COMMANDS.has(n);
  for (const command of TELEGRAM_MENU_COMMANDS) {
    const n = toTelegramCommandName(command.command);
    if (!offeredHere(n)) continue;
    // The static copy is a fallback wording; the live host description wins so
    // the BotMenu never shows text the host itself stopped using.
    addCommand(command.command, hostDescription(n) ?? command.description);
  }

  const recentPriority = new Map<string, number>();
  for (const [index, name] of (options.recent ?? []).entries()) {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName) continue;
    if (!recentPriority.has(telegramName)) recentPriority.set(telegramName, index);
  }

  // Priority queue for dynamic commands (host + extensions + recent)
  const dynamic: Array<{ name: string; desc?: string }> = [];
  const seenDynamic = new Set<string>();
  for (const command of options.tuiCommands ?? []) {
    const n = toTelegramCommandName(command.name);
    if (!n) continue;
    if (commands.has(n)) continue;
    if (seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name: command.name, desc: hostDescription(n) });
  }
  for (const cmd of pi.getCommands()) {
    const n = toTelegramCommandName(cmd.name);
    if (!n) continue;
    if (commands.has(n)) continue;
    if (seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name: cmd.name, desc: hostDescription(n) });
  }
  for (const name of options.recent ?? []) {
    const n = toTelegramCommandName(name);
    if (!n || !offeredHere(n)) continue;
    if (commands.has(n) || seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name, desc: undefined });
  }

  // Core host commands stay first. Recent usage then boosts non-core dynamic
  // commands without displacing the curated Telegram entry points.
  const pri = new Map(CORE_COMMAND_PRIORITY.map((c, i) => [c.replace(/-/g, "_").toLowerCase(), i]));
  dynamic.sort((a, b) => {
    const an = toTelegramCommandName(a.name) ?? a.name.replace(/-/g, "_").toLowerCase();
    const bn = toTelegramCommandName(b.name) ?? b.name.replace(/-/g, "_").toLowerCase();
    const pa = pri.get(an) ?? Number.MAX_SAFE_INTEGER;
    const pb = pri.get(bn) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const ra = recentPriority.get(an) ?? Number.MAX_SAFE_INTEGER;
    const rb = recentPriority.get(bn) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return an.localeCompare(bn);
  });

  for (const d of dynamic) addCommand(d.name, d.desc);

  const all = Array.from(commands, ([command, description]) => ({ command, description }));
  if (all.length <= 100) return { commands: all, overflow: [] };
  // Reserve the last menu slot for /more, which opens an inline keyboard over
  // the overflow; each button dispatches its command like a typed message.
  const kept = all.slice(0, 99);
  const overflow = all.slice(99);
  // A host that defines its own /more already occupies a kept slot; do not
  // send setMyCommands a duplicate command name.
  if (!kept.some((entry) => entry.command === "more")) kept.push({ command: "more", description: "Show more commands" });
  return { commands: kept, overflow };
}

export function buildTelegramMenuCommands(
  pi: Pick<ExtensionAPI, "getCommands">,
  options: MenuCommandOptions = {},
): Array<{ command: string; description: string }> {
  return buildTelegramMenuCommandsFull(pi, options).commands;
}

const menuSyncInFlight = new Map<string, Promise<void>>();
const menuSyncScheduled = new Map<string, ReturnType<typeof setTimeout>>();

function syncKey(botToken: string, apiBase?: string): string {
  return `${apiBase ?? "https://api.telegram.org"}\u0000${botToken}`;
}

const menuOverflowByBot = new Map<string, Array<{ command: string; description: string }>>();

/** Overflow commands from the last menu sync for this bot, newest menu first. */
export function getTelegramMenuOverflow(botToken: string | undefined, apiBase?: string): Array<{ command: string; description: string }> {
  if (!botToken) return [];
  return menuOverflowByBot.get(syncKey(botToken, apiBase)) ?? [];
}

async function doSyncTelegramCommands(botToken: string, pi: ExtensionAPI, apiBase?: string): Promise<void> {
  const [recent, tuiCommands] = await Promise.all([
    loadRecentCommands().catch(() => []),
    getTuiCommands().catch(() => []),
  ]);
  const { commands, overflow } = buildTelegramMenuCommandsFull(pi, {
    recent,
    tuiCommands,
    host: tuiBridge.getHost(),
    pluginDescriptions: getTelegramCommandDescriptions(),
  });
  await setTelegramMyCommands(botToken, commands, apiBase);
  menuOverflowByBot.set(syncKey(botToken, apiBase), overflow);
}

export async function syncTelegramCommands(botToken: string | undefined, pi: ExtensionAPI, apiBase?: string): Promise<void> {
  if (!botToken) return;
  const key = syncKey(botToken, apiBase);
  const existing = menuSyncInFlight.get(key);
  if (existing) {
    try {
      await existing;
    } catch (err) {
      menuLog.warn("syncTelegramCommands failed", { err });
    }
    return;
  }

  const sync = doSyncTelegramCommands(botToken, pi, apiBase);
  menuSyncInFlight.set(key, sync);
  try {
    await sync;
  } catch (err) {
    menuLog.warn("syncTelegramCommands failed", { err });
  } finally {
    if (menuSyncInFlight.get(key) === sync) menuSyncInFlight.delete(key);
  }
}

export function scheduleTelegramCommandRefresh(botToken: string | undefined, pi: ExtensionAPI, apiBase?: string, delayMs = 250): void {
  if (!botToken) return;
  const key = `${syncKey(botToken, apiBase)}\u0000${delayMs}`;
  const existing = menuSyncScheduled.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    menuSyncScheduled.delete(key);
    void syncTelegramCommands(botToken, pi, apiBase);
  }, delayMs);
  timer.unref?.();
  menuSyncScheduled.set(key, timer);
}

/**
 * Drop pending command refreshes; call from extension dispose. The scheduled
 * sync captured this instance's `pi` context, which the host invalidates on
 * reload — firing afterwards only logs "extension ctx is stale".
 */
export function cancelTelegramCommandRefreshes(): void {
  for (const timer of menuSyncScheduled.values()) clearTimeout(timer);
  menuSyncScheduled.clear();
}
