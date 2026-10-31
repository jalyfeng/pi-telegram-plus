import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DIALOG_CALLBACK_PREFIX, decodeDialogCallback, decodeMoreCallback, decodeRunCallback, decodeUiCallback, encodeMoreCallback, encodeRunCallback } from "./callback-protocol.ts";
import { parseLeadingCommand, normalizeLeadingCommand } from "./command-parser.ts";
import type {
  CapturedAgentSession,
  TelegramBashConfirm,
  TelegramButton,
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramTransport,
  TelegramTurn,
} from "./types.ts";
import type { TelegramUiRuntime } from "./telegram-ui.ts";
import type { TuiBridgeAdapter } from "./tui-bridge.ts";
import { tuiBridge as defaultTuiBridge, hostOwnsPrompts } from "./tui-bridge.ts";
import { escapeHtml } from "./html.ts";
import { richMessageToPlainText } from "./rich-text-plain.ts";
import { recordCommandUsage } from "./command-usage.ts";
import { getTelegramMenuOverflow } from "./menu-commands.ts";
import { log } from "./logger.ts";
import { commandErrorMessage, getRunnerMode, restoreRunnerUiContext, setRunnerUiContext, TELEGRAM_EXTENSION_MODE } from "./pi-compat.ts";
import { isOmpHost } from "./session-capture.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "./turn-context.ts";
import { OriginTracker, type CommandScope } from "./tui/origin.ts";
import { FocusTracker } from "./tui/focus.ts";
import { OutputCapture } from "./tui/output.ts";
import { CommandGateway } from "./tui/gateway.ts";
import { runInCommand } from "./tui/command-context.ts";
import { DialogBroker } from "./tui/broker.ts";
import { SecretStore } from "./tui/secrets.ts";
import { readEditorText as readHostEditorText, writeEditorText as writeHostEditorText } from "./tui/host.ts";
import type { DialogSession } from "./tui/model.ts";

const ctrlLog = log.child("controller");

/** Callbacks from the removed screen-mirror keyboards: answered as expired and
 * never injected (§0.1 #4). Exported so the regression test shares one source. */
export const EXPIRED_TUI_CALLBACK_PREFIX = "tgplus:tui:";

export type TelegramController = {
  handleMessage(message: TelegramMessage): Promise<void>;
  handleCallbackQuery(query: TelegramCallbackQuery): Promise<void>;
  /** Dispatch a named command from an inline menu (e.g. /tg → Commands). */
  runCommand(name: string, args: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<void>;
  dispose(): void;
};

/**
 * The notice for a message that arrived while a terminal dialog owns the keyboard
 * (§4.2, decision 54): the `!` shell route and plain text must say the same thing, so the
 * wording lives here once - with the dialog's title when the model has one.
 */
function dialogBusyNotice(session: DialogSession): string {
  const model = session.model;
  const title = "title" in model ? model.title : undefined;
  return `A dialog is waiting in the terminal${title ? ` (${title})` : ""}. Answer it with the buttons, or send /stop to cancel.`;
}

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
  const hasPlainText = !!text?.trim();
  const body = hasPlainText ? text!.trim() : richMessageToPlainText(message.rich_message);
  if (body) {
    lines.push(hasPlainText && message.caption !== undefined ? "caption:" : "text:");
    lines.push(truncateQuotedText(body));
  }
  const media = buildTelegramIncomingMediaSummary(message, "[telegram quoted attachment]");
  if (media) lines.push(media);
  if (!body && !media) lines.push("content: unavailable from Telegram update");
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
  /** Single installed UI that dispatches per Telegram turn (see createDispatchTelegramUi). */
  dispatchUi?: ExtensionUIContext;
};

const telegramUiStacks = new WeakMap<object, TelegramUiStackState>();

function isSameTelegramTurnTarget(currentTurn: TelegramTurn | undefined, turn: TelegramTurn): boolean {
  return currentTurn?.chatId === turn.chatId
    && currentTurn.messageThreadId === turn.messageThreadId
    && currentTurn.sourceMessageId === turn.sourceMessageId;
}

function createRoutedTelegramUi(baseUi: unknown, telegramUi: ExtensionUIContext, turn: TelegramTurn): ExtensionUIContext {
  const getTarget = () => {
    const currentTurn = getCurrentTelegramTurn();
    return (isSameTelegramTurnTarget(currentTurn, turn) ? telegramUi : baseUi) as object | undefined;
  };
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      // Lets the focus tracker reach the host context underneath: entry hooks must
      // land on the real object even while a Telegram swap is installed.
      if (prop === "__piTelegramPlusRoutedBaseUi") return baseUi;
      const target = getTarget();
      const value = Reflect.get(target ?? {}, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value, receiver) {
      const target = getTarget();
      return Reflect.set(target ?? {}, prop, value, receiver);
    },
    has(_target, prop) {
      const target = getTarget();
      return prop in (target ?? {});
    },
    // Support object spread ({ ...ui }) without dropping dynamically routed properties.
    ownKeys(_target) {
      const target = getTarget();
      return Reflect.ownKeys(target ?? {});
    },
    getOwnPropertyDescriptor(_target, prop) {
      const target = getTarget();
      const desc = Reflect.getOwnPropertyDescriptor(target ?? {}, prop);
      if (!desc) return undefined;
      return {
        ...desc,
        configurable: true,
      };
    },
  }) as ExtensionUIContext;
}

/**
 * The single UI installed on the runner while any Telegram command is live.
 * Every member access resolves the caller's Telegram turn from AsyncLocalStorage
 * and forwards to that turn's routed UI; calls with no Telegram turn (a local
 * terminal turn, a timer outside any command) go to the host's original UI.
 * The routed-UI unwrap contract is kept so the focus tracker still reaches the
 * real host context underneath.
 */
function createDispatchTelegramUi(state: TelegramUiStackState): ExtensionUIContext {
  const getTarget = (): object => {
    const turn = getCurrentTelegramTurn();
    return ((turn && routedUiByTurn.get(turn)) ?? state.baseUi) as object;
  };
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      if (prop === "__piTelegramPlusRoutedBaseUi") return state.baseUi;
      const target = getTarget();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(getTarget(), prop, value, receiver);
    },
    has(_target, prop) {
      return prop in getTarget();
    },
    ownKeys() {
      return Reflect.ownKeys(getTarget());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(getTarget(), prop);
      if (!desc) return undefined;
      return { ...desc, configurable: true };
    },
  }) as ExtensionUIContext;
}

/**
 * Replace `ui` on an already-created context object. Interactive modals must
 * not mutate stateful getters, so the property is redefined in place instead of
 * spreading the context (some hosts expose `model` and friends as getters).
 */
function withUiContext<T extends object>(ctx: T, ui: ExtensionUIContext): T {
  try {
    return Object.defineProperty(ctx, "ui", {
      value: ui,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    // Some hosts hand out a context whose `ui` cannot be redefined. A read-through
    // proxy overrides just that member and leaves every other getter on the
    // original object intact.
    return new Proxy(ctx, {
      get: (target, property, receiver) =>
        property === "ui" ? ui : Reflect.get(target, property, receiver),
      has: (target, property) => property === "ui" || Reflect.has(target, property),
    }) as T;
  }
}

// Runners whose getUIContext()/createContext() consult the per-turn routed UIs.
// The patch is permanent per runner and falls back to the host UI when no
// Telegram turn is active, so it needs no uninstall.
const routedRunnerUiPatched = new WeakSet<object>();

/**
 * Route agent-, tool-, and hook-raised dialogs on hosts without a UI-context
 * setter (OMP). `getUIContext()` backs tool approvals and session-level
 * selects; `createContext()` backs extension hooks and extension tools.
 * Both read the private UI context directly, so overriding the instance
 * methods is the only public seam. Each call resolves the routed UI of the
 * CURRENT Telegram turn (AsyncLocalStorage), never the newest stack entry, so
 * a command that is still running keeps its own chat while another one is on
 * top; calls outside any Telegram turn fall through to the host UI, keeping
 * local TUI turns untouched.
 */
function installRoutedRunnerUi(runner: CapturedAgentSession["extensionRunner"]): void {
  if (routedRunnerUiPatched.has(runner)) return;
  routedRunnerUiPatched.add(runner);
  const originalGetUIContext = runner.getUIContext.bind(runner);
  const originalCreateContext = runner.createContext.bind(runner);
  const routedUiForCurrentTurn = (): ExtensionUIContext | undefined => {
    const turn = getCurrentTelegramTurn();
    return turn ? routedUiByTurn.get(turn) : undefined;
  };

  runner.getUIContext = () => routedUiForCurrentTurn() ?? originalGetUIContext();
  runner.createContext = (...args: Parameters<typeof originalCreateContext>) => {
    const ctx = originalCreateContext(...args);
    const routed = routedUiForCurrentTurn();
    return routed ? withUiContext(ctx, routed) : ctx;
  };
}

// Turn -> routed UI. Built-in tools get their context outside the runner
// methods, so the AsyncLocalStorage turn is the key that reaches them.
const routedUiByTurn = new WeakMap<TelegramTurn, ExtensionUIContext>();
const toolExecutePatched = new WeakSet<object>();
const toolSessionPatched = new WeakSet<object>();

/**
 * Built-in tools receive `ui` from OMP's private ToolContextStore, which is not
 * reachable from AgentSession. Wrap the two places it surfaces:
 * - the `ask` tool's execute context (agent loop -> ToolContextStore)
 * - ToolSession.getToolContext (eval preludes such as computer control)
 * While a Telegram turn is active the context's `ui` is replaced with the
 * routed UI; otherwise the original context is passed through untouched.
 */
function readAgentTools(session: CapturedAgentSession): readonly unknown[] {
  if (!("agent" in session)) return [];
  const agent = session.agent;
  if (!agent || typeof agent !== "object" || !("state" in agent)) return [];
  const state = agent.state;
  if (!state || typeof state !== "object" || !("tools" in state)) return [];
  return Array.isArray(state.tools) ? state.tools : [];
}

function installToolUiRouting(session: CapturedAgentSession): void {
  for (const raw of readAgentTools(session)) {
    if (!raw || typeof raw !== "object") continue;
    const name = "name" in raw ? raw.name : undefined;
    const execute = "execute" in raw ? raw.execute : undefined;
    if (name === "ask" && typeof execute === "function" && !toolExecutePatched.has(raw)) {
      const originalExecute = execute.bind(raw) as (...args: unknown[]) => unknown;
      try {
        Object.defineProperty(raw, "execute", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            const turn = getCurrentTelegramTurn();
            const routed = turn ? routedUiByTurn.get(turn) : undefined;
            if (!routed) return originalExecute(...args);
            // Hosts disagree on where the tool context sits in the execute
            // signature (pi: second argument; OMP's ask: fifth), so route every
            // argument that carries a UI context.
            const routedArgs = args.map((arg) => {
              if (!arg || typeof arg !== "object" || !("ui" in (arg as object))) return arg;
              try {
                return withUiContext(arg as Record<string, unknown>, routed);
              } catch {
                return arg;
              }
            });
            return originalExecute(...routedArgs);
          },
        });
        toolExecutePatched.add(raw);
      } catch {
        // Frozen/proxied tools keep the host UI.
      }
    }
    const toolSession = "session" in raw ? raw.session : undefined;
    if (!toolSession || typeof toolSession !== "object" || toolSessionPatched.has(toolSession)) continue;
    const getToolContext = "getToolContext" in toolSession ? toolSession.getToolContext : undefined;
    if (typeof getToolContext !== "function") continue;
    const originalGetToolContext = getToolContext.bind(toolSession) as () => unknown;
    try {
      Object.defineProperty(toolSession, "getToolContext", {
        configurable: true,
        writable: true,
        value: () => {
          const ctx = originalGetToolContext();
          const turn = getCurrentTelegramTurn();
          const routed = turn ? routedUiByTurn.get(turn) : undefined;
          return routed && ctx && typeof ctx === "object" ? withUiContext(ctx, routed) : ctx;
        },
      });
      toolSessionPatched.add(toolSession);
    } catch {
      // Non-writable ToolSession keeps eval preludes on the host UI.
    }
  }
}

/**
 * §4.9 host-prompt UI. Instead of answering prompts itself, it delegates every
 * call to the host UI (so the terminal draws the dialog) and keeps the plugin's
 * notify and plugin-only affordances pointed at this chat. Answers travel back
 * through the DialogBroker, which owns the keys once it can attribute the
 * dialog to a chat.
 */
function createHostPromptUi(baseUi: unknown, telegramUi: ExtensionUIContext): ExtensionUIContext {
  // Whether the UI underneath already delivers notifications to the Telegram chat.
  const baseReachesChat = (baseUi as Record<string, unknown> | undefined)?.__piTelegramPlusRoutedUi === true;
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      if (prop === "__piTelegramPlusRoutedBaseUi") return baseUi;
      const target = baseUi ?? {};
      const value = Reflect.get(target as object, prop, receiver);
      if (typeof value !== "function") {
        // A plugin-only affordance - the nested `menu` keyboard the management screens
        // walk - has no host twin, so the plugin's own implementation keeps serving it
        // even while the host owns the prompts.
        const own = (telegramUi as unknown as Record<string, unknown>)[String(prop)];
        return typeof own === "function" ? own.bind(telegramUi) : value;
      }
      const name = String(prop);
      if (name === "notify") {
        // Notifications are not prompts: the terminal still prints them, and the chat keeps
        // receiving what it used to. When the base UI is already the plugin's routed context -
        // which is exactly what pi hands a command context - its own notify reaches this chat,
        // so copying it here would send the same line two or three times.
        if (baseReachesChat) return value.bind(target);
        return (...args: unknown[]) => {
          let result: unknown;
          try {
            result = (value as (...notifyArgs: unknown[]) => unknown).apply(target, args);
          } catch {
            // Host notification failures must not block the chat copy.
          }
          try {
            const chatNotify = (telegramUi as unknown as Record<string, unknown>).notify;
            if (typeof chatNotify === "function") (chatNotify as (...a: unknown[]) => unknown).apply(telegramUi, args);
          } catch {
            // Chat notification is best-effort.
          }
          return result;
        };
      }
      return value.bind(target);
    },
    has(_target, prop) {
      const target = baseUi ?? {};
      return prop === "__piTelegramPlusRoutedUi" || prop in (target as object);
    },
    ownKeys() {
      return Reflect.ownKeys((baseUi ?? {}) as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor((baseUi ?? {}) as object, prop);
      return desc ? { ...desc, configurable: true } : undefined;
    },
  }) as ExtensionUIContext;
}

function pushTelegramUiContext(
  runner: CapturedAgentSession["extensionRunner"],
  ui: ExtensionUIContext,
  turn: TelegramTurn,
  makeRouted: (baseUi: unknown, telegramUi: ExtensionUIContext, turn: TelegramTurn) => ExtensionUIContext = createRoutedTelegramUi,
): () => void {
  if (typeof runner.setUIContext !== "function") installRoutedRunnerUi(runner);
  let state = telegramUiStacks.get(runner as object);
  if (!state) {
    state = { baseUi: runner.getUIContext(), baseMode: getRunnerMode(runner as any), entries: [] };
    telegramUiStacks.set(runner as object, state);
  }
  // Every command's routed UI sits directly on the host UI. Chaining it onto
  // the previous entry's routed UI let a host-prompt UI fall through to ANOTHER
  // chat's routed UI (its notify reached chat A while B's command ran).
  const entry: TelegramUiStackEntry = {
    turn,
    ui,
    routedUi: makeRouted(state.baseUi, ui, turn),
  };
  state.entries.push(entry);
  routedUiByTurn.set(turn, entry.routedUi);
  // Install the dispatching UI once per stack, not once per command: it reads
  // the current Telegram turn on every property access and forwards to that
  // turn's routed UI (or the host UI when no turn is active). Re-setting the
  // runner UI on every push/pop is what sent A's still-running calls to B's UI.
  if (state.entries.length === 1) {
    state.dispatchUi = createDispatchTelegramUi(state);
    setRunnerUiContext(runner as any, state.dispatchUi, TELEGRAM_EXTENSION_MODE);
  }

  return () => {
    const current = telegramUiStacks.get(runner as object);
    if (!current) return;
    const idx = current.entries.indexOf(entry);
    if (idx === -1) return;
    current.entries.splice(idx, 1);
    if (routedUiByTurn.get(turn) === entry.routedUi) {
      const remaining = current.entries.findLast((candidate) => candidate.turn === turn);
      if (remaining) routedUiByTurn.set(turn, remaining.routedUi);
      else routedUiByTurn.delete(turn);
    }
    if (current.entries.length === 0) {
      restoreRunnerUiContext(runner as any, current.baseUi, current.baseMode);
      telegramUiStacks.delete(runner as object);
    }
  };
}

async function runWithTelegramUi<T>(deps: {
  session: CapturedAgentSession;
  ui: ExtensionUIContext;
  turn: TelegramTurn;
  run: () => Promise<T>;
  /**
   * Who answers the prompts raised inside `run` (§4.2.6 item 2):
   * - `"host"`: the host UI draws them, so the terminal can answer and the
   *   DialogBroker presents them here. Used whenever the broker is live, which
   *   is what keeps both ends able to answer one dialog.
   * - `"telegram-native"` (default): the plugin answers them in Telegram, which
   *   is what the plugin's own flows need.
   */
  uiMode?: "telegram-native" | "host";
}): Promise<T> {
  // Tool contexts (ask / eval preludes) resolve `ui` from a private store that
  // does not follow the runner's setUIContext on every host, so install the
  // routing wrappers regardless; they pass straight through when no Telegram
  // turn is active.
  installToolUiRouting(deps.session);
  const hostPrompts = deps.uiMode === "host";
  const restore = pushTelegramUiContext(
    deps.session.extensionRunner,
    deps.ui,
    deps.turn,
    hostPrompts ? (baseUi) => createHostPromptUi(baseUi, deps.ui) : undefined,
  );
  try {
    return await deps.run();
  } finally {
    restore();
  }
}

/** One quiet window before a command scope releases the UI swap; longer than
 * pi-goal's 50ms CONTINUATION_IDLE_RETRY_MS so a scheduled continuation gets a
 * chance to start before the chain is judged drained. */
const ENQUEUE_HOLD_WINDOW_MS = 120;

/**
 * Hold the Telegram UI swap across a command's enqueued agent turns (§4.2.6).
 *
 * pi-goal-style commands enqueue the turn and return immediately; the extension
 * schedules continuation turns 50ms after a turn ends. After each idle we wait
 * one window longer than that retry interval: a chain that is still running
 * keeps the swap (so its `ctx.ui.select/confirm/input` dialogs and their output
 * stay attributed to the chat), a drained chain hands the terminal back.
 *
 * Only holds when the agent was idle before the command arrived, so a locally
 * streamed turn is never hijacked. Shared by the native command handler and the
 * CommandGateway.
 */
async function holdThroughEnqueuedTurns(ctx: unknown, wasIdle: boolean): Promise<void> {
  if (!wasIdle) return;
  const runner = ctx as { isIdle?(): boolean; waitForIdle?(): Promise<unknown> } | undefined;
  if (!runner || typeof runner.isIdle !== "function" || typeof runner.waitForIdle !== "function") return;
  const idle = () => runner.isIdle!();
  const wait = () => runner.waitForIdle!();
  try {
    for (;;) {
      await wait();
      await new Promise((r) => setTimeout(r, ENQUEUE_HOLD_WINDOW_MS));
      if (idle()) break;
    }
  } catch (err) {
    // Session disposed / torn down during the wait — nothing to do but log.
    ctrlLog.debug("waitForIdle during enqueued turn interrupted", { err });
  }
}

// Host-control and terminal-only mappings (§9 decisions 21/22, §4.8): these run the
// plugin's native handler instead of submitting to the host editor - editor
// submission reloads the extension runtime outside pi's withSession sequencing.
// copy/hotkeys/quit/exit are terminal-only mappings (stage 4 revisits them).
const NATIVE_HANDLER_COMMANDS: Record<string, true> = {
  new: true, reload: true, import: true,
  copy: true, hotkeys: true, quit: true, exit: true,
};

/** Plugin-owned bot-management commands: reachable even when the host bridge is down (v6 decision 48). */
const PLUGIN_LOCAL_COMMANDS: Record<string, true> = {
  tg: true, stop: true, cwd: true, cd: true, status: true, pair: true, more: true,
};

// /more overflow keyboard: 30 command buttons per page, three per row.
const MORE_PAGE_SIZE = 30;
const MORE_ROW_SIZE = 3;

const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*[rf]|--recursive|--force)\b/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bkill(?:all)?\s+-[0-9]/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\b(chown|chgrp)\s+-R\b/i,
  /\bcurl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i,
  /\bwget\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i,
  />\s*\/dev\/(?:sd|disk|nvme)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\btruncate\s+-s\s*0\b/i,
  /\b(?:diskutil|fdisk|parted)\b/i,
];

type BashAbort = () => unknown;

function readBashAbort(session: CapturedAgentSession): BashAbort | undefined {
  const candidate = (session as unknown as Record<string, unknown>).abortBash;
  return typeof candidate === "function" ? candidate as BashAbort : undefined;
}

function isBashRunning(session: CapturedAgentSession): boolean {
  return (session as unknown as Record<string, unknown>).isBashRunning === true;
}

function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

/** Text that must not be swallowed by a dialog: shell input and slash commands. */
function isDialogExemptText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("!")) return true;
  return parseLeadingCommand(trimmed) !== undefined;
}

export function createTelegramController(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  ui: TelegramUiRuntime;
  authorizeUser(userId: number | undefined, text?: string): Promise<boolean | "paired">;
  setActiveChatId(chatId: number): Promise<void>;
  getBotUsername(): string | undefined;
  telegramCommands: Map<string, TelegramCommandHandler>;
  getActiveTurn(chatId: number, messageThreadId?: number): TelegramTurn | undefined;
  /** Active turns oldest first, for dialog ownership (§4.3 rule 2). */
  getActiveTurns?(): TelegramTurn[];
  beginTelegramTurn(chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number): TelegramTurn | undefined;
  endTelegramTurn(chatId: number, turn: TelegramTurn): void;
  saveIncomingTelegramAttachment?: (fileId: string, fileName: string | undefined, kind: string) => Promise<string>;
  getConfig?: () => TelegramConfig;
  tuiBridge?: TuiBridgeAdapter;
  /** Host-family probe; overridable for tests. Defaults to the live module check. */
  isOmpHost?: () => boolean;
  isTelegramActive?: () => boolean;
  /** Host control API for /new; overridable for tests. */
  newSession?: (origin: { chatId: number; messageThreadId?: number; sourceMessageId?: number }) => Promise<{ cancelled?: boolean } | void>;
  /** Shared secret store (§4.7.4); a private one is created when absent (tests). */
  secrets?: SecretStore;
}): TelegramController {
  const targetKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  const bridge = deps.tuiBridge ?? defaultTuiBridge;
  // §0.1: when the startup version gate refused the host, the outage notice
  // names the version problem instead of the generic "run interactively" hint.
  const bridgeOutageNotice = (): string => {
    const reason = bridge.getUnsupportedReason?.();
    if (reason !== undefined) return `${reason.replace(/\.$/, "")}. The plugin has stopped.`;
    return `The host bridge is unavailable (${bridge.getHost()}), so the plugin cannot work. Run pi/OMP interactively in a terminal.`;
  };
  const hostIsOmp = deps.isOmpHost ?? isOmpHost;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const focusTracker = new FocusTracker();
  const originTracker = new OriginTracker({
    isEditorFocused: () => {
      const current = focusTracker.current();
      return current.kind === "unknown" ? bridge.isEditorFocused() : focusTracker.isEditor();
    },
    readDraft: () => {
      const reader = bridge.readEditorText;
      return reader ? reader.call(bridge) : readHostEditorText();
    },
    writeDraft: (text) => {
      const writer = bridge.writeEditorText;
      return writer ? writer.call(bridge, text) : writeHostEditorText(text);
    },
    // F2: keep a "!" scope alive while the host's bash component is still
    // running, so its final output is pushed after the command finishes.
    // `outputCapture` is built below; the closure resolves it by call time.
    holdOpen: (): boolean => outputCapture.hasRunningBash(),
  });
  const secretStore = deps.secrets ?? new SecretStore();
  const outputCapture = new OutputCapture(deps.transport, originTracker, secretStore);
  const commandGateway = new CommandGateway({
    bridge,
    origin: originTracker,
    output: outputCapture,
    focus: focusTracker,
    isEnabled: () => true,
    readDraft: () => {
      const reader = bridge.readEditorText;
      return reader ? reader.call(bridge) : readHostEditorText();
    },
    writeDraft: (text) => {
      const writer = bridge.writeEditorText;
      return writer ? writer.call(bridge, text) : writeHostEditorText(text);
    },
    newSession: deps.newSession ?? (async (origin) => {
      const session = deps.getSession();
      if (!session) return { cancelled: true };
      const ctx = session.extensionRunner.createCommandContext();
      const create = (ctx as unknown as { newSession?: (options?: unknown) => Promise<{ cancelled?: boolean }> } | undefined)?.newSession;
      if (!create) return { cancelled: true };
      const telegramUi = deps.ui.create(origin.chatId, origin.messageThreadId, origin.sourceMessageId);
      const turn = deps.getActiveTurn(origin.chatId, origin.messageThreadId)
        ?? { chatId: origin.chatId, messageThreadId: origin.messageThreadId, sourceMessageId: origin.sourceMessageId, queuedAttachments: [] };
      return runWithTelegramTurn(turn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn,
        run: async () => await create.call(ctx, { withSession: async () => undefined }),
      }));
    }),
  });
  commandGateway.start();

  const dialogBroker = new DialogBroker({
    transport: deps.transport,
    focus: focusTracker,
    origin: originTracker,
    secrets: secretStore,
    activeChatId: () => deps.getConfig?.().activeChatId,
    activeTurns: () => deps.getActiveTurns?.() ?? [],
    writeText: (text) => bridge.write(text),
    settleScope: (scope) => outputCapture.settleAfterDialog(scope),
    // One switch for both (§9 decision 27): the broker may only track a host whose
    // dialogs it can actually read. A host without a usable bridge has no focus to
    // track anyway, and OMP's components render in an overlay without focus, so
    // there it must stay completely inert - see hostOwnsPrompts.
    enabled: () => hostOwnsPrompts(bridge),
  });
  dialogBroker.start();
  // Output too long for the command's message is paged on it by the broker.
  outputCapture.attachPager((target, title, html) => dialogBroker.showPaged(target, title, html));

  /**
   * §4.2.6 item 2: while the DialogBroker is live, prompts raised by work this
   * chat started belong to the host UI - a terminal user can answer them and
   * the Broker presents them here, so neither end is locked out. Everywhere
   * else - and on hosts whose dialogs the broker cannot read yet - the plugin
   * keeps answering them in Telegram. See hostOwnsPrompts for the full condition.
   */
  const promptUiMode = (): "telegram-native" | "host" =>
    (hostOwnsPrompts(bridge) ? "host" : "telegram-native");

  const BASH_BUSY_TEXT = "⚠️ A bash command is already running. Wait for it to finish, or send /stop to cancel it.";
  // True from just before the `!` submit until the gateway call returns. The host
  // sets session.isBashRunning only some ~60ms after the submit starts, so this
  // flag covers that window for concurrently handled Telegram messages.
  let bashSubmitInFlight = false;

  const runTelegramBash = async (
    command: string,
    excludeFromContext: boolean,
    chatId: number,
    messageThreadId: number | undefined,
    sourceMessageId: number | undefined,
    userId: number | undefined,
    chatType: string | undefined,
  ): Promise<void> => {
    if (chatType && chatType !== "private") {
      await deps.transport.sendText(chatId, "Shell commands are only allowed in private chats.", messageThreadId, sourceMessageId);
      return;
    }
    if (!command) {
      await deps.transport.sendText(chatId, "Usage: !<command> (or !!<command> to exclude output from context).", messageThreadId, sourceMessageId);
      return;
    }

    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "Shell execution is not available in this session.", messageThreadId, sourceMessageId);
      return;
    }

    // Same rule as the TUI: while a bash command is running, a new `!` is
    // refused here, before any confirmation and before the gateway opens a
    // scope for it (otherwise the running command's output lands on this one).
    if (isBashRunning(session) || bashSubmitInFlight) {
      await deps.transport.sendText(chatId, BASH_BUSY_TEXT, messageThreadId, sourceMessageId);
      return;
    }

    const policy: TelegramBashConfirm = deps.getConfig?.().bashConfirm ?? "dangerous";
    if (policy === "always" || (policy === "dangerous" && isDangerousBash(command))) {
      const confirmUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
      const approved = await confirmUi.confirm(
        "Run shell command?",
        `${command}\n\ncwd: ${process.cwd()}\ncontext: ${excludeFromContext ? "excluded" : "included"}`,
      );
      if (!approved) {
        await deps.transport.sendText(chatId, "Shell command cancelled.", messageThreadId, sourceMessageId);
        return;
      }
    }

    // D3b (decision 51): the host editor executes. The raw `!`/`!!` text is
    // submitted through the gateway exactly like a host slash command; the
    // host's own user_bash pipeline decides context inclusion and runs the
    // command, and OutputCapture returns the BashExecutionComponent's final
    // render to the ack message.
    // A confirmation may have taken a while; re-check before submitting.
    if (isBashRunning(session) || bashSubmitInFlight) {
      await deps.transport.sendText(chatId, BASH_BUSY_TEXT, messageThreadId, sourceMessageId);
      return;
    }
    const text = `${excludeFromContext ? "!!" : "!"}${command}`;
    let submitted: boolean;
    bashSubmitInFlight = true;
    try {
      submitted = await commandGateway.runText({
        text,
        label: "!",
        origin: { chatId, messageThreadId, sourceMessageId },
        transport: deps.transport,
      });
    } finally {
      bashSubmitInFlight = false;
    }
    if (!submitted) {
      await deps.transport.sendText(chatId, "Shell execution is not available in this session.", messageThreadId, sourceMessageId);
      return;
    }
    ctrlLog.info("telegram bash submitted", {
      chatId,
      userId,
      cwd: process.cwd(),
      text,
      excludeFromContext,
    });
  };

  // Per chat/thread prompt queues: each Telegram topic chains independently.
  // A queue entry is the "taken" signal of its message, not the whole turn.
  const promptTails = new Map<string, Promise<void>>();
  // Increasing generation per chat/thread lets stop invalidate pending queue items.
  const interruptGenerationByTarget = new Map<string, number>();

  // Resolves once the host has taken the message: the prompt settled, or the
  // session is streaming (checked right away, then every 25 ms). Needed because
  // session.prompt() resolves only when the whole turn ends on both hosts.
  // A rejected prompt was not taken: it only stops polling and never resolves,
  // so a retry in deliverToMainThread keeps the next message behind it.
  type TakenSignal = (taken: Promise<void>) => void;
  const whenTaken = (session: { readonly isStreaming: boolean }, promptPromise: Promise<unknown>): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const stop = () => {
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
      };
      const poll = () => {
        if (finished) return;
        if (session.isStreaming) {
          stop();
          resolve();
          return;
        }
        timer = setTimeout(poll, 25);
      };
      promptPromise.then(() => {
        stop();
        resolve();
      }, stop);
      poll();
    });
  // Calls session.prompt and reports to onTaken while still returning the prompt
  // promise, so the caller awaits the turn exactly as before.
  const promptAndSignal = (session: CapturedAgentSession, text: string, opts: Record<string, unknown>, onTaken: TakenSignal): Promise<unknown> => {
    const promptPromise = Promise.resolve(session.prompt(text, opts as any));
    onTaken(whenTaken(session, promptPromise));
    return promptPromise;
  };

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

  // Main-mode delivery: wait until the main loop is idle, then submit a plain
  // prompt (no streamingBehavior) so core starts a fresh main-thread turn.
  // While background workflow agents run, session.isStreaming stays true and
  // core rejects plain prompts; steer/followUp would drain into a workflow
  // agent's turn instead (repo issue #10).
  const deliverToMainThread = async (text: string, chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined, onTaken: TakenSignal): Promise<void> => {
    const session = deps.getSession();
    if (!session) return;
    const ctx = session.extensionRunner.createCommandContext();
    const idleFn = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle : undefined;
    const waitFn = typeof (ctx as any).waitForIdle === "function" ? (ctx as any).waitForIdle : undefined;

    let heldNoticeSent = false;
    const sendHeldNotice = async (): Promise<void> => {
      if (heldNoticeSent) return;
      heldNoticeSent = true;
      await deps.transport.sendText(
        chatId,
        "⏳ π is busy — holding your message until the main thread is idle.",
        messageThreadId,
        sourceMessageId,
      ).catch(ctrlLog.swallow("warn", "sendText held-notice failed", { chatId, messageThreadId, sourceMessageId }));
    };

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const maxDeliveryAttempts = 20;
    for (let attempt = 0; attempt < maxDeliveryAttempts; attempt += 1) {
      if (session.isStreaming) {
        await sendHeldNotice();
        if (waitFn) {
          try {
            await waitFn.call(ctx);
          } catch (err) {
            // Session disposed / torn down during the wait — nothing to deliver to.
            ctrlLog.debug("waitForIdle during main-delivery hold interrupted", { chatId, messageThreadId, err });
            return;
          }
        } else {
          await sleep(500);
        }
        // Settle window: pi-goal schedules continuation turns via
        // setTimeout(0 / 50ms) after a turn ends. Yield one macrotask window
        // so the loop only proceeds when the stream stays idle.
        await sleep(120);
        // A main turn (e.g. a goal continuation) started while we waited —
        // behave like the terminal and steer into it instead of holding.
        if (idleFn && !idleFn.call(ctx)) {
          await promptAndSignal(session, text, { source: "interactive", streamingBehavior: busyStreamingBehavior() }, onTaken);
          return;
        }
        continue;
      }
      try {
        await promptAndSignal(session, text, { source: "interactive" }, onTaken);
        return;
      } catch (err) {
        // A goal continuation or workflow step may have started between our
        // idle check and prompt dispatch. Loop and wait again.
        ctrlLog.debug("main-delivery prompt raced with a new turn; waiting again", { chatId, messageThreadId, attempt, err });
        await sleep(120);
      }
    }
    await reportPromptFailure("main-delivery", chatId, messageThreadId, sourceMessageId, new Error("main-mode delivery attempts exhausted"));
  };

  // Hold-and-deliver path shared by "main" and idle-"tui": wait until the
  // main loop is idle, then submit a plain prompt so the message always
  // starts a fresh main-thread turn.
  const runMainDelivery = async (text: string, chatId: number, replaceMessageId: number | undefined, messageThreadId: number | undefined, sourceMessageId: number | undefined, onTaken: TakenSignal) => {
    const turn = deps.beginTelegramTurn(chatId, replaceMessageId, messageThreadId, sourceMessageId);
    if (!turn) {
      // Target already has an active turn — reject with a busy message.
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "⏳ π is busy. Try again shortly.");
      else await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", messageThreadId, sourceMessageId);
      return;
    }
    const session = deps.getSession();
    if (!session) return;
    const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
    try {
      await runWithTelegramTurn(turn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn,
        uiMode: promptUiMode(),
        run: () => deliverToMainThread(text, chatId, messageThreadId, sourceMessageId, onTaken),
      }));
    } finally {
      deps.endTelegramTurn(chatId, turn);
    }
  };

  // Delivery while the main loop is busy: "steer" injects into the running
  // turn, "queue" (messageMode) sends a follow-up after it ends. Read per call
  // so a switch in the Config menu applies to the next message.
  const busyStreamingBehavior = (): "steer" | "followUp" => (deps.getConfig?.().messageMode ?? "steer") === "queue" ? "followUp" : "steer";

  const runPrompt = async (text: string, chatId: number, replaceMessageId: number | undefined, messageThreadId: number | undefined, sourceMessageId: number | undefined, onTaken: TakenSignal) => {
    const session = deps.getSession();
    if (!session) {
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "π session is not ready yet.");
      else await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return;
    }

    // TUI parity: a message behaves exactly like typing in the terminal.
    // While the main loop runs its own turn, steer into it; while background
    // agents run with the main loop idle, hold and deliver a plain prompt once
    // the main loop settles. ctx.isIdle() distinguishes the two —
    // session.isStreaming alone cannot (it stays true for background runs).
    let mainBusy = session.isStreaming;
    try {
      const probeCtx = session.extensionRunner.createCommandContext();
      const idleFn = typeof (probeCtx as any).isIdle === "function" ? (probeCtx as any).isIdle : undefined;
      mainBusy = idleFn ? !idleFn.call(probeCtx) : session.isStreaming;
    } catch {
      mainBusy = session.isStreaming;
    }
    const isSteer = mainBusy;

    // While the main loop is idle, hold the message until it settles, then
    // submit a plain prompt so the message always starts a fresh main-thread
    // turn; it is never steered or queued into a background workflow agent's
    // turn.
    if (!mainBusy) {
      await runMainDelivery(text, chatId, replaceMessageId, messageThreadId, sourceMessageId, onTaken);
      return;
    }

    // Main loop busy: reuse the existing active turn for this chat/thread, in
    // both steer and queue mode. Messages go into the running stream and must
    // not acquire a new turn (which would fail since the target is already busy).
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
            uiMode: promptUiMode(),
            run: async () => {
              // Goal auto-continuations can be streaming without owning an
              // active TelegramTurn. Keep the delivery behavior tied to the
              // configured messageMode rather than to our renderer bookkeeping.
              await promptAndSignal(session, text, { source: "interactive", streamingBehavior: busyStreamingBehavior() }, onTaken);
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
        uiMode: promptUiMode(),
        run: () => promptAndSignal(session, text, { source: "interactive", streamingBehavior: busyStreamingBehavior() }, onTaken),
      }));
      return;
    }
  };

  const submitText = async (text: string, chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => {
    // Chain behind the previous prompt for this chat/thread so multiple
    // messages are delivered to the main thread in order.
    const key = targetKey(chatId, messageThreadId);
    const generation = getInterruptGeneration(key);
    // The next message for this chat/thread starts once this one is taken by the
    // host (or this one finished for any reason), not when its turn ends.
    let markTaken: () => void = () => undefined;
    const taken = new Promise<void>((resolve) => { markTaken = resolve; });
    const onTaken: TakenSignal = (signal) => { void signal.then(markTaken); };
    void getOrCreateTail(key)
      .then(() => {
        if (generation !== getInterruptGeneration(key)) return;
        return runPrompt(text, chatId, replaceMessageId, messageThreadId, sourceMessageId, onTaken);
      })
      .catch((err) => reportPromptFailure("prompt-delivery", chatId, messageThreadId, sourceMessageId, err))
      .finally(markTaken);
    setTail(key, taken);
  };

  // §4.5 rule 6: a command arriving while a dialog is still waiting is the remote user
  // abandoning it - the host queues every later command behind an open dialog, so press Esc
  // for them and say so, otherwise the chat only ever sees a timeout. A question belonging to
  // another chat, or to the terminal, is not this chat's to discard: report it as a blocker
  // and "blocked" so the caller answers the user instead of submitting a command that would
  // only queue behind it for 30 seconds.
  const settleOpenDialog = (chatId: number, messageThreadId?: number, sourceMessageId?: number): "proceed" | "blocked" => {
    const abandoned = dialogBroker.abandonFor(chatId, messageThreadId);
    if (abandoned.kind === "blocked") {
      void deps.transport
        .sendText(chatId, "The terminal has an unanswered dialog. Answer it there first, or send /stop.", messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("debug", "sendText blocked-dialog notice failed", { chatId }));
      return "blocked";
    }
    if (abandoned.kind === "closed" && abandoned.title !== undefined) {
      void deps.transport
        .sendText(chatId, `⚠️ Closed the unanswered dialog: <b>${escapeHtml(abandoned.title)}</b>`, messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("debug", "sendText abandoned-dialog notice failed", { chatId }));
    }
    return "proceed";
  };

  /** Sends a command's ack message and binds the command's output to it (the gateway's ack, for extension commands). */
  const bindCommandAck = async (scope: CommandScope, text: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<void> => {
    const ackHtml = `<b>▶️ ${escapeHtml(text)}</b>`;
    const sent = await deps.transport.sendText(chatId, ackHtml, messageThreadId, sourceMessageId)
      .catch(ctrlLog.swallow("debug", "sendText command ack failed", { chatId }));
    const messageId = sent?.[0]?.message_id;
    if (messageId === undefined) return;
    scope.telegramMessageId = messageId;
    outputCapture.bind(scope, { chatId, messageThreadId, messageId, ackHtml });
  };

  const runCommandHandler = (handler: TelegramCommandHandler, args: string, session: CapturedAgentSession, chatId: number, messageThreadId?: number, sourceMessageId?: number, label = "command", ackMessage = false) => {
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
    // Whether the host - rather than the plugin - answers prompts raised by this
    // command's own work (§4.2.6 item 2).
    const hostPrompts = promptUiMode() === "host";
    // §4.3 rule 1: while a Telegram-issued command runs, the dialogs it opens
    // belong to this chat. Without a scope the broker tracks them silently
    // (§4.3 rule 3) and the chat is left with a raw key mirror - no typed
    // input, no secret handling, no keyboard withdrawal when it closes.
    const scope = hostPrompts
      ? originTracker.begin({ chatId, messageThreadId, sourceMessageId }, label, "", "")
      : undefined;
    // Settle this chat's own open dialog before the handler runs; when the question belongs
    // elsewhere the command is not submitted and the scope ends as failed.
    if (scope && settleOpenDialog(chatId, messageThreadId, sourceMessageId) === "blocked") {
      originTracker.end(scope, "error");
      return;
    }
    // In telegram-native mode the command's own prompts (e.g. /new's confirm) are pinned
    // to the Telegram UI, and a host with no UI-context setter needs the same treatment
    // because there is no routed proxy to lean on. In host mode the host answers, and its
    // context still exposes the plugin's `menu` affordance (see createHostPromptUi).
    //
    // Host mode still has to hand the command context a *routed* ui: the context's own `ui`
    // is the host's raw one, whose `notify` only prints in the terminal, so a command that
    // just reports something (`/changelog`, `/copy`, `/debug`) left the chat with nothing at
    // all. The routed proxy keeps every prompt with the host and copies notifications to the
    // chat, which is the whole point of running the command here.
    const hostCommandUi = (ctx as { ui?: unknown }).ui;
    const commandCtx = hostPrompts && hostCommandUi
      ? withUiContext(ctx, createHostPromptUi(hostCommandUi, telegramUi))
      : typeof session.extensionRunner.setUIContext === "function" || hostPrompts
        ? ctx
        : withUiContext(ctx, telegramUi);
    // Capture idleness BEFORE the handler runs. Commands like /sisyphus and
    // /goals enqueue the agent turn fire-and-forget via pi.sendUserMessage and
    // return immediately; the actual turn (and any goal_question /
    // propose_goal_draft / goal_questionnaire dialogs it raises) runs AFTER the
    // handler resolves. If we let runWithTelegramUi restore the TUI UI at that
    // point, those dialogs render to the local TUI and Telegram gets nothing.
    // Only hold the swap when the agent was idle when the command arrived: if a
    // local turn was already streaming, holding the swap would hijack the local
    // user's TUI (modals would route to Telegram, editor would no-op).
    const wasIdle = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle.call(ctx) : false;
    const commandTurn = deps.getActiveTurn(chatId, messageThreadId) ?? { chatId, messageThreadId, sourceMessageId, queuedAttachments: [] };
    // An extension command with a scope gets one message of its own, its ack, as the gateway
    // gives host commands: its notices and dialogs land there (one command, one message).
    const ackSent = ackMessage && scope ? bindCommandAck(scope, `/${label}${args ? ` ${args}` : ""}`, chatId, messageThreadId, sourceMessageId) : undefined;
    void runWithTelegramTurn(commandTurn, () => runWithTelegramUi({
      session,
      ui: telegramUi,
      turn: commandTurn,
      // With the broker live the host owns the prompt: a command's own dialog
      // (an extension's `ui.select`, a `/goals` confirmation) renders in the
      // terminal, so the terminal user can answer it too. The scope above makes
      // the broker attribute it to this chat, and the broker's keyboard is the
      // one the chat sees - no screen mirror, which could not take typed text,
      // hide a secret answer, or withdraw itself once the terminal answered.
      uiMode: promptUiMode(),
      run: async () => {
        try {
          await ackSent;
          await (ackSent && scope ? runInCommand(scope, () => handler(args, commandCtx)) : handler(args, commandCtx));
          await holdThroughEnqueuedTurns(ctx, wasIdle);
        } finally {
          // The scope deliberately outlives the handler: a dialog answered a
          // moment later still belongs to this chat, and the tracker ends the
          // scope only once focus is back in the editor and output went quiet.
          if (scope) originTracker.markSubmitDone(scope);
        }
      },
    })).catch(async (err) => {
      ctrlLog.warn("telegram command handler failed", { chatId, messageThreadId, err });
      await deps.transport.sendText(chatId, `⚠️ Command failed:\n${commandErrorMessage(err)}`, messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("warn", "sendText command-failure notice failed", { chatId, messageThreadId }));
    });
  };

  const menuOverflow = (): Array<{ command: string; description: string }> => {
    const config = deps.getConfig?.();
    return getTelegramMenuOverflow(config?.botToken, config?.apiBase);
  };

  const moreKeyboard = (page: number): { text: string; rows: TelegramButton[][] } => {
    const overflow = menuOverflow();
    const pageCount = Math.max(1, Math.ceil(overflow.length / MORE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const slice = overflow.slice(safePage * MORE_PAGE_SIZE, (safePage + 1) * MORE_PAGE_SIZE);
    const rows: TelegramButton[][] = [];
    for (let i = 0; i < slice.length; i += MORE_ROW_SIZE) {
      rows.push(slice.slice(i, i + MORE_ROW_SIZE).map((entry) => ({
        text: `/${entry.command}`,
        value: encodeRunCallback(entry.command),
      })));
    }
    if (pageCount > 1) {
      const nav: TelegramButton[] = [];
      if (safePage > 0) nav.push({ text: "◀️", value: encodeMoreCallback(safePage - 1) });
      nav.push({ text: `${safePage + 1} / ${pageCount}`, value: encodeMoreCallback(safePage) });
      if (safePage < pageCount - 1) nav.push({ text: "▶️", value: encodeMoreCallback(safePage + 1) });
      rows.push(nav);
    }
    return { text: `More commands (${overflow.length} beyond the BotMenu) — tap one to run it.`, rows };
  };

  const dispatchNamedCommand = async (
    name: string,
    args: string,
    session: CapturedAgentSession,
    chatId: number,
    messageThreadId?: number,
    sourceMessageId?: number,
  ): Promise<boolean> => {
    // v6 (decision 48): no bridge, no path to the host. Host-facing commands answer
    // with the fixed outage notice instead of silently falling back; plugin-owned
    // bot management stays available.
    if (!bridge.isAvailable() && !PLUGIN_LOCAL_COMMANDS[name]) {
      await deps.transport.sendText(chatId, bridgeOutageNotice(), messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("warn", "sendText bridge outage notice failed", { chatId }));
      return true;
    }

    // The flat /tg-* commands were removed; /tg is the only management entry.
    // Telegram rewrites '-' to '_' in command names, so both prefixes are the
    // same command. Answer unknown tg commands here instead of forwarding them
    // to the host as prompt text. A plugin handler or host-served command that
    // still owns a tg- name wins over the notice.
    if ((name.startsWith("tg-") || name.startsWith("tg_")) && !deps.telegramCommands.has(name)) {
      const candidates = new Set([name, name.replace(/_/g, "-"), name.replace(/-/g, "_")]);
      const catalog = await bridge.getCommands().catch(() => []);
      const served = catalog.some((command) => candidates.has(command.name)
        || (command.aliases ?? []).some((alias) => candidates.has(alias)));
      const external = session.extensionRunner.getCommand(name)
        ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
        ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
      if (!served && !external) {
        await deps.transport.sendText(chatId, "Unknown command. Use /tg.", messageThreadId, sourceMessageId)
          .catch(ctrlLog.swallow("warn", "sendText unknown-command notice failed", { chatId }));
        return true;
      }
    }

    // /more opens the overflow keyboard for this bot's menu. Only claimed when
    // an overflow exists, so a user-registered /more keeps working otherwise.
    if (name === "more" && menuOverflow().length > 0) {
      const { text, rows } = moreKeyboard(0);
      await deps.transport.sendButtons(chatId, text, rows, messageThreadId, sourceMessageId);
      return true;
    }

    const handler =
      deps.telegramCommands.get(name)
      ?? deps.telegramCommands.get(name.replace(/_/g, "-"))
      ?? deps.telegramCommands.get(name.replace(/-/g, "_"));

    // Plugin-owned commands stay plugin-local even when the host catalog also
    // lists the name (v6 decision 48).
    if (PLUGIN_LOCAL_COMMANDS[name] && handler) {
      ctrlLog.debug("command route", { name, route: "plugin-local" });
      recordCommandUsage(name);
      await runCommandHandler(handler, args, session, chatId, messageThreadId, sourceMessageId, name);
      return true;
    }

    // Host control and terminal-only mappings (§9 decisions 21/22, §4.8). pi's /new
    // is the exception the gateway still owns: it calls the host's
    // ctx.newSession() control API (runNewSession) instead of editor submission.
    if (NATIVE_HANDLER_COMMANDS[name] && handler) {
      if (name === "new" && !hostIsOmp()) {
        // §4.5 rule 6: the gateway submits to the host editor, which queues behind any open
        // dialog - settle this chat's dialog first, and never submit behind another's.
        if (settleOpenDialog(chatId, messageThreadId, sourceMessageId) === "blocked") {
          ctrlLog.debug("command route", { name, route: "blocked-by-dialog" });
          return true;
        }
        const handled = await commandGateway.run({
          name,
          args,
          origin: { chatId, messageThreadId, sourceMessageId },
          transport: deps.transport,
        });
        if (handled) {
          ctrlLog.debug("command route", { name, route: "gateway-new" });
          recordCommandUsage(name);
          return true;
        }
      }
      ctrlLog.debug("command route", { name, route: "telegram-handler" });
      recordCommandUsage(name);
      await runCommandHandler(handler, args, session, chatId, messageThreadId, sourceMessageId, name);
      return true;
    }

    const externalCommand =
      session.extensionRunner.getCommand(name)
      ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
      ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
    if (externalCommand) {
      ctrlLog.debug("command route", { name, route: "extension-command" });
      recordCommandUsage(name);
      await runCommandHandler(externalCommand.handler, args, session, chatId, messageThreadId, sourceMessageId, name, true);
      return true;
    }

    // Every other command the host serves goes to the gateway (§0.1 #4): the
    // host executes it, OutputCapture returns the output and the Broker owns
    // any dialog it raises.
    const candidates = new Set([name, name.replace(/_/g, "-"), name.replace(/-/g, "_")]);
    const catalog = await bridge.getCommands().catch(() => []);
    const served = catalog.find((command) => candidates.has(command.name)
      || (command.aliases ?? []).some((alias) => candidates.has(alias)));
    if (served) {
      // §4.5 rule 6: same as the /new gateway path above.
      if (settleOpenDialog(chatId, messageThreadId, sourceMessageId) === "blocked") {
        ctrlLog.debug("command route", { name, route: "blocked-by-dialog" });
        return true;
      }
      // Telegram cannot spell `-` in a command name, so `scoped-models` is advertised as
      // `scoped_models`. The host only knows its own spelling: submit that one.
      const handled = await commandGateway.run({
        name: served.name,
        args,
        origin: { chatId, messageThreadId, sourceMessageId },
        transport: deps.transport,
      });
      if (handled) {
        ctrlLog.debug("command route", { name, route: "gateway" });
        recordCommandUsage(name);
        return true;
      }
    }
    return false;
  };

  const tryHandleSlashCommand = async (text: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<boolean> => {
    const parsed = parseLeadingCommand(text);
    if (!parsed) return false;
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return true;
    }
    return await dispatchNamedCommand(parsed.name.toLowerCase(), parsed.args, session, chatId, messageThreadId, sourceMessageId);
  };

  return {
    async handleCallbackQuery(query) {
      const chatId = query.message?.chat?.id;
      if (typeof chatId !== "number") return;
      const messageThreadId = query.message?.message_thread_id;
      const sourceMessageId = query.message?.message_id;
      if (!(await deps.authorizeUser(query.from?.id))) return;
      await deps.setActiveChatId(chatId);

      const data = query.data ?? "";
      // Dialog buttons are answered here and nowhere else (§4.5 rule 3). This
      // branch runs before the generic acknowledgement because the toast has to
      // travel inside the same answerCallbackQuery call. Anything carrying the
      // dialog prefix belongs to a dialog - even a payload that no longer
      // decodes, because submitted as text it would run as a prompt.
      if (data.startsWith(DIALOG_CALLBACK_PREFIX)) {
        const dialogCallback = decodeDialogCallback(data);
        const result = dialogCallback === undefined
          ? { handled: true, toast: "This menu has expired", clear: true }
          : dialogBroker.handleCallback(chatId, messageThreadId, dialogCallback);
        await deps.transport.answerCallbackQuery(query.id, result.toast)
          .catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
        const pageMessageId = query.message?.message_id;
        if (result.clear && pageMessageId !== undefined) {
          await deps.transport.removeInlineKeyboard(chatId, pageMessageId)
            .catch(ctrlLog.swallow("debug", "removeInlineKeyboard dialog keyboard failed", { chatId }));
        }
        return;
      }
      // The old screen mirror is gone (§0.1 #4): a stale mirror keyboard must
      // never inject keys - the button only gets the expiry notice.
      if (data.startsWith(EXPIRED_TUI_CALLBACK_PREFIX)) {
        await deps.transport.answerCallbackQuery(query.id, "This button has expired")
          .catch(ctrlLog.swallow("debug", "answerCallbackQuery expired-tui failed", { queryId: query.id }));
        const expiredMessageId = query.message?.message_id;
        if (expiredMessageId !== undefined) {
          await deps.transport.removeInlineKeyboard(chatId, expiredMessageId)
            .catch(ctrlLog.swallow("debug", "removeInlineKeyboard expired-tui failed", { chatId }));
        }
        return;
      }

      await deps.transport.answerCallbackQuery(query.id).catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
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

      const morePage = decodeMoreCallback(data);
      if (morePage !== undefined) {
        const pageMessageId = query.message?.message_id;
        if (pageMessageId !== undefined) {
          const { text, rows } = moreKeyboard(Number.parseInt(morePage, 10) || 0);
          await deps.transport.editButtons(chatId, pageMessageId, text, rows).catch(ctrlLog.swallow("debug", "editButtons /more page failed", { chatId }));
        }
        return;
      }

      const runName = decodeRunCallback(data);
      if (runName !== undefined) {
        const session = deps.getSession();
        if (!session) {
          await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
          return;
        }
        const dispatched = await dispatchNamedCommand(runName.toLowerCase(), "", session, chatId, messageThreadId, sourceMessageId);
        if (!dispatched) {
          await deps.transport.sendText(chatId, `/${escapeHtml(runName)} is no longer available.`, messageThreadId, sourceMessageId);
        }
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
      if (trimmed.startsWith("!")) {
        const excludeFromContext = trimmed.startsWith("!!");
        const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
        const busySession = dialogBroker.sessionFor(chatId, messageThreadId);
        if (busySession !== undefined) {
          // §4.2: the dialog owns the keyboard, so the shell command has nowhere
          // to land; say so instead of queueing it behind the dialog.
          await deps.transport.sendText(chatId, dialogBusyNotice(busySession), messageThreadId, sourceMessageId)
            .catch(ctrlLog.swallow("warn", "sendText dialog busy notice failed", { chatId }));
          return;
        }

        void runTelegramBash(
          command,
          excludeFromContext,
          chatId,
          messageThreadId,
          sourceMessageId,
          message.from?.id,
          message.chat?.type,
        ).catch(async (err) => {
          ctrlLog.error("telegram bash failed", { err, chatId, userId: message.from?.id });
          await deps.transport.sendText(
            chatId,
            `Shell command failed: ${escapeHtml(commandErrorMessage(err))}`,
            messageThreadId,
            sourceMessageId,
          ).catch(ctrlLog.swallow("warn", "sendText bash failure failed", { chatId }));
        });
        return;
      }
      if (message.reply_to_message || message.quote || message.text_quote || message.external_reply) logTelegramReplyContext(message);
      if (trimmed === "/stop") {
        // §4.5 rule 6: the dialog gets the Esc first, then the normal /stop path
        // runs (pending input, bash abort, turn interrupt).
        dialogBroker.cancelFor(chatId, messageThreadId);

        // /stop cancellation priority: first try canceling a reply-targeted
        // pending input, then any pending input, then abort the agent turn.
        const cancelResult = deps.ui.resolveInput(chatId, undefined, replyToInput, false, messageThreadId);
        const cancelAnyResult = !cancelResult.handled ? deps.ui.resolveInput(chatId, undefined, undefined, false, messageThreadId) : cancelResult;
        if (cancelAnyResult.handled) {
          if (cancelAnyResult.promptMessageId) void deps.transport.removeInlineKeyboard(chatId, cancelAnyResult.promptMessageId);
          await deps.transport.sendText(chatId, "Cancelled.", messageThreadId, sourceMessageId);
          return;
        }
        const stopSession = deps.getSession();
        if (stopSession && isBashRunning(stopSession)) {
          const abort = readBashAbort(stopSession);
          await Promise.resolve(abort?.()).catch(ctrlLog.swallow("debug", "abortBash from /stop failed"));
          await deps.transport.sendText(chatId, "⏹️ Bash stopped.", messageThreadId, sourceMessageId);
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
      // Only now does a mirrored host dialog get the text (§4.5.1): in the terminal this
      // same message would be a search term or a typed answer. A prompt the plugin raised
      // in this chat is answered above - it waits on a Telegram keyboard *here*, while the
      // mirror only borrows the chat. Without that order a terminal dialog nobody asked
      // about in this chat (an unadapted snapshot, say) swallows the answer the user is
      // typing for the prompt, and the prompt then eats the next message instead.
      const dialogSession = dialogBroker.sessionFor(chatId, messageThreadId);
      ctrlLog.debug("dialog text routing", {
        chatId,
        session: dialogSession !== undefined,
        purpose: dialogSession?.pendingInput?.purpose ?? null,
        modelKind: (dialogSession?.model as { kind?: string } | undefined)?.kind ?? null,
      });
      if (dialogSession !== undefined && message.text !== undefined && !isDialogExemptText(rawText)) {
        const result = dialogBroker.handleText(dialogSession, rawText, message.message_id);
        if (result.handled) {
          if (result.toast !== undefined) {
            await deps.transport.sendText(chatId, result.toast, messageThreadId, sourceMessageId)
              .catch(ctrlLog.swallow("warn", "sendText dialog hint failed", { chatId }));
          }
          return;
        }
        // `handled: false` has two readings: this dialog simply does not take text
        // (a plain list without search, a confirm, a read-only panel), or the broker
        // retired the session because the dialog already left the screen - and then
        // the text is an ordinary prompt again. Ask which one it was. While a dialog
        // still holds the focus, the same message typed in the terminal could not
        // reach the prompt either (decision 54), so queueing a prompt behind it would only
        // bury the next six messages under a dialog nobody answered.
        if (dialogBroker.sessionFor(chatId, messageThreadId) !== undefined) {
          await deps.transport.sendText(chatId, dialogBusyNotice(dialogSession), messageThreadId, sourceMessageId)
            .catch(ctrlLog.swallow("warn", "sendText dialog busy notice failed", { chatId }));
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
          if (!bridge.isAvailable()) {
            await deps.transport.sendText(chatId, bridgeOutageNotice(), messageThreadId, sourceMessageId)
              .catch(ctrlLog.swallow("warn", "sendText bridge outage notice failed", { chatId }));
            return;
          }
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

    async runCommand(name, args, chatId, messageThreadId, sourceMessageId) {
      const session = deps.getSession();
      if (!session) {
        await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
        return;
      }
      await dispatchNamedCommand(name.toLowerCase(), args, session, chatId, messageThreadId, sourceMessageId);
    },

    dispose() {
      dialogBroker.stop();
      commandGateway.dispose();
    },
  };
}
