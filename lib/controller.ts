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

function buildTelegramIncomingMediaSummary(message: TelegramMessage): string {
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
  return parts.length ? `[telegram attachment]\n${parts.join("\n")}` : "";
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


async function runWithTelegramUi<T>(deps: {
  session: CapturedAgentSession;
  ui: ExtensionUIContext;
  run: () => Promise<T>;
}): Promise<T> {
  const runner = deps.session.extensionRunner;
  const previousUi = runner.getUIContext();
  const previousMode = getRunnerMode(runner as any);
  setRunnerUiContext(runner as any, deps.ui, TELEGRAM_EXTENSION_MODE);
  try {
    return await deps.run();
  } finally {
    setRunnerUiContext(runner as any, previousUi, previousMode);
  }
}

export function createTelegramController(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  ui: TelegramUiRuntime;
  authorizeUser(userId: number | undefined): Promise<boolean>;
  setActiveChatId(chatId: number): Promise<void>;
  getBotUsername(): string | undefined;
  getMessageMode: () => TelegramMessageMode;
  telegramCommands: Map<string, TelegramCommandHandler>;
  getActiveTurn(chatId: number): TelegramTurn | undefined;
  beginTelegramTurn(chatId: number, replaceMessageId?: number): TelegramTurn | undefined;
  endTelegramTurn(chatId: number, turn: TelegramTurn): void;
  saveIncomingTelegramAttachment?: (fileId: string, fileName: string | undefined, kind: string) => Promise<string>;
}): TelegramController {
  // Per-chat prompt queues: each chat chains its prompts sequentially.
  const promptTails = new Map<number, Promise<void>>();
  // Increasing generation per chat lets stop invalidate pending queue items.
  const interruptGenerationByChat = new Map<number, number>();

  const getOrCreateTail = (chatId: number): Promise<void> => promptTails.get(chatId) ?? Promise.resolve();
  const setTail = (chatId: number, tail: Promise<void>) => promptTails.set(chatId, tail);
  const getInterruptGeneration = (chatId: number): number => interruptGenerationByChat.get(chatId) ?? 0;
  const bumpInterruptGeneration = (chatId: number): void => {
    const next = getInterruptGeneration(chatId) + 1;
    interruptGenerationByChat.set(chatId, next);
  };

  const fastInterrupt = async (chatId: number) => {
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.");
      return;
    }

    bumpInterruptGeneration(chatId);
    await deps.transport.sendText(chatId, "⏹️ Interrupt requested.");
    const abortResult = (session as any).abort?.();
    void abortResult?.catch?.(() => undefined);
  };

  const reportPromptFailure = async (label: string, chatId: number, err: unknown): Promise<void> => {
    ctrlLog.error(`${label} prompt task failed`, { chatId, err });
    await deps.transport.sendText(chatId, "⚠️ Your message could not be delivered to π. Please retry.")
      .catch(ctrlLog.swallow("warn", "sendText prompt-failure notice failed", { chatId }));
  };

  const runPrompt = async (text: string, chatId: number, replaceMessageId?: number) => {
    const session = deps.getSession();
    if (!session) {
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "π session is not ready yet.");
      else await deps.transport.sendText(chatId, "π session is not ready yet.");
      return;
    }

    const mode = deps.getMessageMode();
    const isSteer = mode === "steer" && session.isStreaming;

    // In steer mode, reuse the existing active turn for this chat.
    // Steer messages inject into a running stream — they must not acquire a
    // new turn (which would fail since the chat already has one).
    if (isSteer) {
      const existingTurn = deps.getActiveTurn(chatId);
      if (!existingTurn) {
        // No active turn to steer into — fall back to a new prompt.
        const turn = deps.beginTelegramTurn(chatId);
        if (!turn) {
          await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.");
          return;
        }
        const telegramUi = deps.ui.create(chatId);
        try {
          await runWithTelegramUi({
            session,
            ui: telegramUi,
            run: async () => {
              // Goal auto-continuations can be streaming without owning an
              // active TelegramTurn. Keep the delivery behavior tied to the
              // configured mode rather than to our renderer bookkeeping.
              await session.prompt(text, { source: "interactive", streamingBehavior: "steer" });
            },
          });
        } finally {
          deps.endTelegramTurn(chatId, turn);
        }
        return;
      }
      const telegramUi = deps.ui.create(chatId);
      await runWithTelegramUi({
        session,
        ui: telegramUi,
        run: () => session.prompt(text, { source: "interactive", streamingBehavior: "steer" as const }),
      });
      return;
    }

    const turn = deps.beginTelegramTurn(chatId, replaceMessageId);
    if (!turn) {
      // Chat already has an active turn — reject with a busy message.
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "⏳ π is busy. Try again shortly.");
      else await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.");
      return;
    }

    const telegramUi = deps.ui.create(chatId);
    try {
      await runWithTelegramUi({
        session,
        ui: telegramUi,
        run: async () => {
          // Always provide a delivery mode. AgentSession re-checks isStreaming
          // after awaiting input hooks, so a goal continuation can start after
          // our snapshot above and before prompt dispatch.
          await session.prompt(text, {
            source: "interactive",
            streamingBehavior: mode === "queue" ? "followUp" : "steer",
          });
        },
      });
    } finally {
      deps.endTelegramTurn(chatId, turn);
    }
  };

  const submitText = async (text: string, chatId: number, replaceMessageId?: number) => {
    const mode = deps.getMessageMode();
    if (mode === "steer") {
      const task = runPrompt(text, chatId, replaceMessageId);
      void task.catch((err) => reportPromptFailure("steer-mode", chatId, err));
      return;
    }

    const generation = getInterruptGeneration(chatId);

    // In queue mode, chain behind the previous prompt for this chat.
    const task = getOrCreateTail(chatId)
      .then(() => {
        if (generation !== getInterruptGeneration(chatId)) return;
        return runPrompt(text, chatId, replaceMessageId);
      })
      .catch((err) => reportPromptFailure("queue-mode", chatId, err));
    setTail(chatId, task);
  };

  const runCommandHandler = (handler: TelegramCommandHandler, args: string, session: CapturedAgentSession, chatId: number) => {
    // Commands run immediately — they do not acquire a turn and are never
    // blocked by an active agent prompt.  Fast config / status commands
    // briefly borrow the UI context; the rendering pipeline still finds the
    // existing prompt turn via getActiveTurn() and stream output normally.
    //
    // Do not await command handlers here: some commands open interactive
    // prompts (e.g. /new confirmation), and awaiting them would stall the
    // polling loop and block callback processing for that update.
    const telegramUi = deps.ui.create(chatId);
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
    void runWithTelegramUi({
      session,
      ui: telegramUi,
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
    }).catch(async (err) => {
      ctrlLog.warn("telegram command handler failed", { chatId, err });
      await deps.transport.sendText(chatId, `⚠️ Command failed:\n${commandErrorMessage(err)}`)
        .catch(ctrlLog.swallow("warn", "sendText command-failure notice failed", { chatId }));
    });
  };

  const tryHandleSlashCommand = async (text: string, chatId: number): Promise<boolean> => {
    const parsed = parseLeadingCommand(text);
    if (!parsed) return false;
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.");
      return true;
    }

    const name = parsed.name.toLowerCase();
    const handler =
      deps.telegramCommands.get(name)
      ?? deps.telegramCommands.get(name.replace(/_/g, "-"))
      ?? deps.telegramCommands.get(name.replace(/-/g, "_"));
    if (handler) {
      await runCommandHandler(handler, parsed.args, session, chatId);
      return true;
    }
    const externalCommand =
      session.extensionRunner.getCommand(name)
      ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
      ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
    if (externalCommand) {
      await runCommandHandler(externalCommand.handler, parsed.args, session, chatId);
      return true;
    }
    return false;
  };

  return {
    async handleCallbackQuery(query) {
      const chatId = query.message?.chat?.id;
      if (typeof chatId !== "number") return;
      await deps.transport.answerCallbackQuery(query.id).catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
      if (!(await deps.authorizeUser(query.from?.id))) return;
      await deps.setActiveChatId(chatId);

      const data = query.data ?? "";
      const uiValue = decodeUiCallback(data);
      if (uiValue !== undefined) {
        const result = deps.ui.resolveInput(chatId, uiValue, query.message?.message_id, true);
        if (!result.handled) {
          await deps.transport.sendText(chatId, "This prompt is no longer active.");
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
        await submitText(data, chatId, messageId);
      }
    },

    async handleMessage(message) {
      const chatId = message.chat?.id;
      if (typeof chatId !== "number") return;
      if (!(await deps.authorizeUser(message.from?.id))) return;
      await deps.setActiveChatId(chatId);

      const rawText = message.text ?? message.caption ?? "";
      const text = normalizeLeadingCommand(rawText, deps.getBotUsername());
      const trimmed = text.trim();
      const replyToInput = message.reply_to_message?.message_id;
      if (trimmed === "/stop") {
        // /stop cancellation priority: first try canceling a reply-targeted
        // pending input, then any pending input, then abort the agent turn.
        const cancelResult = deps.ui.resolveInput(chatId, undefined, replyToInput);
        const cancelAnyResult = !cancelResult.handled ? deps.ui.resolveInput(chatId, undefined) : cancelResult;
        if (cancelAnyResult.handled) {
          if (cancelAnyResult.promptMessageId) void deps.transport.removeInlineKeyboard(chatId, cancelAnyResult.promptMessageId);
          await deps.transport.sendText(chatId, "Cancelled.");
          return;
        }
        await fastInterrupt(chatId);
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
          await deps.transport.sendText(chatId, lines.join("\n\n")).catch(ctrlLog.swallow("warn", "sendText media receipt failed", { chatId }));
        }
      }
      const hasPromptInput = hasTextInput || hasMediaInput;
      if (hasTextInput) {
        const wasSensitive = deps.ui.isSensitiveInput(chatId, replyToInput);
        const inputResult = deps.ui.resolveInput(chatId, rawText, replyToInput);
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
        const handled = trimmed ? await tryHandleSlashCommand(text, chatId) : false;
        if (!handled) {
          const parsed = parseLeadingCommand(text);
          const basePrompt = parsed
            ? `/${parsed.name.replace(/_/g, "-")}${parsed.args ? ` ${parsed.args}` : ""}`
            : trimmed || "";
          const promptText = `${basePrompt}${mediaBlock}`.trim();
          await submitText(promptText, chatId);
        }
      }
    },

  };
}