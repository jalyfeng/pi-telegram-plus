import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramAttachmentTool } from "./lib/attachments.ts";
import { readResolvedTelegramConfig, writeResolvedTelegramConfig, getAgentDir } from "./lib/config.ts";
import { createTelegramController, type TelegramCommandHandler } from "./lib/controller.ts";
import { createHeartbeat } from "./lib/heartbeat.ts";
import { registerTelegramRenderer } from "./lib/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/session-capture.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramBotUsername, getTelegramFile } from "./lib/telegram-api.ts";
import { createTelegramUiRuntime } from "./lib/telegram-ui.ts";
import { formatTelegramStatusLine, clearTelegramStatus, TELEGRAM_STATUS_KEY } from "./lib/status.ts";
import { createTelegramPollingRuntime } from "./lib/polling.ts";
import { initLogger, log, type LogLevel } from "./lib/logger.ts";
import { authorizeTelegramUser, ensureTelegramPairingCode, formatPairingInstructions } from "./lib/pairing.ts";
import { getCurrentTelegramTurn } from "./lib/turn-context.ts";

import { registerAllCommands } from "./lib/commands/register.ts";
import { registerTelegramCommands } from "./lib/commands/telegram-commands.ts";
import { syncTelegramCommands } from "./lib/menu-commands.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTurn } from "./lib/types.ts";

const indexLog = log.child("index");

type TelegramPlusRuntimeState = {
  dispose?: () => void;
};

const TELEGRAM_PLUS_RUNTIME_STATE = Symbol.for("pi-telegram-plus.runtime-state");

function getTelegramPlusRuntimeState(): TelegramPlusRuntimeState {
  const g = globalThis as typeof globalThis & Record<symbol, TelegramPlusRuntimeState | undefined>;
  g[TELEGRAM_PLUS_RUNTIME_STATE] ??= {};
  return g[TELEGRAM_PLUS_RUNTIME_STATE];
}

export default function piTelegramPlus(pi: ExtensionAPI): void {
  installAgentSessionCapture();
  // Initialize file logging first, before any subsystem can emit. Log directory
  // lives under the pi agent cache dir alongside tg.json; level is overridable
  // via PI_TELEGRAM_PLUS_LOG_LEVEL (debug/info/warn/error). See lib/logger.ts.
  const envLevel = process.env.PI_TELEGRAM_PLUS_LOG_LEVEL?.toLowerCase();
  const level: LogLevel = (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error")
    ? envLevel
    : "info";
  initLogger({ dir: join(getAgentDir(), "logs"), level });
  const runtimeState = getTelegramPlusRuntimeState();
  runtimeState.dispose?.();

  let config: TelegramConfig = {};
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  const activeTurnKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  // Per chat/thread active turns: prevents interleaving in one Telegram target
  // while allowing different topics in the same supergroup to stay isolated.
  const activeTurns = new Map<string, TelegramTurn>();
  let lastStatusError: string | undefined;

  const setConfig = (nextConfig: TelegramConfig) => {
    config = nextConfig;
    if (resolvedConfig) resolvedConfig.config = nextConfig;
    refreshStatus();
  };

  const currentSessionCwd = (): string => {
    const session = getActiveSession();
    return session?.extensionRunner?.createCommandContext?.().cwd ?? process.cwd();
  };

  const sanitizeIncomingFileName = (value: string): string => {
    const trimmed = value.trim().replace(/\.[^./\\]+$/, "");
    const sanitized = trimmed
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_");
    const compact = sanitized.replace(/^\.+/, "").replace(/\.+$/, "");
    return compact.slice(0, 120) || "attachment";
  };

  const inferIncomingExtension = (fileName: string | undefined, filePath: string | undefined): string => {
    const source = filePath || fileName;
    if (!source) return ".bin";
    const extension = extname(source).toLowerCase();
    return extension || ".bin";
  };

  const buildIncomingAttachmentPath = (fileId: string, fileName: string | undefined, filePath: string): string => {
    const ext = inferIncomingExtension(fileName, filePath);
    const base = fileName
      ? sanitizeIncomingFileName(fileName)
      : sanitizeIncomingFileName(filePath || "telegram-file");
    const safeFileId = fileId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(currentSessionCwd(), `${Date.now()}-${safeFileId.slice(0, 18)}-${base}${ext}`);
  };

  const persistCurrentConfig = async (nextConfig = config): Promise<void> => {
    if (!resolvedConfig) resolvedConfig = await readResolvedTelegramConfig(currentSessionCwd());
    resolvedConfig = await writeResolvedTelegramConfig(resolvedConfig, nextConfig);
    config = resolvedConfig.config;
  };

  const switchResolvedConfig = (next: ResolvedTelegramConfig) => {
    resolvedConfig = next;
    config = next.config;
    refreshStatus();
  };

  const isTelegramEnabled = (): boolean => {
    if (config.telegramEnabled !== undefined) return config.telegramEnabled;
    // Default: workspace binding implies intent to use; global requires explicit enable.
    return resolvedConfig?.scope === "workspace";
  };

  const transport = createTelegramTransport(() => config);
  const ui = createTelegramUiRuntime({
    getSession: getActiveSession,
    transport,
  });

  const getCurrentActiveTurn = (): TelegramTurn | undefined => getCurrentTelegramTurn();

  const heartbeat = createHeartbeat({
    getConfig: () => config,
    getActiveTurns: () => [...activeTurns.values()],
    sendChatAction: (chatId, action, messageThreadId) => transport.sendChatAction(chatId, action, messageThreadId),
    ensurePollingStarted: () => { if (config.botToken && isTelegramEnabled() && !polling.isActive()) polling.start(); },
  });

  const telegramCommands = new Map<string, TelegramCommandHandler>();
  const sessionDeps = { getSession: getActiveSession };
  const sessionNameDeps = {
    ...sessionDeps,
    setSessionName: (name: string) => { const s = getActiveSession(); if (s) pi.setSessionName(name); },
    getSessionName: () => pi.getSessionName(),
  };
  const tgConfigDeps = {
    ...sessionDeps,
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
  };

  // Custom pi-telegram-plus commands that should also appear in the TUI slash menu.
  // Pi built-in commands (model, session, new, etc.) are already registered by pi core.
  const TUI_VISIBLE_COMMANDS = new Set([
    // tg-* commands
    "tg-global-setup", "tg-global-connect", "tg-global-disconnect", "tg-config",
    "tg-bind-cwd", "tg-unbind-cwd", "tg-cwd-connect", "tg-cwd-disconnect", "tg-list",
    // other pi-telegram-plus custom commands (TUI-only command list excludes /import, which is now
    // a built-in pi command; keep Telegram handler registration only.
    "cwd", "cd", "status", "thinking", "stop", "debug",
  ]);

  registerAllCommands({
    registerCommand: (name: string, options: { description?: string; handler: TelegramCommandHandler }) => {
      telegramCommands.set(name, options.handler);
      if (TUI_VISIBLE_COMMANDS.has(name) && options.description) {
        pi.registerCommand(name, { description: options.description, handler: options.handler });
      }
    },
  }, sessionDeps, sessionNameDeps, tgConfigDeps, {
    getTransport: () => transport,
    getActiveChatId: () => config.activeChatId,
    getActiveTurn: getCurrentActiveTurn,
  });

  registerTelegramCommands({
    registerCommand: (name: string, options: { description?: string; handler: TelegramCommandHandler }) => {
      telegramCommands.set(name, options.handler);
      if (options.description) {
        pi.registerCommand(name, { description: options.description, handler: options.handler });
      }
    },
  }, {
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
    getResolvedConfig: () => resolvedConfig,
    switchResolvedConfig,
    isTelegramEnabled,
    transport,
    getPolling: () => polling,
    refreshStatus,
    syncTelegramCommands: () => syncTelegramCommands(config.botToken, pi),
    startStatusHeartbeat: () => heartbeat.startStatusHeartbeat(refreshStatus),
    clearStatusError: () => { lastStatusError = undefined; },
  });

  registerTelegramAttachmentTool(pi, {
    getActiveTurn: getCurrentActiveTurn,
    getDefaultChatId: () => activeTurns.size === 0 ? config.activeChatId : undefined,
    transport,
  });

  registerTelegramRenderer(pi, {
    getConfig: () => config,
    transport,
    getActiveTurn: (chatId?: number, messageThreadId?: number) => {
      if (chatId !== undefined) return activeTurns.get(activeTurnKey(chatId, messageThreadId));
      return getCurrentActiveTurn();
    },
    hasActiveTurns: () => activeTurns.size > 0,
  });

  const controller = createTelegramController({
    getSession: getActiveSession,
    transport,
    ui,
    authorizeUser: async (userId, text) => {
      const decision = authorizeTelegramUser(config, userId, text, config.botUsername);
      if (!decision.authorized) return false;
      if (decision.config !== config) {
        config = decision.config;
        await persistCurrentConfig(config);
        refreshStatus();
      }
      return decision.paired ? "paired" : true;
    },
    telegramCommands,
    saveIncomingTelegramAttachment: async (fileId, fileName, kind) => {
      const token = config.botToken;
      if (!token) {
        throw new Error("Telegram bot token is not configured");
      }
      const fileInfo = await getTelegramFile(token, fileId);
      const data = await downloadTelegramFile(token, fileInfo.file_path);
      await mkdir(currentSessionCwd(), { recursive: true });
      const candidateName = buildIncomingAttachmentPath(fileId, fileName || kind, fileInfo.file_path);
      const outputPath = candidateName;
      await writeFile(outputPath, data);
      return outputPath;
    },
    getActiveTurn: (chatId: number, messageThreadId?: number) => activeTurns.get(activeTurnKey(chatId, messageThreadId)),
    beginTelegramTurn: (chatId, replaceMessageId, messageThreadId, sourceMessageId) => {
      const key = activeTurnKey(chatId, messageThreadId);
      if (activeTurns.has(key)) return undefined; // reject if this chat/thread is busy
      const turn: TelegramTurn = { chatId, messageThreadId, sourceMessageId, replaceMessageId, queuedAttachments: [] };
      activeTurns.set(key, turn);
      refreshStatus();
      return turn;
    },
    endTelegramTurn: (chatId, turn) => {
      const key = activeTurnKey(chatId, turn.messageThreadId);
      if (activeTurns.get(key) === turn) activeTurns.delete(key);
      refreshStatus();
    },
    setActiveChatId: async (chatId) => {
      if (config.activeChatId === chatId) return;
      config = { ...config, activeChatId: chatId };
      await persistCurrentConfig(config);
      refreshStatus();
    },
    getBotUsername: () => config.botUsername,
    getMessageMode: () => config.messageMode ?? "steer",
  });

  const polling = createTelegramPollingRuntime({
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
    reloadConfig: async () => switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd())),
    handleUpdate: async (update) => {
      refreshStatus();
      if (update.callback_query) await controller.handleCallbackQuery(update.callback_query);
      if (update.message) await controller.handleMessage(update.message);
      lastStatusError = undefined;
      refreshStatus();
    },
    onSuccess: () => {
      if (lastStatusError !== undefined) { lastStatusError = undefined; refreshStatus(); }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      lastStatusError = message;
      refreshStatus(message);
      if (message.startsWith("Telegram polling skipped:")) {
        getActiveSession()?.extensionRunner.getUIContext().notify(message, "warning");
        return;
      }
      const turn = getCurrentActiveTurn();
      const chatId = turn?.chatId ?? config.activeChatId;
      if (chatId !== undefined && config.botToken) {
        transport.sendText(chatId, `<b>error</b>\nTelegram polling failed`, turn?.messageThreadId, turn?.sourceMessageId).catch(log.child("polling").swallow("error", "sendText polling-failure notice failed", { chatId, messageThreadId: turn?.messageThreadId }));
      } else {
        getActiveSession()?.extensionRunner.getUIContext().notify(`Telegram polling failed: ${message}`, "error");
      }
    },
  });

  function buildStatusState(error?: string): Parameters<typeof formatTelegramStatusLine>[1] {
    return {
      hasBotToken: !!config.botToken,
      pollingActive: polling.isActive(),
      paired: config.allowedUserId !== undefined,
      processing: activeTurns.size > 0,
      error,
      botUsername: config.botUsername,
    };
  }

  function refreshStatus(error = lastStatusError): void {
    const state = buildStatusState(error);
    const session = getActiveSession();
    const ctx = session?.extensionRunner?.createCommandContext?.();
    if (ctx?.ui?.setStatus) {
      ctx.ui.setStatus(TELEGRAM_STATUS_KEY, formatTelegramStatusLine(ctx.ui.theme, state));
    }
    heartbeat.refreshStatus(state);
  }

  function clearStatus(): void {
    heartbeat.stopTypingOnly();
    const session = getActiveSession();
    const ctx = session?.extensionRunner?.createCommandContext?.();
    if (ctx?.ui?.setStatus) clearTelegramStatus(ctx);
  }

  function disposeRuntime(): void {
    void polling.stop();
    heartbeat.dispose();
    activeTurns.clear();
    ui.dispose();
    clearStatus();
  }

  runtimeState.dispose = disposeRuntime;

  pi.on("session_start", async () => {
    try {
      switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd()));
    } catch (error) {
      switchResolvedConfig({ store: { version: 2, global: {}, workspaces: [] }, scope: "global", config: {} });
      getActiveSession()?.extensionRunner.getUIContext().notify(
        `Telegram config is not v2 yet. Run /tg-global-setup to recreate it. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    if (config.botToken && !config.botUsername) {
      try {
        const botUsername = await getTelegramBotUsername(config.botToken);
        if (botUsername) {
          config = { ...config, botUsername };
          await persistCurrentConfig(config);
        }
      } catch (err) { indexLog.debug("resolve botUsername on startup failed (non-critical)", { err }); }
    }
    if (config.botToken) {
      const pairedConfig = ensureTelegramPairingCode(config);
      if (pairedConfig !== config) {
        config = pairedConfig;
        await persistCurrentConfig(config);
      }
      if (config.allowedUserId === undefined) {
        getActiveSession()?.extensionRunner.getUIContext().notify(formatPairingInstructions(config), "warning");
      }
    }
    if (config.botToken && isTelegramEnabled() && !polling.isActive()) polling.start();
    try { await syncTelegramCommands(config.botToken, pi); } catch (err) { indexLog.debug("syncTelegramCommands on startup failed (non-critical)", { err }); }
    lastStatusError = undefined;
    heartbeat.startStatusHeartbeat(refreshStatus);
    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    disposeRuntime();
    if (runtimeState.dispose === disposeRuntime) runtimeState.dispose = undefined;
  });
}