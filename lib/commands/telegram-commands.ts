import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addBot, bindProjectTelegram, findBotByIdOrName, readBotRegistry, removeBot, setDefaultBot, unbindProjectTelegram, updateBot, writeProjectBinding, readProjectBinding, readResolvedTelegramConfig } from "../config.ts";
import { escapeHtml } from "../html.ts";
import { getTelegramBotUsername } from "../telegram-api.ts";
import { createTelegramPairingCode, ensureTelegramPairingCode, formatPairingInstructions } from "../pairing.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig, TelegramTransport } from "../types.ts";
import type { TelegramPollingRuntime } from "../polling.ts";
import { log } from "../logger.ts";

const tgCmdLog = log.child("tg-commands");

export type TelegramCommandDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (c: TelegramConfig) => void;
  persistConfig: (c: TelegramConfig) => Promise<void>;
  getResolvedConfig: () => ResolvedTelegramConfig | undefined;
  switchResolvedConfig: (next: ResolvedTelegramConfig) => void;
  isTelegramEnabled: () => boolean;
  transport: TelegramTransport;
  getPolling: () => TelegramPollingRuntime;
  refreshStatus: () => void;
  syncTelegramCommands: () => Promise<void>;
  startStatusHeartbeat: () => void;
  clearStatusError: () => void;
};

// ── Shared UI type ─────────────────────────────────────────────────────────

export type MenuUi = {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
};

// ── Reusable flow functions (shared by flat commands and /tg menu) ─────────

export async function listBotsFlow(ui: MenuUi): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Use /tg-bot-add or /tg → Bots → Add bot to add one.", "info");
    return;
  }
  const lines = registry.bots.map((bot) => {
    const defaultMarker = registry.defaultBotId === bot.id ? " ★ default" : "";
    const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
    const paired = bot.allowedUserId !== undefined ? `paired (user ${bot.allowedUserId})` : bot.pairingCode ? `pairing: ${bot.pairingCode}` : "not paired";
    return `- ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)}) · ${username} · ${paired}${defaultMarker}`;
  });
  ui.notify(`Registered bots:\n${lines.join("\n")}`, "info");
}

export async function addBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  name?: string,
  token?: string,
): Promise<void> {
  const botName = name ?? await ui.input("Bot name (unique label, e.g. 'work-bot')");
  if (!botName) return;
  const botToken = token ?? await (ui.inputSecret?.("Telegram bot token (from @BotFather)") ?? ui.input("Telegram bot token (from @BotFather)"));
  if (!botToken) return;
  const registry = await readBotRegistry();
  if (registry.bots.some((b) => b.name.toLowerCase() === botName.toLowerCase())) {
    ui.notify(`A bot named "${escapeHtml(botName)}" already exists. Choose a different name.`, "error");
    return;
  }
  const apiBase = deps.getConfig().apiBase;
  const botUsername = await getTelegramBotUsername(botToken, apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-add"));
  const pairingCode = createTelegramPairingCode();
  const bot: BotRecord = {
    id: randomUUID(),
    name: botName,
    token: botToken,
    ...(botUsername === undefined ? {} : { botUsername }),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
  };
  const updatedRegistry = await addBot(bot);
  const isDefault = updatedRegistry.defaultBotId === bot.id;
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ui.notify(
    `Bot added: ${escapeHtml(botName)}${botUsername ? ` (@${botUsername})` : ""}${isDefault ? " — set as default" : ""}\n${formatPairingInstructions({ ...bot, botToken } as TelegramConfig)}`,
    "info",
  );
}

export async function setBotDefaultFlow(
  ui: MenuUi,
  botId: string,
): Promise<void> {
  await setDefaultBot(botId);
  const registry = await readBotRegistry();
  const bot = findBotByIdOrName(registry, botId);
  ui.notify(`Default bot set to: ${escapeHtml(bot?.name ?? botId)} (${botId.slice(0, 8)})`, "info");
}

export async function updateBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  field?: string,
  value?: string,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  const selectedField = field ?? await ui.input("Field to update (token, name, allowedUserId, apiBase)");
  if (!selectedField) return;
  const validFields = ["token", "name", "allowedUserId", "apiBase"];
  if (!validFields.includes(selectedField)) {
    ui.notify(`Invalid field. Choose from: ${validFields.join(", ")}`, "error");
    return;
  }
  let fieldValue: string | undefined;
  if (selectedField === "token") {
    fieldValue = value ?? await (ui.inputSecret?.("New token") ?? ui.input("New token"));
  } else {
    fieldValue = value ?? await ui.input(`New value for ${selectedField}`);
  }
  if (!fieldValue) return;
  const updates: Partial<Omit<BotRecord, "id">> = {};
  if (selectedField === "token") {
    updates.token = fieldValue;
    const botUsername = await getTelegramBotUsername(fieldValue, bot.apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-update"));
    if (botUsername) updates.botUsername = botUsername;
  } else if (selectedField === "name") {
    if (registry.bots.some((b) => b.id !== bot.id && b.name.toLowerCase() === fieldValue!.toLowerCase())) {
      ui.notify(`A bot named "${escapeHtml(fieldValue)}" already exists.`, "error");
      return;
    }
    updates.name = fieldValue;
  } else if (selectedField === "allowedUserId") {
    const userId = Number(fieldValue);
    if (!Number.isInteger(userId)) {
      ui.notify(`Invalid allowedUserId: must be an integer.`, "error");
      return;
    }
    updates.allowedUserId = userId;
  } else if (selectedField === "apiBase") {
    updates.apiBase = fieldValue;
  }
  await updateBot(bot.id, updates);
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.syncTelegramCommands();
    deps.refreshStatus();
  }
  ui.notify(`Bot updated: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})`, "info");
}

export async function removeBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  skipConfirm = false,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  if (!skipConfirm) {
    const confirmed = await ui.confirm(`Remove bot "${bot.name}"?`, `This will remove the bot from the registry. Any project .pi/telegram.json referencing this bot will lose its binding.`);
    if (!confirmed) return;
  }
  const wasDefault = registry.defaultBotId === bot.id;
  await removeBot(bot.id);
  if (wasDefault) {
    ui.notify(`Warning: removed bot was the default. ${registry.bots.length > 1 ? "A remaining bot was promoted." : "No default bot is set."}`, "warning");
  }
  ui.notify(
    `Bot removed: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})\nAny project .pi/telegram.json referencing this bot will lose its binding.`,
    "warning",
  );
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.getPolling().stop();
    deps.refreshStatus();
  }
}

export async function bindProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId?: string,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Use /tg-bot-add or /tg → Bots → Add bot first.", "error");
    return;
  }
  let bot: BotRecord | undefined;
  if (botId) {
    bot = registry.bots.find((b) => b.id === botId) ?? findBotByIdOrName(registry, botId);
    if (!bot) {
      ui.notify(`Bot not found: ${escapeHtml(botId)}. Use /tg-bot-list to see registered bots.`, "error");
      return;
    }
  } else {
    const choices = registry.bots.map((b) => {
      const marker = registry.defaultBotId === b.id ? " ★" : "";
      const username = b.botUsername ? `@${b.botUsername}` : "no username";
      return `${b.name}${marker} · ${username} · ${b.id.slice(0, 8)}`;
    });
    const selected = await ui.select("Select a bot to bind to this project", choices);
    if (!selected) return;
    bot = registry.bots[choices.indexOf(selected)];
  }
  if (!bot) return;

  const workspacePath = resolve(cwd);
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await bindProjectTelegram(workspacePath, bot.id));
  const config = ensureTelegramPairingCode(deps.getConfig());
  if (config !== deps.getConfig()) {
    await updateBot(bot.id, { ...(config.pairingCode !== undefined ? { pairingCode: config.pairingCode } : {}) });
  }
  deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.startStatusHeartbeat();
  deps.refreshStatus();
  ui.notify(
    `Project bound to bot: ${escapeHtml(bot.name)}${bot.botUsername ? ` (@${bot.botUsername})` : ""}\n${escapeHtml(workspacePath)}\n${formatPairingInstructions(config)}`,
    "info",
  );
}

export async function enableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No Telegram bot registered. Use /tg-bot-add or /tg → Bots → Add bot first.", "error");
    return;
  }
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (project) {
    await writeProjectBinding(project.path, { ...project.binding, enabled: true });
  } else {
    if (!registry.defaultBotId) {
      ui.notify("No default bot set. Use /tg-bot-default to set one, or /tg → Bots → Set default.", "error");
      return;
    }
    await writeProjectBinding(workspacePath, { botId: registry.defaultBotId, enabled: true });
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  deps.setConfig({ ...deps.getConfig(), telegramEnabled: true });
  await deps.getPolling().stop();
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  deps.refreshStatus();
  ui.notify(`Telegram bot enabled for current project.`, "info");
}

export async function disableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (project) {
    await writeProjectBinding(project.path, { ...project.binding, enabled: false });
  } else {
    deps.setConfig({ ...deps.getConfig(), telegramEnabled: false });
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  await deps.getPolling().stop();
  deps.clearStatusError();
  deps.refreshStatus();
  ui.notify(`Telegram bot disabled for current project.`, "info");
}

export async function unbindProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  skipConfirm = false,
): Promise<void> {
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (!project) {
    ui.notify("Current project has no Telegram binding. It is using the default bot (if any).", "info");
    return;
  }
  if (!skipConfirm) {
    const confirmed = await ui.confirm(`Unbind project?`, `Remove Telegram project binding for ${project.path}?`);
    if (!confirmed) return;
  }
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await unbindProjectTelegram(workspacePath));
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ui.notify(`Removed Telegram project binding:\n${escapeHtml(project.path)}\nProject now uses the default bot (if any).`, "info");
}

export async function showProjectBindingFlow(
  ui: MenuUi,
  cwd: string,
): Promise<void> {
  const registry = await readBotRegistry();
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  const lines: string[] = [];

  if (project) {
    const bot = project.binding.botId ? findBotByIdOrName(registry, project.binding.botId) : undefined;
    const effectiveBot = bot ?? (registry.defaultBotId ? findBotByIdOrName(registry, registry.defaultBotId) : undefined);
    const enabled = project.binding.enabled !== false;
    lines.push(`Project: ${escapeHtml(project.path)}`);
    lines.push(`  bot: ${effectiveBot ? escapeHtml(effectiveBot.name) : "(unresolved)"}`);
    lines.push(`  enabled: ${enabled}`);
    if (project.binding.tool) lines.push(`  tool: ${project.binding.tool}`);
    if (project.binding.thinking) lines.push(`  thinking: ${project.binding.thinking}`);
  } else {
    lines.push(`Project: ${escapeHtml(workspacePath)} — no .pi/telegram.json (using default bot)`);
  }

  const defaultBot = registry.defaultBotId ? findBotByIdOrName(registry, registry.defaultBotId) : undefined;
  lines.push("");
  lines.push(`Default bot: ${defaultBot ? escapeHtml(defaultBot.name) : "(none set)"}`);

  ui.notify(lines.join("\n"), "info");
}

// ── Flat command handlers (thin wrappers that parse args then call flows) ──

async function handleTgBotAdd(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  await addBotFlow(ctx.ui, deps);
}

async function handleTgBotList(
  _args: string,
  ctx: any,
  _deps: TelegramCommandDeps,
): Promise<void> {
  await listBotsFlow(ctx.ui);
}

async function handleTgBotUpdate(
  args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const query = args.trim();
  if (!query) {
    ctx.ui.notify("Usage: /tg-bot-update <id|name>", "error");
    return;
  }
  const registry = await readBotRegistry();
  const bot = findBotByIdOrName(registry, query);
  if (!bot) {
    ctx.ui.notify(`Bot not found: ${escapeHtml(query)}`, "error");
    return;
  }
  await updateBotFlow(ctx.ui, deps, ctx.cwd || process.cwd(), bot.id);
}

async function handleTgBotRemove(
  args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const query = args.trim();
  if (!query) {
    ctx.ui.notify("Usage: /tg-bot-remove <id|name>", "error");
    return;
  }
  const registry = await readBotRegistry();
  const bot = findBotByIdOrName(registry, query);
  if (!bot) {
    ctx.ui.notify(`Bot not found: ${escapeHtml(query)}`, "error");
    return;
  }
  await removeBotFlow(ctx.ui, deps, ctx.cwd || process.cwd(), bot.id, true);
}

async function handleTgBotDefault(
  args: string,
  ctx: any,
  _deps: TelegramCommandDeps,
): Promise<void> {
  const query = args.trim();
  if (!query) {
    ctx.ui.notify("Usage: /tg-bot-default <id|name>", "error");
    return;
  }
  const registry = await readBotRegistry();
  const bot = findBotByIdOrName(registry, query);
  if (!bot) {
    ctx.ui.notify(`Bot not found: ${escapeHtml(query)}`, "error");
    return;
  }
  await setBotDefaultFlow(ctx.ui, bot.id);
}

// ── Project binding handlers ──────────────────────────────────────────────

async function handleTgBindCwd(
  args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const query = args.trim();
  await bindProjectFlow(ctx.ui, deps, ctx.cwd || process.cwd(), query || undefined);
}

async function handleTgCwdConnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  await enableProjectFlow(ctx.ui, deps, ctx.cwd || process.cwd());
}

async function handleTgCwdDisconnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  await disableProjectFlow(ctx.ui, deps, ctx.cwd || process.cwd());
}

async function handleTgUnbindCwd(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  await unbindProjectFlow(ctx.ui, deps, ctx.cwd || process.cwd(), true);
}

async function handleTgList(
  _args: string,
  ctx: any,
  _deps: TelegramCommandDeps,
): Promise<void> {
  await showProjectBindingFlow(ctx.ui, ctx.cwd || process.cwd());
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerTelegramCommands(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
): void {
  // ── Bot CRUD ──────────────────────────────────────────────────────────
  registry.registerCommand("tg-bot-add", {
    description: "Add a Telegram bot to the registry",
    handler: (args, ctx) => handleTgBotAdd(args, ctx, deps),
  });

  registry.registerCommand("tg-bot-list", {
    description: "List registered Telegram bots",
    handler: (args, ctx) => handleTgBotList(args, ctx, deps),
  });

  registry.registerCommand("tg-bot-update", {
    description: "Update a registered Telegram bot (token, name, etc.)",
    handler: (args, ctx) => handleTgBotUpdate(args, ctx, deps),
  });

  registry.registerCommand("tg-bot-remove", {
    description: "Remove a Telegram bot from the registry",
    handler: (args, ctx) => handleTgBotRemove(args, ctx, deps),
  });

  registry.registerCommand("tg-bot-default", {
    description: "Set the default Telegram bot",
    handler: (args, ctx) => handleTgBotDefault(args, ctx, deps),
  });

  // ── Project binding ──────────────────────────────────────────────────
  registry.registerCommand("tg-bind-cwd", {
    description: "Bind current project to a registered Telegram bot",
    handler: (args, ctx) => handleTgBindCwd(args, ctx, deps),
  });

  registry.registerCommand("tg-cwd-connect", {
    description: "Enable the Telegram bot for the current project",
    handler: (args, ctx) => handleTgCwdConnect(args, ctx, deps),
  });

  registry.registerCommand("tg-cwd-disconnect", {
    description: "Disable the Telegram bot for the current project",
    handler: (args, ctx) => handleTgCwdDisconnect(args, ctx, deps),
  });

  registry.registerCommand("tg-unbind-cwd", {
    description: "Remove current project Telegram bot binding",
    handler: (args, ctx) => handleTgUnbindCwd(args, ctx, deps),
  });

  registry.registerCommand("tg-list", {
    description: "Show current project binding and default bot",
    handler: (args, ctx) => handleTgList(args, ctx, deps),
  });
}