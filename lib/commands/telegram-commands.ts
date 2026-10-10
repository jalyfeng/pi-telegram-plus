import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addBot, bindProjectTelegram, findBotByIdOrName, readBotRegistry, removeBot, setDefaultBot, unbindProjectTelegram, updateBot, writeProjectBinding, readProjectBinding } from "../config.ts";
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

// ── Bot CRUD handlers ─────────────────────────────────────────────────────

async function handleTgBotAdd(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  const name = await ui.input("Bot name (unique label, e.g. 'work-bot')");
  if (!name) return;
  const token = await (ui.inputSecret?.("Telegram bot token (from @BotFather)") ?? ui.input("Telegram bot token (from @BotFather)"));
  if (!token) return;
  const registry = await readBotRegistry();
  // Check name uniqueness.
  if (registry.bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    ctx.ui.notify(`A bot named "${escapeHtml(name)}" already exists. Choose a different name.`, "error");
    return;
  }
  const apiBase = deps.getConfig().apiBase;
  const botUsername = await getTelegramBotUsername(token, apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-add"));
  // New bot has no authorized user yet — generate a one-time pairing code.
  const pairingCode = createTelegramPairingCode();
  const bot: BotRecord = {
    id: randomUUID(),
    name,
    token,
    ...(botUsername === undefined ? {} : { botUsername }),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
  };
  const updatedRegistry = await addBot(bot);
  const isDefault = updatedRegistry.defaultBotId === bot.id;
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ctx.ui.notify(
    `Bot added: ${escapeHtml(name)}${botUsername ? ` (@${botUsername})` : ""}${isDefault ? " — set as default" : ""}\n${formatPairingInstructions({ ...bot, botToken: token } as TelegramConfig)}`,
    "info",
  );
}

async function handleTgBotList(
  _args: string,
  ctx: any,
  _deps: TelegramCommandDeps,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ctx.ui.notify("No bots registered. Use /tg-bot-add to add one.", "info");
    return;
  }
  const lines = registry.bots.map((bot) => {
    const defaultMarker = registry.defaultBotId === bot.id ? " ★ default" : "";
    const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
    const paired = bot.allowedUserId !== undefined ? `paired (user ${bot.allowedUserId})` : bot.pairingCode ? `pairing: ${bot.pairingCode}` : "not paired";
    return `- ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)}) · ${username} · ${paired}${defaultMarker}`;
  });
  ctx.ui.notify(`Registered bots:\n${lines.join("\n")}`, "info");
}

async function handleTgBotUpdate(
  args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
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
  const field = await ui.input("Field to update (token, name, allowedUserId, apiBase)");
  if (!field) return;
  const validFields = ["token", "name", "allowedUserId", "apiBase"];
  if (!validFields.includes(field)) {
    ctx.ui.notify(`Invalid field. Choose from: ${validFields.join(", ")}`, "error");
    return;
  }
  let value: string | undefined;
  if (field === "token") {
    value = await (ui.inputSecret?.("New token") ?? ui.input("New token"));
  } else {
    value = await ui.input(`New value for ${field}`);
  }
  if (!value) return;
  const updates: Partial<Omit<BotRecord, "id">> = {};
  if (field === "token") {
    updates.token = value;
    // Re-fetch botUsername for new token.
    const botUsername = await getTelegramBotUsername(value, bot.apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-update"));
    if (botUsername) updates.botUsername = botUsername;
  } else if (field === "name") {
    // Check name uniqueness.
    if (registry.bots.some((b) => b.id !== bot.id && b.name.toLowerCase() === value!.toLowerCase())) {
      ctx.ui.notify(`A bot named "${escapeHtml(value)}" already exists.`, "error");
      return;
    }
    updates.name = value;
  } else if (field === "allowedUserId") {
    const userId = Number(value);
    if (!Number.isInteger(userId)) {
      ctx.ui.notify(`Invalid allowedUserId: must be an integer.`, "error");
      return;
    }
    updates.allowedUserId = userId;
  } else if (field === "apiBase") {
    updates.apiBase = value;
  }
  await updateBot(bot.id, updates);
  // If the current resolved bot is the one being updated, reload config.
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    const { readResolvedTelegramConfig } = await import("../config.ts");
    deps.switchResolvedConfig(await readResolvedTelegramConfig(ctx.cwd || process.cwd()));
    await deps.syncTelegramCommands();
    deps.refreshStatus();
  }
  ctx.ui.notify(`Bot updated: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})`, "info");
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
  const wasDefault = registry.defaultBotId === bot.id;
  await removeBot(bot.id);
  if (wasDefault) {
    ctx.ui.notify(`Warning: removed bot was the default. ${registry.bots.length > 1 ? "A remaining bot was promoted." : "No default bot is set."}`, "warning");
  }
  ctx.ui.notify(
    `Bot removed: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})\nAny project .pi/telegram.json referencing this bot will lose its binding.`,
    "warning",
  );
  // If current resolved bot was the removed one, reload.
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    const { readResolvedTelegramConfig } = await import("../config.ts");
    deps.switchResolvedConfig(await readResolvedTelegramConfig(ctx.cwd || process.cwd()));
    await deps.getPolling().stop();
    deps.refreshStatus();
  }
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
  await setDefaultBot(bot.id);
  ctx.ui.notify(`Default bot set to: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})`, "info");
}

// ── Project binding handlers ──────────────────────────────────────────────

async function handleTgBindCwd(
  args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ctx.ui.notify("No bots registered. Use /tg-bot-add to add a bot first.", "error");
    return;
  }
  const query = args.trim();
  let bot: BotRecord | undefined;
  if (query) {
    bot = findBotByIdOrName(registry, query);
    if (!bot) {
      ctx.ui.notify(`Bot not found: ${escapeHtml(query)}. Use /tg-bot-list to see registered bots.`, "error");
      return;
    }
  } else {
    // Interactive selection.
    const choices = registry.bots.map((b) => {
      const marker = registry.defaultBotId === b.id ? " ★" : "";
      const username = b.botUsername ? `@${b.botUsername}` : "no username";
      return `${b.name}${marker} · ${username} · ${b.id.slice(0, 8)}`;
    });
    const selected = await ctx.ui.select("Select a bot to bind to this project", choices);
    if (!selected) return;
    bot = registry.bots[choices.indexOf(selected)];
  }
  if (!bot) return;

  // Optionally accept tool/thinking overrides via args after bot query.
  const workspacePath = resolve(ctx.cwd || process.cwd());
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await bindProjectTelegram(workspacePath, bot.id));
  // Ensure pairing code on the bot if needed.
  const config = ensureTelegramPairingCode(deps.getConfig());
  if (config !== deps.getConfig()) {
    // Pairing code is on the bot record, not project binding. Update the bot.
    await updateBot(bot.id, { ...(config.pairingCode !== undefined ? { pairingCode: config.pairingCode } : {}) });
  }
  deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.startStatusHeartbeat();
  deps.refreshStatus();
  ctx.ui.notify(
    `Project bound to bot: ${escapeHtml(bot.name)}${bot.botUsername ? ` (@${bot.botUsername})` : ""}\n${escapeHtml(workspacePath)}\n${formatPairingInstructions(config)}`,
    "info",
  );
}

async function handleTgCwdConnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ctx.ui.notify("No Telegram bot registered. Use /tg-bot-add first.", "error");
    return;
  }
  const workspacePath = resolve(ctx.cwd || process.cwd());
  const project = await readProjectBinding(workspacePath);
  if (project) {
    // Update enabled in existing binding.
    await writeProjectBinding(project.path, { ...project.binding, enabled: true });
  } else {
    // Create minimal binding with default bot.
    if (!registry.defaultBotId) {
      ctx.ui.notify("No default bot set. Use /tg-bot-default to set one, or /tg-bind-cwd <bot> to bind explicitly.", "error");
      return;
    }
    await writeProjectBinding(workspacePath, { botId: registry.defaultBotId, enabled: true });
  }
  deps.switchResolvedConfig(await import("../config.ts").then((m) => m.readResolvedTelegramConfig(workspacePath)));
  deps.setConfig({ ...deps.getConfig(), telegramEnabled: true });
  await deps.getPolling().stop();
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  ctx.ui.notify(`Telegram bot enabled for current project.`, "info");
}

async function handleTgCwdDisconnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const workspacePath = resolve(ctx.cwd || process.cwd());
  const project = await readProjectBinding(workspacePath);
  if (project) {
    await writeProjectBinding(project.path, { ...project.binding, enabled: false });
  } else {
    // No binding — just stop polling and mark disabled in-memory.
    deps.setConfig({ ...deps.getConfig(), telegramEnabled: false });
  }
  deps.switchResolvedConfig(await import("../config.ts").then((m) => m.readResolvedTelegramConfig(workspacePath)));
  await deps.getPolling().stop();
  deps.clearStatusError();
  deps.refreshStatus();
  ctx.ui.notify(`Telegram bot disabled for current project.`, "info");
}

async function handleTgUnbindCwd(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const workspacePath = resolve(ctx.cwd || process.cwd());
  const project = await readProjectBinding(workspacePath);
  if (!project) {
    ctx.ui.notify("Current project has no Telegram binding. It is using the default bot (if any).", "info");
    return;
  }
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await unbindProjectTelegram(workspacePath));
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ctx.ui.notify(`Removed Telegram project binding:\n${escapeHtml(project.path)}\nProject now uses the default bot (if any).`, "info");
}

async function handleTgList(
  _args: string,
  ctx: any,
  _deps: TelegramCommandDeps,
): Promise<void> {
  const registry = await readBotRegistry();
  const workspacePath = resolve(ctx.cwd || process.cwd());
  const project = await readProjectBinding(workspacePath);
  const lines: string[] = [];

  // Current project binding.
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

  // Default bot.
  const defaultBot = registry.defaultBotId ? findBotByIdOrName(registry, registry.defaultBotId) : undefined;
  lines.push("");
  lines.push(`Default bot: ${defaultBot ? escapeHtml(defaultBot.name) : "(none set)"}`);

  ctx.ui.notify(lines.join("\n"), "info");
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