import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { decodeUiCallback } from "./callback-protocol.ts";
import { parseLeadingCommand, normalizeLeadingCommand } from "./command-parser.ts";
import type {
  CapturedAgentSession,
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramMessageMode,
  TelegramPhotoSize,
  TelegramTransport,
  TelegramTurn,
} from "./types.ts";
import type { TelegramUiRuntime } from "./telegram-ui.ts";
import { log } from "./logger.ts";
import { commandErrorMessage, getRunnerMode, setRunnerUiContext, TELEGRAM_EXTENSION_MODE } from "./pi-compat.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "./turn-context.ts";

const ctrlLog = log.child("controller");

export type TelegramController = {
  handleMessage(message: TelegramMessage): Promise<void>;
  handleCallbackQuery(query: TelegramCallbackQuery): Promise<void>;
};

function getIncomingDocumentName(document?: TelegramDocument): string {
  if (!document) return "file";
  return document.file_name || `${document.file_id}`;
}

type IncomingMediaSummaryEntry = {
  type: string;
  fileId: string;
  fileName?: string;
};

function extractTelegramMediaEntries(message: TelegramMessage): IncomingMediaSummaryEntry[] {
  const entries: IncomingMediaSummaryEntry[] = [];
  if (message.photo && message.photo.length > 0) {
    const bestPhoto = [...message.photo].reduce<TelegramPhotoSize>((best, current) => {
      const bestSize = best.file_size ?? -1;
      const currentSize = current.file_size ?? -1;
      return currentSize > bestSize ? current : best;
    }, message.photo[0]);
    entries.push({ type: "photo", fileId: bestPhoto.file_id, fileName: undefined });
  }

  const documentAttachments: Array<{ type: string; document?: TelegramDocument }> = [];
  if (message.document) documentAttachments.push({ type: "document", document: message.document });
  if (message.video) documentAttachments.push({ type: "video", document: message.video });
  if (message.audio) documentAttachments.push({ type: "audio", document: message.audio });
  if (message.voice) documentAttachments.push({ type: "voice", document: message.voice });
  if (message.animation) documentAttachments.push({ type: "animation", document: message.animation });
  if (message.sticker) documentAttachments.push({ type: "sticker", document: message.sticker });
  for (const attachment of documentAttachments) {
    if (!attachment.document) continue;
    entries.push({
      type: attachment.type,
      fileId: attachment.document.file_id,
      fileName: attachment.document.file_name,
    });
  }

  return entries;
}

function buildTelegramIncomingMediaSummary(message: TelegramMessage, title = "[telegram attachment]"): string {
  const parts: string[] = [];
  if (message.photo && message.photo.length > 0) {
    parts.push(`- photo (${message.photo.length} photo frame(s))`);
  }
  const entries: Array<{ type: string; document?: TelegramDocument }> = [];
  if (message.document) entries.push({ type: "document", document: message.document });
  if (message.video) entries.push({ type: "video", document: message.video });
  if (message.audio) entries.push({ type: "audio", document: message.audio });
  if (message.voice) entries.push({ type: "voice", document: message.voice });
  if (message.animation) entries.push({ type: "animation", document: message.animation });
  if (message.sticker) entries.push({ type: "sticker", document: message.sticker });
  for (const attachment of entries) {
    if (!attachment.document) continue;
    parts.push(`- ${attachment.type}: ${getIncomingDocumentName(attachment.document)}`);
  }
  return parts.length ? `${title}\n${parts.join("\n")}` : "";
}

const QUOTED_TEXT_LIMIT = 1800;

function truncateQuotedText(text: string, max = QUOTED_TEXT_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatTelegramSender(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  const parts: string[] = [];
  if (from.username) parts.push(`@${from.username}`);
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (displayName) parts.push(displayName);
  if (from.id !== undefined) parts.push(`id:${from.id}`);
  if (from.is_bot) parts.push("bot");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildTelegramQuotedMessageBlock(message: TelegramMessage | undefined): string {
  if (!message) return "";
  const lines = ["[telegram quoted message]", `message_id: ${message.message_id}`];
  const sender = formatTelegramSender(message.from);
  if (sender) lines.push(`from: ${sender}`);
  const text = message.text ?? message.caption;
  if (text?.trim()) {
    lines.push(message.caption !== undefined ? "caption:" : "text:");
    lines.push(truncateQuotedText(text.trim()));
  }
  const media = buildTelegramIncomingMediaSummary(message, "[telegram quoted attachment]");
  if (media) lines.push(media);
  if (lines.length === 2) lines.push("content: unavailable from Telegram update");
  return lines.join("\n");
}

function buildTelegramTextQuoteBlock(message: TelegramMessage): string {
  const quote = message.quote ?? message.text_quote ?? message.external_reply?.quote;
  if (!quote) return "";
  const text = quote.text?.trim();
  if (!text) return "";
  const lines = ["[telegram quoted text]", "text:", truncateQuotedText(text)];
  if (quote.position !== undefined) lines.push(`position: ${quote.position}`);
  if (quote.is_manual !== undefined) lines.push(`manual: ${quote.is_manual}`);
  return lines.join("\n");
}

function buildTelegramExternalReplyBlock(message: TelegramMessage): string {
  const external = message.external_reply;
  if (!external) return "";
  const lines = ["[telegram external reply]"];
  if (external.message_id !== undefined) lines.push(`message_id: ${external.message_id}`);
  if (external.chat) {
    const chat = external.chat;
    const chatParts = [
      chat.username ? `@${chat.username}` : undefined,
      chat.title,
      chat.type,
      chat.id !== undefined ? `id:${chat.id}` : undefined,
    ].filter(Boolean);
    if (chatParts.length > 0) lines.push(`chat: ${chatParts.join(" ")}`);
  }
  if (external.origin !== undefined) {
    try { lines.push(`origin: ${JSON.stringify(external.origin)}`); }
    catch { lines.push(`origin: ${String(external.origin)}`); }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function buildTelegramReplyContextBlock(message: TelegramMessage): string {
  return [
    buildTelegramQuotedMessageBlock(message.reply_to_message),
    buildTelegramTextQuoteBlock(message),
    buildTelegramExternalReplyBlock(message),
  ].filter(Boolean).join("\n\n");
}

function logTelegramReplyContext(message: TelegramMessage): void {
  const quote = message.quote ?? message.text_quote ?? message.external_reply?.quote;
  ctrlLog.debug("incoming telegram reply context", {
    messageId: message.message_id,
    hasReplyToMessage: !!message.reply_to_message,
    replyToMessageId: message.reply_to_message?.message_id,
    replyHasText: !!message.reply_to_message?.text,
    replyHasCaption: !!message.reply_to_message?.caption,
    replyHasMedia: !!buildTelegramIncomingMediaSummary(message.reply_to_message ?? ({} as TelegramMessage)),
    hasQuote: !!quote,
    quoteTextLength: quote?.text?.length ?? 0,
    hasExternalReply: !!message.external_reply,
  });
}

function formatSavedIncomingAttachmentLine(kind: string, fileId: string, fileName: string | undefined, path: string): string {
  const savedName = fileName ? `${fileName} (${fileId})` : fileId;
  return `- ${kind}: ${savedName} => ${path}`;
}

function formatIncomingAttachmentErrorLine(kind: string, fileId: string, fileName: string | undefined, reason: string): string {
  const target = fileName ? `${fileName} (${fileId})` : fileId;
  return `- ${kind}: ${target} -> failed to save (${reason})`;
}

function formatIncomingAttachmentReceipt(state: "saved" | "failed", lines: string[]): string {
  if (lines.length === 0) return "";
  const title = state === "saved" ? "✅ Saved attachments (local paths):" : "⚠️ Attachments not saved:";
  return `${title}\n${lines.join("\n")}`;
}


export type TelegramCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;


type TelegramUiStackEntry = {
  turn: TelegramTurn;
  ui: ExtensionUIContext;
  routedUi: ExtensionUIContext;
};

type TelegramUiStackState = {
  baseUi: unknown;
  baseMode: string;
  entries: TelegramUiStackEntry[];
};

const telegramUiStacks = new WeakMap<object, TelegramUiStackState>();

function isSameTelegramTurnTarget(currentTurn: TelegramTurn | undefined, turn: TelegramTurn): boolean {
  return currentTurn?.chatId === turn.chatId
    && currentTurn.messageThreadId === turn.messageThreadId
    && currentTurn.sourceMessageId === turn.sourceMessageId;
}

function createRoutedTelegramUi(baseUi: unknown, telegramUi: ExtensionUIContext, turn: TelegramTurn): ExtensionUIContext {
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      const currentTurn = getCurrentTelegramTurn();
      const target = isSameTelegramTurnTarget(currentTurn, turn) ? telegramUi : baseUi;
      const value = Reflect.get((target ?? {}) as object, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value, receiver) {
      const currentTurn = getCurrentTelegramTurn();
      const target = isSameTelegramTurnTarget(currentTurn, turn) ? telegramUi : baseUi;
      return Reflect.set((target ?? {}) as object, prop, value, receiver);
    },
    has(_target, prop) {
      const currentTurn = getCurrentTelegramTurn();
      const target = isSameTelegramTurnTarget(currentTurn, turn) ? telegramUi : baseUi;
      return prop in ((target ?? {}) as object);
    },
  }) as ExtensionUIContext;
}

function pushTelegramUiContext(runner: CapturedAgentSession["extensionRunner"], ui: ExtensionUIContext, turn: TelegramTurn): () => void {
  let state = telegramUiStacks.get(runner as object);
  if (!state) {
    state = { baseUi: runner.getUIContext(), baseMode: getRunnerMode(runner as any), entries: [] };
    telegramUiStacks.set(runner as object, state);
  }
  const previousUi = state.entries.at(-1)?.routedUi ?? state.baseUi;
  const entry: TelegramUiStackEntry = {
    turn,
    ui,
    routedUi: createRoutedTelegramUi(previousUi, ui, turn),
  };
  state.entries.push(entry);
  setRunnerUiContext(runner as any, entry.routedUi, TELEGRAM_EXTENSION_MODE);

  return () => {
    const current = telegramUiStacks.get(runner as object);
    if (!current) return;
    const idx = current.entries.indexOf(entry);
    if (idx === -1) return;
    const wasTop = idx === current.entries.length - 1;
    current.entries.splice(idx, 1);
    if (wasTop) {
      const next = current.entries.at(-1);
      if (next) setRunnerUiContext(runner as any, next.routedUi, TELEGRAM_EXTENSION_MODE);
      else setRunnerUiContext(runner as any, current.baseUi, current.baseMode);
    }
    if (current.entries.length === 0) telegramUiStacks.delete(runner as object);
  };
}

async function runWithTelegramUi<T>(deps: {
  session: CapturedAgentSession;
  ui: ExtensionUIContext;
  turn: TelegramTurn;
  run: () => Promise<T>;
}): Promise<T> {
  const restore = pushTelegramUiContext(deps.session.extensionRunner, deps.ui, deps.turn);
  try {
    return await deps.run();
  } finally {
    restore();
  }
}

export function createTelegramController(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  ui: TelegramUiRuntime;
  authorizeUser(userId: number | undefined, text?: string): Promise<boolean | "paired">;
  setActiveChatId(chatId: number): Promise<void>;
  getBotUsername(): string | undefined;
  getMessageMode: () => TelegramMessageMode;
  telegramCommands: Map<string, TelegramCommandHandler>;
  getActiveTurn(chatId: number, messageThreadId?: number): TelegramTurn | undefined;
  beginTelegramTurn(chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number): TelegramTurn | undefined;
  endTelegramTurn(chatId: number, turn: TelegramTurn): void;
  saveIncomingTelegramAttachment?: (fileId: string, fileName: string | undefined, kind: string) => Promise<string>;
}): TelegramController {
  const targetKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  // Per chat/thread prompt queues: each Telegram topic chains independently.
  const promptTails = new Map<string, Promise<void>>();
  // Increasing generation per chat/thread lets stop invalidate pending queue items.
  const interruptGenerationByTarget = new Map<string, number>();

  const getOrCreateTail = (key: string): Promise<void> => promptTails.get(key) ?? Promise.resolve();
  const setTail = (key: string, tail: Promise<void>) => promptTails.set(key, tail);
  const getInterruptGeneration = (key: string): number => interruptGenerationByTarget.get(key) ?? 0;
  const bumpInterruptGeneration = (key: string): void => {
    const next = getInterruptGeneration(key) + 1;
    interruptGenerationByTarget.set(key, next);
  };

  const fastInterrupt = async (chatId: number, messageThreadId?: number, sourceMessageId?: number) => {
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return;
    }

    bumpInterruptGeneration(targetKey(chatId, messageThreadId));
    await deps.transport.sendText(chatId, "⏹️ Interrupt requested.", messageThreadId, sourceMessageId);
    const abortResult = (session as any).abort?.();
    void abortResult?.catch?.(() => undefined);
  };

  const reportPromptFailure = async (label: string, chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined, err: unknown): Promise<void> => {
    ctrlLog.error(`${label} prompt task failed`, { chatId, messageThreadId, sourceMessageId, err });
    await deps.transport.sendText(chatId, "⚠️ Your message could not be delivered to π. Please retry.", messageThreadId, sourceMessageId)
      .catch(ctrlLog.swallow("warn", "sendText prompt-failure notice failed", { chatId, messageThreadId, sourceMessageId }));
  };

  const runPrompt = async (text: string, chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => {
    const session = deps.getSession();
    if (!session) {
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "π session is not ready yet.");
      else await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return;
    }

    const mode = deps.getMessageMode();
    const isSteer = mode === "steer" && session.isStreaming;

    // In steer mode, reuse the existing active turn for this chat/thread.
    // Steer messages inject into a running stream — they must not acquire a
    // new turn (which would fail since the target is already busy).
    if (isSteer) {
      const existingTurn = deps.getActiveTurn(chatId, messageThreadId);
      if (!existingTurn) {
        // No active turn to steer into — fall back to a new prompt.
        const turn = deps.beginTelegramTurn(chatId, undefined, messageThreadId, sourceMessageId);
        if (!turn) {
          await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", messageThreadId, sourceMessageId);
          return;
        }
        const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
        try {
          await runWithTelegramTurn(turn, () => runWithTelegramUi({
            session,
            ui: telegramUi,
            turn,
            run: async () => {
              // Goal auto-continuations can be streaming without owning an
              // active TelegramTurn. Keep the delivery behavior tied to the
              // configured mode rather than to our renderer bookkeeping.
              await session.prompt(text, { source: "interactive", streamingBehavior: "steer" });
            },
          }));
        } finally {
          deps.endTelegramTurn(chatId, turn);
        }
        return;
      }
      const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
      await runWithTelegramTurn(existingTurn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn: existingTurn,
        run: () => session.prompt(text, { source: "interactive", streamingBehavior: "steer" as const }),
      }));
      return;
    }

    const turn = deps.beginTelegramTurn(chatId, replaceMessageId, messageThreadId, sourceMessageId);
    if (!turn) {
      // Target already has an active turn — reject with a busy message.
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "⏳ π is busy. Try again shortly.");
      else await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", messageThreadId, sourceMessageId);
      return;
    }

    const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
    try {
      await runWithTelegramTurn(turn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn,
        run: async () => {
          // Always provide a delivery mode. AgentSession re-checks isStreaming
          // after awaiting input hooks, so a goal continuation can start after
          // our snapshot above and before prompt dispatch.
          await session.prompt(text, {
            source: "interactive",
            streamingBehavior: mode === "queue" ? "followUp" : "steer",
          });
        },
      }));
    } finally {
      deps.endTelegramTurn(chatId, turn);
    }
  };

  const submitText = async (text: string, chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => {
    const mode = deps.getMessageMode();
    if (mode === "steer") {
      const task = runPrompt(text, chatId, replaceMessageId, messageThreadId, sourceMessageId);
      void task.catch((err) => reportPromptFailure("steer-mode", chatId, messageThreadId, sourceMessageId, err));
      return;
    }

    const key = targetKey(chatId, messageThreadId);
    const generation = getInterruptGeneration(key);

    // In queue mode, chain behind the previous prompt for this chat/thread.
    const task = getOrCreateTail(key)
      .then(() => {
        if (generation !== getInterruptGeneration(key)) return;
        return runPrompt(text, chatId, replaceMessageId, messageThreadId, sourceMessageId);
      })
      .catch((err) => reportPromptFailure("queue-mode", chatId, messageThreadId, sourceMessageId, err));
    setTail(key, task);
  };

  const runCommandHandler = (handler: TelegramCommandHandler, args: string, session: CapturedAgentSession, chatId: number, messageThreadId?: number, sourceMessageId?: number) => {
    // Commands run immediately — they do not acquire a turn and are never
    // blocked by an active agent prompt.  Fast config / status commands
    // briefly borrow the UI context; the rendering pipeline still finds the
    // existing prompt turn via getActiveTurn() and stream output normally.
    //
    // Do not await command handlers here: some commands open interactive
    // prompts (e.g. /new confirmation), and awaiting them would stall the
    // polling loop and block callback processing for that update.
    const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
    const ctx = session.extensionRunner.createCommandContext();
    // Capture idleness BEFORE the handler runs. Commands like /sisyphus and
    // /goals enqueue the agent turn fire-and-forget via pi.sendUserMessage and
    // return immediately; the actual turn (and any goal_question /
    // propose_goal_draft / goal_questionnaire dialogs it raises) runs AFTER the
    // handler resolves. If we let runWithTelegramUi restore the TUI UI at that
    // point, those dialogs render to the local TUI and Telegram gets nothing.
    // Only hold the swap when the agent was idle when the command arrived: if a
    // local turn was already streaming, holding the swap would hijack the local
    // user's TUI (modals would route to Telegram, editor would no-op).
    const idleFn = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle : undefined;
    const waitFn = typeof (ctx as any).waitForIdle === "function" ? (ctx as any).waitForIdle : undefined;
    const wasIdle = idleFn ? idleFn.call(ctx) : false;
    const commandTurn = deps.getActiveTurn(chatId, messageThreadId) ?? { chatId, messageThreadId, sourceMessageId, queuedAttachments: [] };
    void runWithTelegramTurn(commandTurn, () => runWithTelegramUi({
      session,
      ui: telegramUi,
      turn: commandTurn,
      run: async () => {
        await handler(args, ctx);
        if (!wasIdle || !idleFn || !waitFn) return;
        // Hold the Telegram UI swap across the command's enqueued turn and any
        // auto-continue chain it spawns. pi-goal schedules continuation turns via
        // setTimeout(0 / 50ms) after a turn ends, so a single waitForIdle()
        // resolves before the next turn starts. After each idle, yield one
        // macrotask window (120ms > pi-goal's 50ms CONTINUATION_IDLE_RETRY_MS) to
        // let a pending continuation begin; if the agent starts streaming again,
        // keep waiting. Stop when the agent stays idle through the window — the
        // chain has drained and the local TUI is fully usable again.
        try {
          for (;;) {
            await waitFn.call(ctx);
            await new Promise((r) => setTimeout(r, 120));
            if (idleFn.call(ctx)) break;
          }
        } catch (err) {
          // Session disposed / torn down during the wait — nothing to do but log.
          ctrlLog.debug("waitForIdle during enqueued turn interrupted", { err });
        }
      },
    })).catch(async (err) => {
      ctrlLog.warn("telegram command handler failed", { chatId, messageThreadId, err });
      await deps.transport.sendText(chatId, `⚠️ Command failed:\n${commandErrorMessage(err)}`, messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("warn", "sendText command-failure notice failed", { chatId, messageThreadId }));
    });
  };

  const tryHandleSlashCommand = async (text: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<boolean> => {
    const parsed = parseLeadingCommand(text);
    if (!parsed) return false;
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return true;
    }

    const name = parsed.name.toLowerCase();
    const handler =
      deps.telegramCommands.get(name)
      ?? deps.telegramCommands.get(name.replace(/_/g, "-"))
      ?? deps.telegramCommands.get(name.replace(/-/g, "_"));
    if (handler) {
      await runCommandHandler(handler, parsed.args, session, chatId, messageThreadId, sourceMessageId);
      return true;
    }
    const externalCommand =
      session.extensionRunner.getCommand(name)
      ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
      ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
    if (externalCommand) {
      await runCommandHandler(externalCommand.handler, parsed.args, session, chatId, messageThreadId, sourceMessageId);
      return true;
    }
    return false;
  };

  return {
    async handleCallbackQuery(query) {
      const chatId = query.message?.chat?.id;
      if (typeof chatId !== "number") return;
      const messageThreadId = query.message?.message_thread_id;
      const sourceMessageId = query.message?.message_id;
      await deps.transport.answerCallbackQuery(query.id).catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
      if (!(await deps.authorizeUser(query.from?.id))) return;
      await deps.setActiveChatId(chatId);

      const data = query.data ?? "";
      const uiValue = decodeUiCallback(data);
      if (uiValue !== undefined) {
        const result = deps.ui.resolveInput(chatId, uiValue, query.message?.message_id, true, messageThreadId);
        if (!result.handled) {
          await deps.transport.sendText(chatId, "This prompt is no longer active.", messageThreadId, sourceMessageId);
        }
        // Keyboard cleanup is OWNED by each UI flow (confirm/input/select and the
        // custom-dialog bridge): each calls removeInlineKeyboard on its own prompt
        // message right before resolving a terminal value (yes/no/cancel/submit/...).
        // The controller must NOT speculatively strip keyboards here. Doing so races
        // with continuation flows (multi-question tab navigation, single-question
        // option toggles, select pagination) that edit the SAME message in place:
        // removeInlineKeyboard and editButtons hit Telegram concurrently on one
        // message, and when the strip lands last the message is left with no
        // buttons — the "answered Q1 but Q2 never appeared" bug. Terminal flows
        // clean up themselves, so no controller-side strip is needed.
        return;
      }

      if (data) {
        const messageId = query.message?.message_id;
        await submitText(data, chatId, messageId, messageThreadId, sourceMessageId);
      }
    },

    async handleMessage(message) {
      const chatId = message.chat?.id;
      if (typeof chatId !== "number") return;
      const messageThreadId = message.message_thread_id;
      const sourceMessageId = message.message_id;
      const rawText = message.text ?? message.caption ?? "";
      ctrlLog.debug("incoming telegram message shape", {
        messageId: message.message_id,
        keys: Object.keys(message),
        hasReplyToMessage: !!message.reply_to_message,
        hasQuote: !!message.quote,
        hasTextQuote: !!message.text_quote,
        hasExternalReply: !!message.external_reply,
      });
      const authorization = await deps.authorizeUser(message.from?.id, rawText);
      if (!authorization) return;
      await deps.setActiveChatId(chatId);
      if (authorization === "paired") {
        await deps.transport.sendText(chatId, "✅ Telegram user paired.", messageThreadId, sourceMessageId);
        return;
      }

      const text = normalizeLeadingCommand(rawText, deps.getBotUsername());
      const trimmed = text.trim();
      const replyToInput = message.reply_to_message?.message_id;
      if (message.reply_to_message || message.quote || message.text_quote || message.external_reply) logTelegramReplyContext(message);
      if (trimmed === "/stop") {
        // /stop cancellation priority: first try canceling a reply-targeted
        // pending input, then any pending input, then abort the agent turn.
        const cancelResult = deps.ui.resolveInput(chatId, undefined, replyToInput, false, messageThreadId);
        const cancelAnyResult = !cancelResult.handled ? deps.ui.resolveInput(chatId, undefined, undefined, false, messageThreadId) : cancelResult;
        if (cancelAnyResult.handled) {
          if (cancelAnyResult.promptMessageId) void deps.transport.removeInlineKeyboard(chatId, cancelAnyResult.promptMessageId);
          await deps.transport.sendText(chatId, "Cancelled.", messageThreadId, sourceMessageId);
          return;
        }
        await fastInterrupt(chatId, messageThreadId, sourceMessageId);
        return;
      }

      const mediaSummary = buildTelegramIncomingMediaSummary(message);
      const hasMediaInput = mediaSummary.length > 0;
      const hasTextInput = message.text !== undefined || message.caption !== undefined;
      const incomingMedia = hasMediaInput ? extractTelegramMediaEntries(message) : [];
      const downloadedMediaLines: string[] = [];
      const failedMediaLines: string[] = [];
      if (deps.saveIncomingTelegramAttachment && incomingMedia.length > 0) {
        const mediaSaveResults = await Promise.allSettled(
          incomingMedia.map((attachment) => deps.saveIncomingTelegramAttachment!(
            attachment.fileId,
            attachment.fileName,
            attachment.type,
          )),
        );
        for (let i = 0; i < incomingMedia.length; i++) {
          const media = incomingMedia[i];
          const saveResult = mediaSaveResults[i];
          if (saveResult.status === "fulfilled") {
            downloadedMediaLines.push(formatSavedIncomingAttachmentLine(media.type, media.fileId, media.fileName, saveResult.value));
          } else {
            const reason = saveResult.reason instanceof Error ? saveResult.reason.message : String(saveResult.reason);
            failedMediaLines.push(formatIncomingAttachmentErrorLine(media.type, media.fileId, media.fileName, reason));
          }
        }
        if (downloadedMediaLines.length > 0 || failedMediaLines.length > 0) {
          const lines = [
            formatIncomingAttachmentReceipt("saved", downloadedMediaLines),
            formatIncomingAttachmentReceipt("failed", failedMediaLines),
          ].filter(Boolean);
          await deps.transport.sendText(chatId, lines.join("\n\n"), messageThreadId, sourceMessageId).catch(ctrlLog.swallow("warn", "sendText media receipt failed", { chatId, messageThreadId }));
        }
      }
      const hasPromptInput = hasTextInput || hasMediaInput;
      if (hasTextInput) {
        const wasSensitive = deps.ui.isSensitiveInput(chatId, replyToInput, messageThreadId);
        const inputResult = deps.ui.resolveInput(chatId, rawText, replyToInput, false, messageThreadId);
        if (inputResult.handled) {
          if (wasSensitive) await deps.transport.deleteMessage(chatId, message.message_id);
          return;
        }
      }
      if (hasPromptInput) {
        const mediaBlock = (() => {
          if (!hasMediaInput) return "";
          const lines = [mediaSummary];
          const statusLines = [...downloadedMediaLines, ...failedMediaLines];
          if (statusLines.length > 0) {
            lines.push(statusLines.join("\n"));
          }
          return `\n\n${lines.filter(Boolean).join("\n")}`;
        })();
        const handled = trimmed ? await tryHandleSlashCommand(text, chatId, messageThreadId, sourceMessageId) : false;
        if (!handled) {
          const parsed = parseLeadingCommand(text);
          const basePrompt = parsed
            ? `/${parsed.name.replace(/_/g, "-")}${parsed.args ? ` ${parsed.args}` : ""}`
            : trimmed || "";
          const promptText = `${basePrompt}${mediaBlock}`.trim();
          const quotedBlock = buildTelegramReplyContextBlock(message);
          const finalPrompt = quotedBlock
            ? `${quotedBlock}\n\n[telegram message]\n${promptText}`.trim()
            : promptText;
          await submitText(finalPrompt, chatId, undefined, messageThreadId, sourceMessageId);
        }
      }
    },

  };
}