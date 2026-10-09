import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActiveTelegramTransport } from "./lib/active-transport.ts";
import { registerTelegramAttachmentTool } from "./lib/attachments.ts";
import { enableConfiguredTelegramOnStartup, readResolvedTelegramConfig, writeResolvedTelegramConfig, getAgentDir } from "./lib/config.ts";
import { createTelegramController, type TelegramCommandHandler } from "./lib/controller.ts";
import { escapeHtml } from "./lib/html.ts";
import { createHeartbeat } from "./lib/heartbeat.ts";
import { replayTelegramHistory, type TelegramHistoryEntry } from "./lib/history-replay.ts";
import { TelegramInstanceCoordinator, telegramTokenHash, type TelegramActiveInstance, type TelegramInstanceMetadata } from "./lib/instance-coordinator.ts";
import { registerTelegramRenderer } from "./lib/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/session-capture.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramBotUsername, getTelegramFile } from "./lib/telegram-api.ts";
import { createTelegramUiRuntime } from "./lib/telegram-ui.ts";
import { formatTelegramStatusLine, clearTelegramStatus, TELEGRAM_STATUS_KEY } from "./lib/status.ts";
import { installTelegramStatusAlignment } from "./lib/status-footer.ts";
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
  instanceId?: string;
  startedAt?: string;
  handledReplayByToken?: Record<string, number>;
  notifiedFailoverByToken?: Record<string, number>;
};

const TELEGRAM_PLUS_RUNTIME_STATE = Symbol.for("pi-telegram-plus.runtime-state");

function getTelegramPlusRuntimeState(): TelegramPlusRuntimeState {
  const g = globalThis as typeof globalThis & Record<symbol, TelegramPlusRuntimeState | undefined>;
  g[TELEGRAM_PLUS_RUNTIME_STATE] ??= {};
  const state = g[TELEGRAM_PLUS_RUNTIME_STATE];
  state.instanceId ??= randomUUID();
  state.startedAt ??= new Date().toISOString();
  state.handledReplayByToken ??= {};
  state.notifiedFailoverByToken ??= {};
  return state;
}

export default function piTelegramPlus(pi: ExtensionAPI): void {
  installAgentSessionCapture();
  installTelegramStatusAlignment();
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
  let coordinator: TelegramInstanceCoordinator | undefined;
  let coordinatorTimer: ReturnType<typeof setInterval> | undefined;
  let replayAbortController: AbortController | undefined;
  const pendingHandoffs = new Set<string>();
  let requestCoordinatorReconcile: () => void = () => undefined;
  let replayReady: Promise<void> = Promise.resolve();
  let releaseReplayGate: (() => void) | undefined;
  const activeTurnKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  // Per chat/thread active turns: prevents interleaving in one Telegram target
  // while allowing different topics in the same supergroup to stay isolated.
  const activeTurns = new Map<string, TelegramTurn>();
  let lastStatusError: string | undefined;

  const setConfig = (nextConfig: TelegramConfig) => {
    const routingChanged = config.botToken !== nextConfig.botToken
      || config.telegramEnabled !== nextConfig.telegramEnabled;
    config = nextConfig;
    if (resolvedConfig) resolvedConfig.config = nextConfig;
    refreshStatus();
    if (routingChanged) {
      replayAbortController?.abort();
      requestCoordinatorReconcile();
    }
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
    const routingChanged = config.botToken !== next.config.botToken
      || config.telegramEnabled !== next.config.telegramEnabled;
    resolvedConfig = next;
    config = next.config;
    refreshStatus();
    if (routingChanged) {
      replayAbortController?.abort();
      requestCoordinatorReconcile();
    }
  };

  const isTelegramEnabled = (): boolean => {
    if (config.telegramEnabled !== undefined) return config.telegramEnabled;
    // Default: workspace binding implies intent to use; global requires explicit enable.
    return resolvedConfig?.scope === "workspace";
  };

  const rawTransport = createTelegramTransport(() => config);
  const getActiveSendLease = (): string | undefined => {
    const token = config.botToken;
    const active = coordinator?.getActive();
    if (!token
      || !coordinator
      || coordinator.tokenHash !== telegramTokenHash(token)
      || !coordinator.isActive()
      || pendingHandoffs.size > 0
      || !active
      || active.replay) {
      return undefined;
    }
    return `${coordinator.tokenHash}:${active.generation}`;
  };
  const isActiveInstance = () => getActiveSendLease() !== undefined;
  const activeBaseTransport = createTelegramTransport(() => config, {
    getSendLease: getActiveSendLease,
    shouldSend: (lease) => lease !== undefined && lease === getActiveSendLease(),
  });
  const transport = createActiveTelegramTransport(activeBaseTransport, {
    isActive: isActiveInstance,
    getLease: getActiveSendLease,
    waitUntilReady: () => replayReady,
  });
  const ui = createTelegramUiRuntime({
    getSession: getActiveSession,
    transport,
  });

  const getCurrentActiveTurn = (): TelegramTurn | undefined => getCurrentTelegramTurn();

  const heartbeat = createHeartbeat({
    getConfig: () => config,
    getActiveTurns: () => [...activeTurns.values()],
    sendChatAction: (chatId, action, messageThreadId) => transport.sendChatAction(chatId, action, messageThreadId),
    ensurePollingStarted: () => {
      if (config.botToken && isTelegramEnabled() && isActiveInstance() && !polling.isActive()) polling.start();
    },
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
    isActive: isActiveInstance,
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

  const maxConfiguredUpdateId = (token: string): number | undefined => {
    if (!resolvedConfig) return config.botToken === token ? config.lastUpdateId : undefined;
    const configs = [
      resolvedConfig.store.global,
      ...(resolvedConfig.store.workspaces ?? []).map((workspace) => workspace.config),
    ];
    const offsets = configs
      .filter((candidate) => candidate?.botToken === token && typeof candidate.lastUpdateId === "number")
      .map((candidate) => candidate!.lastUpdateId!);
    return offsets.length > 0 ? Math.max(...offsets) : undefined;
  };

  const refreshSharedCursor = async (candidate = coordinator): Promise<void> => {
    const token = config.botToken;
    if (!candidate || !token || candidate.tokenHash !== telegramTokenHash(token)) return;
    const cursor = await candidate.syncCursor(maxConfiguredUpdateId(token));
    if (cursor !== undefined && cursor !== config.lastUpdateId) {
      config = { ...config, lastUpdateId: cursor };
      if (resolvedConfig) resolvedConfig.config = config;
    }
  };

  const polling = createTelegramPollingRuntime({
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
    persistUpdate: async (nextConfig, update) => {
      await persistCurrentConfig(nextConfig);
      const currentCoordinator = coordinator;
      if (currentCoordinator && nextConfig.botToken && currentCoordinator.tokenHash === telegramTokenHash(nextConfig.botToken)) {
        await currentCoordinator.persistCursor(update.update_id);
      }
    },
    reloadConfig: async () => {
      switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd()));
      await refreshSharedCursor();
    },
    shouldPoll: isActiveInstance,
    shouldProcess: isActiveInstance,
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

  let replayInFlight: { tokenHash: string; generation: number } | undefined;
  let reconcileTail: Promise<void> = Promise.resolve();

  const openReplayGate = (): (() => void) => {
    releaseReplayGate?.();
    let resolveGate: () => void = () => undefined;
    let released = false;
    replayReady = new Promise<void>((resolveGatePromise) => {
      resolveGate = resolveGatePromise;
    });
    const close = () => {
      if (released) return;
      released = true;
      resolveGate();
      if (releaseReplayGate === close) releaseReplayGate = undefined;
    };
    releaseReplayGate = close;
    return close;
  };

  const buildInstanceHeartbeat = (): Omit<TelegramInstanceMetadata, "id" | "pid" | "startedAt" | "heartbeatAt"> => {
    const session = getActiveSession();
    const model = session?.model;
    return {
      cwd: currentSessionCwd(),
      sessionId: session?.sessionId,
      sessionName: session?.sessionName,
      model: model ? `${model.provider}/${model.id}` : undefined,
      busy: session ? !session.isIdle : false,
    };
  };

  const startHistoryReplay = (
    active: TelegramActiveInstance,
    replayCoordinator: TelegramInstanceCoordinator,
    metadata: ReturnType<typeof buildInstanceHeartbeat>,
  ): void => {
    if (!active.replay || replayInFlight) return;
    const handledByToken = runtimeState.handledReplayByToken!;
    if ((handledByToken[replayCoordinator.tokenHash] ?? 0) >= active.generation) return;
    replayInFlight = { tokenHash: replayCoordinator.tokenHash, generation: active.generation };
    const closeReplayGate = openReplayGate();
    const replayController = new AbortController();
    replayAbortController = replayController;
    const replayConfig = { ...config };
    const session = getActiveSession();
    const entries = (session?.sessionManager.getBranch() ?? []) as TelegramHistoryEntry[];
    const replayTarget = active.replay;
    const canContinue = () => coordinator === replayCoordinator
      && config.botToken === replayConfig.botToken
      && !!config.botToken
      && replayCoordinator.tokenHash === telegramTokenHash(config.botToken)
      && isTelegramEnabled()
      && replayCoordinator.isActive()
      && replayCoordinator.getActive()?.generation === active.generation;
    const replayLease = `${replayCoordinator.tokenHash}:${active.generation}`;
    const replayTransport = createTelegramTransport(() => replayConfig, {
      getAbortSignal: () => replayController.signal,
      getSendLease: () => replayLease,
      shouldSend: (lease) => lease === replayLease && canContinue(),
    });

    void (async () => {
      let shouldCompleteReplay = false;
      try {
        const result = await replayTelegramHistory({
          entries,
          config: replayConfig,
          transport: replayTransport,
          target: replayTarget,
          instance: {
            cwd: metadata.cwd,
            sessionId: metadata.sessionId,
            sessionName: metadata.sessionName,
            model: metadata.model,
            instanceId: replayCoordinator.instanceId,
          },
          canContinue,
        });
        if (!result.aborted) {
          handledByToken[replayCoordinator.tokenHash] = active.generation;
          shouldCompleteReplay = true;
        }
      } catch (error) {
        if ((error instanceof Error && error.name === "TelegramSendSuppressedError") || !canContinue()) {
          indexLog.debug("Telegram history replay interrupted by instance switch or reload", { generation: active.generation });
        } else {
          handledByToken[replayCoordinator.tokenHash] = active.generation;
          shouldCompleteReplay = true;
          indexLog.warn("Telegram history replay failed", { generation: active.generation, error });
          await replayTransport.sendText(
            replayTarget.chatId,
            `⚠️ <b>History replay failed.</b>\n${escapeHtml(error instanceof Error ? error.message : String(error))}`,
            replayTarget.messageThreadId,
          ).catch(indexLog.swallow("warn", "send history replay failure notice failed", { chatId: replayTarget.chatId }));
        }
      } finally {
        if (shouldCompleteReplay) {
          await replayCoordinator.completeReplay(active.generation).catch(indexLog.swallow("warn", "complete history replay state failed", { generation: active.generation }));
        }
        if (replayInFlight?.tokenHash === replayCoordinator.tokenHash
          && replayInFlight.generation === active.generation) {
          replayInFlight = undefined;
        }
        if (replayAbortController === replayController) replayAbortController = undefined;
        closeReplayGate();
        if (shouldCompleteReplay && coordinator === replayCoordinator && replayCoordinator.isActive() && isTelegramEnabled()) {
          polling.start();
        } else if (!shouldCompleteReplay && coordinator === replayCoordinator) {
          requestCoordinatorReconcile();
        }
      }
    })();
  };

  const reconcileCoordinator = async (): Promise<void> => {
    if (disposed) return;
    const token = config.botToken;
    if (!token || !isTelegramEnabled()) {
      replayAbortController?.abort();
      coordinator = undefined;
      await polling.stop();
      refreshStatus();
      return;
    }

    const tokenHash = telegramTokenHash(token);
    if (!coordinator || coordinator.tokenHash !== tokenHash) {
      replayAbortController?.abort();
      coordinator = new TelegramInstanceCoordinator({
        token,
        instanceId: runtimeState.instanceId!,
        startedAt: runtimeState.startedAt!,
      });
    }
    const currentCoordinator = coordinator;
    await refreshSharedCursor(currentCoordinator);
    const metadata = buildInstanceHeartbeat();
    const snapshot = await currentCoordinator.reconcile(metadata);
    if (disposed || coordinator !== currentCoordinator || config.botToken !== token || !isTelegramEnabled()) return;
    if (pendingHandoffs.size > 0) {
      await polling.stop();
      refreshStatus();
      return;
    }

    if (!currentCoordinator.isActive()) {
      replayAbortController?.abort();
      await polling.stop();
      refreshStatus();
      return;
    }

    if (snapshot.active.reason === "failover") {
      const notifiedByToken = runtimeState.notifiedFailoverByToken!;
      if ((notifiedByToken[tokenHash] ?? 0) < snapshot.active.generation && config.activeChatId !== undefined) {
        const chatId = config.activeChatId;
        const previousGeneration = notifiedByToken[tokenHash] ?? 0;
        notifiedByToken[tokenHash] = snapshot.active.generation;
        void transport.sendText(
          chatId,
          `⚠️ <b>Telegram instance failover</b>\nThe previous active pi instance went offline. This instance is now active.`,
        ).then((sent) => {
          if (sent.length === 0 && notifiedByToken[tokenHash] === snapshot.active.generation) {
            notifiedByToken[tokenHash] = previousGeneration;
          }
        }).catch((error) => {
          if (notifiedByToken[tokenHash] === snapshot.active.generation) {
            notifiedByToken[tokenHash] = previousGeneration;
          }
          indexLog.warn("send instance failover notice failed", { chatId, error });
        });
      }
    }

    if (snapshot.active.replay) {
      const handled = runtimeState.handledReplayByToken![tokenHash] ?? 0;
      if (handled < snapshot.active.generation) {
        startHistoryReplay(snapshot.active, currentCoordinator, metadata);
        refreshStatus();
        return;
      }
      if (replayInFlight?.tokenHash === tokenHash && replayInFlight.generation === snapshot.active.generation) {
        refreshStatus();
        return;
      }
      await currentCoordinator.completeReplay(snapshot.active.generation);
    }

    if (!polling.isActive()) polling.start();
    refreshStatus();
  };

  requestCoordinatorReconcile = () => {
    reconcileTail = reconcileTail
      .then(reconcileCoordinator)
      .catch((error) => {
        lastStatusError = error instanceof Error ? error.message : String(error);
        indexLog.warn("Telegram instance reconciliation failed", { error });
        refreshStatus(lastStatusError);
      });
  };

  coordinatorTimer = setInterval(requestCoordinatorReconcile, 2_000);

  const formatInstanceChoice = (instance: TelegramInstanceMetadata, activeId: string): string => {
    const marker = instance.id === activeId ? "✓" : " ";
    const project = (basename(instance.cwd) || instance.cwd).slice(0, 28);
    const session = (instance.sessionName || instance.sessionId?.slice(0, 8) || "session").slice(0, 24);
    const model = (instance.model || "no-model").slice(0, 36);
    return `${marker} ${project} · ${session} · ${model} · ${instance.id.slice(0, 8)}`;
  };

  telegramCommands.set("tg-switch", async (args, ctx) => {
    const currentCoordinator = coordinator;
    if (!currentCoordinator || !currentCoordinator.isActive()) {
      ctx.ui.notify("This pi instance is not the active Telegram instance.", "error");
      return;
    }
    const instances = await currentCoordinator.listInstances();
    const active = currentCoordinator.getActive();
    if (!active || instances.length === 0) {
      ctx.ui.notify("No live Telegram instances are available.", "error");
      return;
    }

    let target: TelegramInstanceMetadata | undefined;
    const query = args.trim();
    if (!query) {
      const choices = instances.map((instance) => formatInstanceChoice(instance, active.instanceId));
      const selected = await ctx.ui.select("Switch Telegram pi instance", choices);
      if (!selected) return;
      target = instances[choices.indexOf(selected)];
    } else if (query.toLowerCase() === "current") {
      target = instances.find((instance) => instance.id === active.instanceId);
    } else {
      const matches = instances.filter((instance) => instance.id === query || instance.id.startsWith(query));
      if (matches.length > 1) {
        ctx.ui.notify(`Instance id is ambiguous: ${query}`, "error");
        return;
      }
      target = matches[0];
    }
    if (!target) {
      ctx.ui.notify(`Telegram instance not found: ${query || "selection"}`, "error");
      return;
    }

    const turn = getCurrentTelegramTurn();
    const chatId = turn?.chatId ?? config.activeChatId;
    if (chatId === undefined) {
      ctx.ui.notify("No active Telegram chat is available for history replay.", "error");
      return;
    }

    const handoffId = randomUUID();
    pendingHandoffs.add(handoffId);
    try {
      await polling.stop();
      await currentCoordinator.switchTo(
        target.id,
        {
          chatId,
          messageThreadId: turn?.messageThreadId,
          sourceMessageId: turn?.sourceMessageId,
        },
        { instanceId: active.instanceId, generation: active.generation },
      );
    } catch (error) {
      throw error;
    } finally {
      pendingHandoffs.delete(handoffId);
      requestCoordinatorReconcile();
      if (pendingHandoffs.size === 0
        && currentCoordinator.isActive()
        && !currentCoordinator.getActive()?.replay) {
        polling.start();
      }
    }
  });

  function buildStatusState(error?: string): Parameters<typeof formatTelegramStatusLine>[1] {
    const enabled = !!config.botToken && isTelegramEnabled();
    return {
      hasBotToken: !!config.botToken,
      pollingActive: polling.isActive(),
      paired: config.allowedUserId !== undefined,
      connected: enabled && coordinator?.getActive() !== undefined,
      current: enabled && (coordinator?.isActive() ?? false),
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

  let disposed = false;
  function disposeRuntime(): void {
    if (disposed) return;
    disposed = true;
    if (coordinatorTimer) clearInterval(coordinatorTimer);
    coordinatorTimer = undefined;
    requestCoordinatorReconcile = () => undefined;
    pendingHandoffs.clear();
    coordinator = undefined;
    replayAbortController?.abort();
    replayAbortController = undefined;
    releaseReplayGate?.();
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
      // A transient read failure (e.g. racing a concurrent instance's
      // config write) must not nuke the runtime config: keep the previous
      // resolved config so the bot keeps polling, and surface the REAL
      // error instead of the misleading "not v2" wording.
      indexLog.error("readTelegramConfigStore failed on session_start; keeping previous config", { err: error });
      if (!resolvedConfig) {
        switchResolvedConfig({ store: { version: 2, global: {}, workspaces: [] }, scope: "global", config: {} });
        getActiveSession()?.extensionRunner.getUIContext().notify(
          `Telegram config could not be loaded. Run /tg-global-setup to recreate it. ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } else {
        getActiveSession()?.extensionRunner.getUIContext().notify(
          `Telegram config could not be refreshed; keeping the previous configuration. ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    const startupConfig = enableConfiguredTelegramOnStartup(config);
    if (startupConfig !== config) {
      config = startupConfig;
      await persistCurrentConfig(config);
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
    requestCoordinatorReconcile();
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