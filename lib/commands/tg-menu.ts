import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readBotRegistry, readProjectBinding } from "../config.ts";
import type { TelegramInstanceMetadata } from "../instance-coordinator.ts";
import type { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import type { MenuUi, TelegramCommandDeps, TelegramConnectionState } from "./telegram-commands.ts";
import type { TgConfigDeps, SessionDeps } from "./register.ts";
import type { BotRecord, BotRegistry, CapturedAgentSession, TelegramConfig } from "../types.ts";
import { currentHostName } from "../tui/host.ts";
import type { TuiHost } from "../tui-bridge.ts";
import { configToolFlow, configThinkingFlow, configRetryFlow, configBashFlow, configModeFlow } from "./tg-config.ts";
import { formatPairingInstructions } from "../pairing.ts";
import { formatDebugReport } from "./info.ts";
import { hostCommandName } from "../session-capture.ts";
import { recordTelegramCommandDescription } from "../telegram-command-descriptions.ts";
import {
  addBotFlow,
  clearBotDefaultFlow,
  regeneratePairingCodeFlow,
  unpairBotFlow,
  setBotDefaultFlow,
  updateBotFlow,
  removeBotFlow,
  bindProjectFlow,
  enableProjectFlow,
  disableProjectFlow,
  unbindProjectFlow,
} from "./telegram-commands.ts";

/** Button labels for the instance picker, in the same order as `instances`.
 *  Project name and model read at a glance; the session id prefix is added only
 *  when two instances share a project name, so the buttons can still be told apart. */
export function formatInstanceChoices(instances: TelegramInstanceMetadata[], activeId: string): string[] {
  const projectOf = (instance: TelegramInstanceMetadata) => (basename(instance.cwd) || instance.cwd).slice(0, 28);
  const counts = new Map<string, number>();
  for (const instance of instances) counts.set(projectOf(instance), (counts.get(projectOf(instance)) ?? 0) + 1);
  return instances.map((instance) => {
    const marker = instance.id === activeId ? "✓" : " ";
    const model = (instance.model || "no-model").slice(0, 36);
    const session = (counts.get(projectOf(instance)) ?? 0) > 1 && instance.sessionId
      ? ` · ${instance.sessionId.slice(0, 8)}`
      : "";
    return `${marker} ${projectOf(instance)} · ${model}${session}`;
  });
}

// ── Menu option labels ─────────────────────────────────────────────────────

const MAIN_MENU_OPTIONS = [
  "🤖 Bots",
  "📁 Project",
  "⌨️ Commands",
  "⚙️ Config",
  "🔄 Switch instance",
  "🛠 Debug info",
] as const;

const BOTS_MENU_ADD = "➕ Add bot";
const BOTS_MENU_LIST = "Bot list";
const BOTS_MENU_DEFAULT_PREFIX = "⭐ Default bot: ";
const CLEAR_DEFAULT_LABEL = "Clear default";

const BOT_ACTION_UPDATE = "Update";
const BOT_ACTION_PAIRING = "Pairing";
const BOT_ACTION_REMOVE = "Remove";
const PAIRING_ACTION_UNPAIR = "Unpair";
const PAIRING_ACTION_NEW_CODE = "New pairing code";

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";
const UNBIND_LABEL = "Unbind";

/** Format a registered bot for display in bot-list / pickers. */
function formatBotLabel(bot: BotRecord, registry: BotRegistry): string {
  const marker = registry.defaultBotId === bot.id ? " ⭐ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  const paired = bot.allowedUserId !== undefined ? "paired" : "not paired";
  return `${bot.name}${marker} · ${username} · ${paired}`;
}

/** Thrown from a leaf action that moves this pi off the current bot: the menu's
 *  chat stops being polled, so the whole /tg menu exits instead of returning
 *  to a submenu nobody can press. */
class MenuClosed extends Error {}

/** Navigation select. On Telegram, ui.menu edits one message in place so the
 *  whole /tg page (title, body, buttons) stays on a single message; the TUI has
 *  no edit concept and falls back to ui.select, with the body as a notice first. */
function pick(ui: MenuUi, title: string, options: string[], body?: string): Promise<string | undefined> {
  if (ui.menu) return ui.menu(title, options, body);
  if (body) ui.notify(body, "info");
  return ui.select(title, options);
}

/** The one place a cancel is decided: an undefined answer (Cancel button, /stop,
 *  terminal Esc, input timeout) closes the whole /tg menu. */
function answered<T>(value: T | undefined): T {
  if (value === undefined) throw new MenuClosed();
  return value;
}

/** A menu pick where only Back (a real choice) leaves the current page. */
async function pickMenu(ui: MenuUi, title: string, options: string[], body?: string): Promise<string> {
  return answered(await pick(ui, title, options, body));
}

/** The UI the /tg menu and the leaf flows it calls receive. Cancelling any
 *  select / input here closes the menu at any depth, instead of returning to
 *  the parent level. confirm is left as is: its boolean cannot tell "No" from
 *  a cancel. Terminal calls of the flows never receive this wrapper. */
function closeOnCancel(ui: MenuUi): MenuUi {
  return {
    ...ui,
    select: async (title, options) => answered(await ui.select(title, options)),
    input: async (title, placeholder) => answered(await ui.input(title, placeholder)),
    ...(ui.inputSecret ? { inputSecret: async (title: string, placeholder?: string) => answered(await ui.inputSecret!(title, placeholder)) } : {}),
    ...(ui.menu ? { menu: async (title: string, options: string[], body?: string) => answered(await ui.menu!(title, options, body)) } : {}),
  };
}

// ── Switch instance flow deps ──────────────────────────────────────────────

export type CommandMenuDeps = {
  /** Full catalog (plugin + host builtins/extensions), deduped by the caller. */
  getCommands: () => Promise<Array<{ name: string; description?: string }>>;
  /** Execute a command in the current Telegram chat. */
  runCommand: (name: string, args: string) => Promise<void>;
};

export type SwitchInstanceDeps = {
  getCoordinator: () => TelegramInstanceCoordinator | undefined;
  getCurrentChatId: () => number | undefined;
  stopPolling: () => Promise<void>;
  startPolling: () => void;
  requestReconcile: () => void;
  getCurrentTurn: () => { chatId: number; messageThreadId?: number; sourceMessageId?: number } | undefined;
  /** Shared handoff gate (same Set used by isActiveInstance) so a
   *  menu-triggered switch blocks outbound sends during the handoff. */
  pendingHandoffs: Set<string>;
};

// ── Menu registration ──────────────────────────────────────────────────────

export function registerTgMenuCommand(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps?: CommandMenuDeps,
  sessionDeps?: SessionDeps,
): void {
  recordTelegramCommandDescription("tg", "Open the Telegram management menu");
  registry.registerCommand("tg", {
    description: "Open the Telegram management menu",
    handler: (_args, ctx) => runTgMenu(
      // MenuUi is the structural subset of ExtensionUIContext the menu flows
      // consume (plus Telegram-only menu/closeMenu hooks injected by the
      // controller's run-with-UI wrapper).
      ctx.ui as unknown as MenuUi,
      deps, configDeps, switchDeps, commandDeps, sessionDeps, ctx.cwd || process.cwd(),
    ),
  });
}

// ── Menu driver ─────────────────────────────────────────────────────────────

async function runTgMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
): Promise<void> {
  try {
    await mainMenu(closeOnCancel(ui), deps, configDeps, switchDeps, commandDeps, sessionDeps, cwd);
  } catch (error) {
    if (!(error instanceof MenuClosed)) throw error;
  } finally {
    await ui.closeMenu?.();
  }
}

async function mainMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
): Promise<void> {
  const options = commandDeps
    ? [...MAIN_MENU_OPTIONS]
    : MAIN_MENU_OPTIONS.filter((option) => option !== "⌨️ Commands");
  while (true) {
    const choice = await pickMenu(ui, "Telegram Management", options);

    if (choice === "🤖 Bots") {
      if (await botsMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "📁 Project") {
      if (await projectMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "⌨️ Commands") {
      if (commandDeps) await commandsMenu(ui, commandDeps);
      continue;
    } else if (choice === "⚙️ Config") {
      if (await configMenu(ui, configDeps, sessionDeps)) continue;
      return;
    } else if (choice === "🔄 Switch instance") {
      if (await switchInstanceMenu(ui, switchDeps)) continue;
      return;
    } else if (choice === "🛠 Debug info") {
      const session = sessionDeps?.getSession();
      if (session) {
        // A page of its own: the report is the body, Back is the only button.
        await pickMenu(ui, "🛠 Debug info", [BACK_LABEL], formatDebugReport(session, cwd));
      } else {
        ui.notify("No active session", "error");
      }
      continue;
    }
    // Unknown choice — return to main menu
  }
}

// ── Full command catalog ───────────────────────────────────────────────────

/** Running a command from the list closes the whole /tg menu: its output lands
 *  in its own message, and reopening /tg is the way back to the menu. Nesting
 *  the command's own dialogs inside the menu's scope would replace that scope. */
async function commandsMenu(ui: MenuUi, deps: CommandMenuDeps): Promise<void> {
  const commands = (await deps.getCommands()).filter((command) => command.name !== "tg");
  if (commands.length === 0) {
    ui.notify("No commands are available.", "info");
    return;
  }
  const labels = commands.map((command) => `/${command.name}${command.description ? ` — ${command.description}` : ""}`);
  const selected = await pickMenu(ui, `⌨️ Commands (${commands.length})`, [...labels, BACK_LABEL]);
  if (selected === BACK_LABEL) return;
  const index = labels.indexOf(selected);
  const command = commands[index];
  if (!command) return;
  await ui.closeMenu?.();
  await deps.runCommand(command.name, "");
  throw new MenuClosed();
}

// ── Bots submenu ───────────────────────────────────────────────────────────

async function botsMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    // Re-read each iteration so the "Default bot" line always shows the
    // current default (or "not set").
    const registry = await readBotRegistry();
    const defaultBot = registry.bots.find((b) => b.id === registry.defaultBotId);
    const defaultChoice = `${BOTS_MENU_DEFAULT_PREFIX}${defaultBot?.name ?? "not set"}`;
    const choice = await pickMenu(ui, "🤖 Bots", [BOTS_MENU_ADD, BOTS_MENU_LIST, defaultChoice, BACK_LABEL]);
    if (choice === BACK_LABEL) return true; // back to main

    if (choice === BOTS_MENU_ADD) {
      await addBotFlow(ui, deps);
    } else if (choice === BOTS_MENU_LIST) {
      await botListMenu(ui, deps, cwd);
    } else if (choice === defaultChoice) {
      await defaultBotMenu(ui, deps, cwd);
    }
    // loop re-renders the Bots submenu
  }
}

// ── Global default bot (the default is set ONLY here) ──────────────────────

async function defaultBotMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify(`No bots registered. Use ${BOTS_MENU_ADD} first.`, "info");
      return;
    }
    // The current default is ⭐-marked via formatBotLabel; "Clear default" only exists
    // while a default actually is set.
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await pickMenu(ui, "⭐ Default bot", [
      ...choices,
      ...(registry.defaultBotId ? [CLEAR_DEFAULT_LABEL] : []),
      BACK_LABEL,
    ]);
    if (selected === BACK_LABEL) return; // back to Bots submenu

    if (selected === CLEAR_DEFAULT_LABEL) {
      if (await clearBotDefaultFlow(ui, deps, cwd)) throw new MenuClosed();
      continue;
    }
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot && await setBotDefaultFlow(ui, bot.id, deps, cwd)) throw new MenuClosed();
    // loop re-renders the picker (the ⭐ marker may have moved)
  }
}

// ── Bot list (object-first: pick a bot → per-bot actions) ──────────────────

async function botListMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify(`No bots registered. Use ${BOTS_MENU_ADD} first.`, "info");
      return;
    }
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await pickMenu(ui, "Bot list", [...choices, BACK_LABEL]);
    if (selected === BACK_LABEL) return; // back to Bots submenu
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot) await botDetailMenu(ui, deps, cwd, bot);
    // loop re-renders the bot list (reflects remove/pairing changes)
  }
}

// ── Per-bot actions ──────────────────────────────────────────────────────────

async function botDetailMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  bot: BotRecord,
): Promise<void> {
  while (true) {
    // Re-read each iteration so the bot's existence stays fresh.
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return; // removed elsewhere → back to bot list
    }
    // The global default is set only in the ⭐ Default bot submenu; this page
    // holds the bot's own actions.
    const paired = botNow.allowedUserId !== undefined;
    const choice = await pickMenu(
      ui,
      `🤖 ${botNow.name}`,
      [BOT_ACTION_UPDATE, BOT_ACTION_PAIRING, BOT_ACTION_REMOVE, BACK_LABEL],
      [
        `Name: ${botNow.name}`,
        `Username: ${botNow.botUsername ? `@${botNow.botUsername}` : "unknown"}`,
        `API base: ${botNow.apiBase ?? "default"}`,
        `Pairing: ${paired ? `paired (user ${botNow.allowedUserId})` : "not paired"}`,
        `Default bot: ${registry.defaultBotId === botNow.id ? "yes" : "no"}`,
      ].join("\n"),
    );
    if (choice === BACK_LABEL) return; // back to bot list

    if (choice === BOT_ACTION_UPDATE) {
      await updateBotFlow(ui, deps, cwd, botNow.id);
    } else if (choice === BOT_ACTION_PAIRING) {
      await pairingMenu(ui, deps, botNow);
    } else if (choice === BOT_ACTION_REMOVE) {
      await removeBotFlow(ui, deps, cwd, botNow.id);
      const removed = !(await readBotRegistry()).bots.some((b) => b.id === botNow.id);
      if (removed) return; // back to bot list (re-reads without this bot); declined → stay here
    }
    // loop re-renders the per-bot action menu (re-reads registry)
  }
}

// ── Per-bot pairing page ─────────────────────────────────────────────────────

async function pairingMenu(ui: MenuUi, deps: TelegramCommandDeps, bot: BotRecord): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return;
    }
    const paired = botNow.allowedUserId !== undefined;
    // The state or the pairing instructions are the page's body, not a notice
    // sent before it, so they stay on the same message as the buttons.
    const body = paired
      ? `Paired user: ${botNow.allowedUserId}`
      : formatPairingInstructions({ ...botNow, botToken: botNow.token } as TelegramConfig);
    const choice = await pickMenu(
      ui,
      `🔑 Pairing · ${botNow.name}`,
      paired ? [PAIRING_ACTION_UNPAIR, BACK_LABEL] : [PAIRING_ACTION_NEW_CODE, BACK_LABEL],
      body,
    );
    if (choice === BACK_LABEL) return; // back to bot detail

    if (choice === PAIRING_ACTION_NEW_CODE) {
      await regeneratePairingCodeFlow(ui, deps, botNow.id);
    } else if (choice === PAIRING_ACTION_UNPAIR) {
      await unpairBotFlow(ui, deps, botNow.id);
    }
    // loop re-renders the pairing page (fresh code / pairing state)
  }
}

// ── Project submenu (binding + real connection state) ──────────────────────

/** Second item: the actual runtime connection state (same source as the
 *  status bar), offered as the matching action. */
function connectionChoice(state: TelegramConnectionState): string {
  if (state === "connected") return "🟢 Connected → Disconnect";
  if (state === "connecting") return "🔄 Connecting → Disconnect";
  if (state === "other-instance") return "🟡 In use by another instance";
  return "⚪ Disconnected → Connect";
}

async function projectMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    const [registry, project] = await Promise.all([readBotRegistry(), readProjectBinding(cwd)]);
    const boundBotId = project?.binding.botId;
    // A binding without botId = follows the global default bot (a `{ enabled: false }`
    // disconnect record also counts as following the default, not "bound").
    const followsDefault = !boundBotId;
    const effectiveBotId = boundBotId ?? registry.defaultBotId;
    const effectiveBot = effectiveBotId ? registry.bots.find((b) => b.id === effectiveBotId) : undefined;

    const botLabel = effectiveBot
      ? `Bot: ${effectiveBot.name}${followsDefault ? " (default)" : ""}`
      : "Bot: not set";

    const connection = deps.connectionState();
    const connectLabel = connectionChoice(connection);

    const choice = await pickMenu(ui, "📁 Project", [
      botLabel,
      // No usable bot means nothing to connect; hide this entry.
      ...(effectiveBot ? [connectLabel] : []),
      BACK_LABEL,
    ]);
    if (choice === BACK_LABEL) return true; // back to main

    if (choice === botLabel) {
      if (registry.bots.length === 0) {
        ui.notify("No bots registered. Use /tg → Bots → Add bot first.", "info");
        continue;
      }
      const choices = registry.bots.map((b) => formatBotLabel(b, registry));
      // Unbind only makes sense for projects whose binding has a botId.
      const selected = await pickMenu(ui, "Bind project to bot", [...choices, ...(boundBotId ? [UNBIND_LABEL] : []), BACK_LABEL]);
      if (selected === BACK_LABEL) continue;
      if (selected === UNBIND_LABEL) {
        await unbindProjectFlow(ui, deps, cwd);
      } else {
        const bot = registry.bots[choices.indexOf(selected)];
        if (bot) await bindProjectFlow(ui, deps, cwd, bot.id);
      }
    } else if (choice === connectLabel) {
      if (connection === "other-instance") {
        ui.notify(`Another ${hostCommandName()} instance is serving this bot`, "info");
      } else if (connection === "disconnected") {
        // flow awaits reconcile, so the next render shows the new state.
        await enableProjectFlow(ui, deps, cwd);
      } else {
        const ok = await ui.confirm(
          "Disconnect Telegram for this folder?",
          "Telegram will stop responding. Reconnect only from the terminal with /tg.",
        );
        if (ok) await disableProjectFlow(ui, deps, cwd);
      }
    }
    // loop re-renders Project (binding + live connection state)
  }
}

// ── Config submenu ─────────────────────────────────────────────────────────

/** Build the Config submenu entries. Model thinking level lives on the
 * session, not the bridge config; the flat thinking command was removed, so
 * this menu is its Telegram-side home on OMP (no Telegram-reachable hotkey).
 * pi has a native /thinking command that Telegram forwards and its selector
 * can already operate, so hide the entry there instead of duplicating it. */
export function buildConfigMenuOptions(
  config: TelegramConfig,
  session: CapturedAgentSession | undefined,
  host: TuiHost,
): string[] {
  const thinkingLevels = session?.getAvailableThinkingLevels() ?? [];
  return [
    `🔧 Tool: ${config.tool ?? "brief"}`,
    `💭 Thinking: ${config.thinking ?? "brief"}`,
    ...(host !== "pi" && thinkingLevels.length > 0
      ? [`🧠 Thinking level: ${session?.thinkingLevel ?? "off"}`]
      : []),
    `🔄 Retry: ${config.retryCount ?? 3}`,
    `📨 Message mode: ${config.messageMode ?? "steer"}`,
    `🐚 Shell confirm: ${config.bashConfirm ?? "dangerous"}`,
    BACK_LABEL,
  ];
}

async function configMenu(ui: MenuUi, configDeps: TgConfigDeps, sessionDeps?: SessionDeps): Promise<boolean> {
  while (true) {
    const session = sessionDeps?.getSession();
    const thinkingLevels = session?.getAvailableThinkingLevels() ?? [];

    const choice = await pickMenu(ui, CONFIG_MENU_PREFIX, buildConfigMenuOptions(configDeps.getConfig(), session, currentHostName()));
    if (choice === BACK_LABEL) return true; // back to main

    if (choice.startsWith("🔧 Tool:")) {
      await configToolFlow(ui, configDeps);
    } else if (choice.startsWith("💭 Thinking:")) {
      await configThinkingFlow(ui, configDeps);
    } else if (choice.startsWith("🧠 Thinking level:")) {
      if (!session || thinkingLevels.length === 0) continue;
      const labels = thinkingLevels.map((l) => (l === session.thinkingLevel ? "● " : "  ") + String(l));
      const selected = await pickMenu(ui, "Thinking level", labels);
      const level = thinkingLevels[labels.indexOf(selected)];
      if (level !== undefined) {
        session.setThinkingLevel(level);
        ui.notify(`Thinking level set: ${level}`, "info");
      }
    } else if (choice.startsWith("🔄 Retry:")) {
      await configRetryFlow(ui, configDeps);
    } else if (choice.startsWith("📨 Message mode:")) {
      await configModeFlow(ui, configDeps);
    } else if (choice.startsWith("🐚 Shell confirm:")) {
      await configBashFlow(ui, configDeps);
    }
  }
}

// ── Switch instance submenu ────────────────────────────────────────────────

async function switchInstanceMenu(ui: MenuUi, switchDeps: SwitchInstanceDeps): Promise<boolean> {
  const coordinator = switchDeps.getCoordinator();
  if (!coordinator || !coordinator.isActive()) {
    ui.notify(`This ${hostCommandName()} instance is not the active Telegram instance.`, "error");
    return true; // back to main
  }
  const instances = await coordinator.listInstances();
  const active = coordinator.getActive();
  if (!active || instances.length === 0) {
    ui.notify("No live Telegram instances are available.", "error");
    return true; // back to main
  }

  const choices = formatInstanceChoices(instances, active.instanceId);
  const selected = await pickMenu(ui, `Switch Telegram ${hostCommandName()} instance`, [...choices, BACK_LABEL]);
  if (selected === BACK_LABEL) return true; // back to main

  const target = instances[choices.indexOf(selected)];
  if (!target) return true;

  const turn = switchDeps.getCurrentTurn();
  const chatId = turn?.chatId ?? switchDeps.getCurrentChatId();
  if (chatId === undefined) {
    ui.notify("No active Telegram chat is available for history replay.", "error");
    return true;
  }

  const handoffId = randomUUID();
  const pendingHandoffs = switchDeps.pendingHandoffs;
  pendingHandoffs.add(handoffId);
  try {
    await switchDeps.stopPolling();
    await coordinator.switchTo(
      target.id,
      {
        chatId,
        messageThreadId: turn?.messageThreadId,
        sourceMessageId: turn?.sourceMessageId,
      },
      { instanceId: active.instanceId, generation: active.generation },
    );
  } finally {
    pendingHandoffs.delete(handoffId);
    switchDeps.requestReconcile();
    if (pendingHandoffs.size === 0 && coordinator.isActive() && !coordinator.getActive()?.replay) {
      switchDeps.startPolling();
    }
  }
  return true; // back to main
}