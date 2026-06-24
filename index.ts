import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramAttachmentTool } from "./lib/attachments.ts";
import { readResolvedTelegramConfig, writeResolvedTelegramConfig } from "./lib/config.ts";
import { createTelegramController, type TelegramCommandHandler } from "./lib/controller.ts";
import { createHeartbeat } from "./lib/heartbeat.ts";
import { registerTelegramRenderer } from "./lib/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/session-capture.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramBotUsername, getTelegramFile } from "./lib/telegram-api.ts";
import { createTelegramUiRuntime } from "./lib/telegram-ui.ts";
import { formatTelegramStatusLine, clearTelegramStatus, TELEGRAM_STATUS_KEY } from "./lib/status.ts";
import { createTelegramPollingRuntime } from "./lib/polling.ts";
import { registerAllCommands } from "./lib/commands/register.ts";
import { registerTelegramCommands } from "./lib/commands/telegram-commands.ts";
import { syncTelegramCommands } from "./lib/menu-commands.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTurn } from "./lib/types.ts";

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
  const runtimeState = getTelegramPlusRuntimeState();
  runtimeState.dispose?.();

  let config: TelegramConfig = {};
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  // Per-chat active turns: prevents interleaving across chats and allows
  // beginTelegramTurn to reject when a chat is already busy.
  const activeTurns = new Map<number, TelegramTurn>();
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

  const heartbeat = createHeartbeat({
    getConfig: () => config,
    getActiveTurn: () => { for (const turn of activeTurns.values()) return turn; return undefined; },
    sendChatAction: (chatId, action) => transport.sendChatAction(chatId, action),
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
    getActiveTurn: () => { for (const turn of activeTurns.values()) return turn; return undefined; },
    getDefaultChatId: () => config.activeChatId,
    transport,
  });

  registerTelegramRenderer(pi, {
    getConfig: () => config,
    transport,
    getActiveTurn: (chatId?: number) => {
      if (chatId !== undefined) return activeTurns.get(chatId);
      for (const turn of activeTurns.values()) return turn;
      return undefined;
    },
  });

  const controller = createTelegramController({
    getSession: getActiveSession,
    transport,
    ui,
    authorizeUser: async (userId) => {
      if (userId === undefined) return false;
      if (config.allowedUserId === undefined) {
        config = { ...config, allowedUserId: userId };
        await persistCurrentConfig(config);
        refreshStatus();
      }
      return config.allowedUserId === userId;
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
      const outputPath = buildIncomingAttachmentPath(fileId, fileName || kind, fileInfo.file_path);
      await writeFile(outputPath, data);
      return outputPath;
    },
    getActiveTurn: (chatId: number) => activeTurns.get(chatId),
    beginTelegramTurn: (chatId, replaceMessageId) => {
      if (activeTurns.has(chatId)) return undefined;
      const turn: TelegramTurn = { chatId, replaceMessageId, queuedAttachments: [] };
      activeTurns.set(chatId, turn);
      refreshStatus();
      return turn;
    },
    endTelegramTurn: (chatId, turn) => {
      if (activeTurns.get(chatId) === turn) activeTurns.delete(chatId);
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
      const chatId = config.activeChatId;
      if (chatId !== undefined && config.botToken) {
        transport.sendText(chatId, `<b>error</b>\nTelegram polling failed`).catch(() => undefined);
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
      const level = config.tuiStatus ?? "full";
      const line = formatTelegramStatusLine(ctx.ui.theme, state, level);
      ctx.ui.setStatus(TELEGRAM_STATUS_KEY, line);
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
    for (const turn of activeTurns.values()) activeTurns.delete(turn.chatId);
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
      } catch { /* non-critical */ }
    }
    if (config.botToken && isTelegramEnabled() && !polling.isActive()) polling.start();
    try { await syncTelegramCommands(config.botToken, pi); } catch { /* non-critical */ }
    lastStatusError = undefined;
    heartbeat.startStatusHeartbeat(refreshStatus);
    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    disposeRuntime();
    if (runtimeState.dispose === disposeRuntime) runtimeState.dispose = undefined;
  });
}