/**
 * DialogBroker (§4.5): the only place that turns a Telegram tap or text message
 * back into host input.
 *
 * One session at a time. FocusTracker is the authority for *what* owns the
 * keyboard; this file decides whether that counts as a dialog, which adapter
 * reads it, which Telegram message carries it, and when the session is over.
 * First operator wins: whoever answers first — the terminal or Telegram — ends
 * the session, and the other side's buttons stop working.
 *
 * Two rules the rest of the design leans on:
 * - Nothing is remembered about the *list*. A callback carries a page/index
 *   style argument; before anything is executed the live component is read
 *   again and the item is looked up by key. A stale button fails, it never acts
 *   on a different row (§4.5 rule 3).
 * - Nothing is invented. A screen no adapter can model is announced as
 *   unsupported (§4.6.5 #13): the chat gets one plain notice and a cancel
 *   button, never a mirrored frame or a guessed key sequence; if no adapter can
 *   perform an action, the button reports failure rather than guessing.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.ts";
import type { DialogCallback } from "../callback-protocol.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";
import { pickAdapter, unsupportedAdapter } from "./adapters/index.ts";
import { describeTree } from "./adapters/tsp.ts";
import { currentHostState } from "./host.ts";
import { sendKeyTo } from "./keys.ts";
import type { FocusInfo, FocusTracker } from "./focus.ts";
import type {
  AdapterContext,
  DialogAction,
  DialogAdapter,
  DialogItem,
  DialogModel,
  DialogOrigin,
  DialogSession,
} from "./model.ts";
import type { CommandScope, OriginTracker } from "./origin.ts";
import type { SecretStore } from "./secrets.ts";
import { renderDialog, type RenderedDialog } from "./render-telegram.ts";

const brokerLog = log.child("tui-broker");

/**
 * E2E diagnostic (issue #18 inventory): with PITG_TREE_DUMP set to a file path,
 * every dialog read appends the component's described tree and the model the
 * adapter produced as one JSON line. Unset in normal runs, so nothing is written.
 */
const TREE_DUMP = process.env.PITG_TREE_DUMP ? resolve(process.env.PITG_TREE_DUMP) : "";

function dumpDescribedTree(component: Record<string, unknown>, adapterId: string, model: DialogModel): void {
  if (!TREE_DUMP) return;
  try {
    // A repeated object is reported as a cycle; describe trees are plain data, so this only guards the dump.
    const seen = new WeakSet<object>();
    const line = JSON.stringify({ at: Date.now(), adapter: adapterId, component: ctorName(component), tree: describeTree(component), model }, (_key, value: unknown) => {
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return "[cycle]";
      seen.add(value);
      if (typeof (value as { describe?: unknown }).describe === "function") return `[component ${ctorName(value as Record<string, unknown>)}]`;
      return value;
    });
    appendFileSync(TREE_DUMP, `${line}\n`);
  } catch (err) {
    brokerLog.debug("tree dump failed", { err });
  }
}

/** §4.5 rule 2: at most one message edit per chat per second. */
export const EDIT_THROTTLE_MS = 1_000;
/**
 * How often the broker re-reads the open dialog. The host can fill a dialog in the
 * background (`/resume`'s "show all" loads sessions after drawing an empty list), and
 * none of the redraw triggers (Telegram tap/text, focus change) fires for that, so the
 * chat would freeze on a stale frame. `redraw` + `show` keep a no-change poll silent.
 */
export const REFRESH_MS = 1_000;
/** §4.7.1: only the last few generations of button identity are kept. */
const KEEP_GENERATIONS = 3;

export type TextPurpose = "input" | "editor" | "search";

/**
 * The slice of the focus view the broker reads (§4.4). The real FocusTracker
 * satisfies this; naming it here keeps the broker's dependency explicit.
 */
export type FocusSource = Pick<FocusTracker, "onChange" | "current" | "entryFor" | "validate">;

export type BrokerDeps = {
  transport: Pick<
    TelegramTransport,
    "sendButtons" | "editButtons" | "sendText" | "removeInlineKeyboard" | "deleteMessage"
  >;
  focus: FocusSource;
  origin: OriginTracker;
  /** Last chat the user touched; the tie-breaker for dialog ownership (§4.3). */
  activeChatId(): number | undefined;
  /** Active Telegram turns, oldest first; the "UI stack top" of §4.3 rule 2. */
  activeTurns(): TelegramTurn[];
  /** Feed raw text to whatever owns the keyboard (the bridge's input route). */
  writeText(text: string): boolean;
  secrets?: SecretStore;
  /** True while the bridge runs in `full` mode; when off nothing is tracked. */
  enabled(): boolean;
  /** A dialog on an already-ended command's message closed: the output side redraws the
   * message as header + summaries (no "Done"). */
  settleScope?(scope: CommandScope): void;
};

type Owner = {
  origin?: DialogOrigin;
  /** True when the owner is the running command scope (§4.3 rule 1). */
  fromScope: boolean;
  /** Message the scope already owns, to be edited in place (§4.7.3). */
  reuseMessageId?: number;
  /** The running command scope, when it is the owner. */
  scope?: CommandScope;
};

type Placement = { chatId: number; messageThreadId?: number; messageId: number };

type Resolved
  = { kind: "none" }
  | { kind: "page"; page: number }
  | { kind: "text"; purpose: TextPurpose }
  | { kind: "action"; action: DialogAction; label: string };

const targetKey = (target: { chatId: number; messageThreadId?: number }): string =>
  `${target.chatId}:${target.messageThreadId ?? "main"}`;

const sameTarget = (a: { chatId: number; messageThreadId?: number }, b: { chatId: number; messageThreadId?: number }): boolean =>
  a.chatId === b.chatId && (a.messageThreadId ?? undefined) === (b.messageThreadId ?? undefined);

function isDialogKind(kind: FocusInfo["kind"]): boolean {
  return kind === "dialog" || kind === "progress";
}

function activeQuestion(model: Extract<DialogModel, { kind: "questionnaire" }>) {
  const index = Math.max(0, Math.min(model.active, model.questions.length - 1));
  return model.questions[index];
}

/** The items a button can point at, in the view that is currently drawn. */
function activeItems(model: DialogModel): DialogItem[] {
  switch (model.kind) {
    case "select":
      return model.items;
    case "settings":
      // A submenu is nested state of the same session, not a new dialog.
      return model.submenu ? activeItems(model.submenu.model) : model.items;
    case "questionnaire":
      return activeQuestion(model)?.items ?? [];
    case "approval":
      return model.options.map((option) => ({ key: option.key, label: option.label }));
    case "info":
      // A panel's own buttons (describe() action nodes) answer like list rows.
      return (model.actions ?? []).map((action) => ({ key: action.key, label: action.label }));
    default:
      return [];
  }
}

/**
 * Whether a re-read is the *same list* the user was paging through: same kind,
 * same title, same set of clickable keys. The page number belongs to the list
 * it was made for - when the dialog swaps in a different one (`/model`'s model
 * list becoming "Assign ... to"), the chat must go back to the first page.
 * A search filter changes the key set, and page 1 of the filtered result is
 * exactly what the user wants to see, so a changed set resets too; a repaint
 * that only moves a cursor or updates a value keeps the page.
 */
function sameList(previous: DialogModel | undefined, next: DialogModel): boolean {
  if (!previous || previous.kind !== next.kind) return false;
  const previousTitle = "title" in previous ? previous.title : undefined;
  const nextTitle = "title" in next ? next.title : undefined;
  if (previousTitle !== nextTitle) return false;
  const before = [...new Set(activeItems(previous).map((item) => item.key))].sort();
  const after = [...new Set(activeItems(next).map((item) => item.key))].sort();
  return before.length === after.length && before.every((key, index) => key === after[index]);
}

/** Where free text belongs, if it belongs to the dialog at all (§4.5.1). */
export function textPurpose(model: DialogModel): TextPurpose | undefined {
  switch (model.kind) {
    case "input":
      return "input";
    case "editor":
      return "editor";
    case "select":
      return model.search ? "search" : undefined;
    case "settings":
      // A plugin-side submenu may itself be a text input or a multi-select;
      // typed text belongs to whatever the submenu shows.
      if (model.submenu) return textPurpose(model.submenu.model);
      return model.search ? "search" : undefined;
    case "questionnaire":
      return activeQuestion(model)?.allowCustom ? "input" : undefined;
    default:
      return undefined;
  }
}

/** The text field a model asks the user to type into: a top-level field, or the
 * one a settings submenu opened. `secret` is only ever true for an input the
 * host (or OMP's prefs row) marked secret. */
type EffectiveInput = { kind: "input" | "editor"; secret?: boolean };

/**
 * Which field typed text actually belongs to. A settings submenu is nested
 * state of the same dialog (§4.6.4 #5), so a secret token field reached through
 * `Settings ▸ <row>` is the input of this session exactly like a top-level
 * password prompt is - the top-level kind alone says nothing about it.
 */
function effectiveInput(model: DialogModel): EffectiveInput | undefined {
  switch (model.kind) {
    case "input":
      return { kind: "input", secret: model.secret };
    case "editor":
      return { kind: "editor" };
    case "settings":
      return model.submenu ? effectiveInput(model.submenu.model) : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether the text the chat is waiting for is a secret. The `pendingInput` marker
 * is only written when a text field is already on screen at the time it is set,
 * so a dialog that starts as a progress panel and turns into a secret input later
 * has no marker: the model is the source of truth then.
 */
function isSecretSession(session: DialogSession): boolean {
  return session.pendingInput
    ? session.pendingInput.secret === true
    : effectiveInput(session.model)?.secret === true;
}

function findLast<T>(list: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return list[index];
  }
  return undefined;
}

function ctorName(value: Record<string, unknown>): string {
  try {
    return (value as { constructor?: { name?: string } }).constructor?.name ?? "";
  } catch {
    return "";
  }
}

/**
 * What a command arriving from Telegram did to the open dialog (§4.5 rule 6): `closed` names
 * this chat's own question that was just cancelled, `blocked` names a question that belongs to
 * another chat or to the terminal and is holding the host's queue, `nothing` means nothing was
 * in the way.
 */
export type AbandonOutcome =
  | { kind: "closed"; title?: string }
  | { kind: "blocked"; title?: string }
  | { kind: "nothing" };

export class DialogBroker {
  private session?: DialogSession;
  private unsubscribe?: () => void;
  /** chatKey -> ms of the last edit, for the one-edit-per-second cap. */
  private readonly lastEditAt = new Map<string, number>();
  /** One trailing edit per chat: the newest model wins, a queued older one is dropped. */
  private readonly deferred = new Map<string, ReturnType<typeof setTimeout>>();
  /** The background-refresh tick, alive between start() and stop(). */
  private refreshTimer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  /** Sessions drawn on a command's own message, and the scope that owns it. */
  private readonly scopes = new WeakMap<DialogSession, CommandScope>();
  /** Sessions with no focus behind them: a command's paged output (`showPaged`). */
  private readonly detached = new WeakSet<DialogSession>();

  constructor(private readonly deps: BrokerDeps) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.focus.onChange((info) => this.handleFocus(info));
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const timer of this.deferred.values()) clearTimeout(timer);
    this.deferred.clear();
    this.lastEditAt.clear();
    this.session = undefined;
  }

  /** The live session, if any. */
  current(): DialogSession | undefined {
    return this.session && this.session.state !== "closed" ? this.session : undefined;
  }

  hasActive(): boolean {
    return this.current() !== undefined;
  }

  /** The session a Telegram message or button belongs to (§4.5.1 step 0'). */
  sessionFor(chatId: number, messageThreadId?: number): DialogSession | undefined {
    const session = this.current();
    const telegram = session?.telegram;
    if (!session || !telegram) return undefined;
    // A paged output is not a dialog: it takes no text and no abandon/cancel.
    if (this.detached.has(session)) return undefined;
    if (telegram.chatId !== chatId) return undefined;
    if ((telegram.messageThreadId ?? undefined) !== (messageThreadId ?? undefined)) return undefined;
    return session;
  }

  /** True when this chat has a dialog waiting for typed text (§4.5.1). */
  waitsForText(chatId: number, messageThreadId?: number): boolean {
    const session = this.sessionFor(chatId, messageThreadId);
    if (!session) return false;
    return session.pendingInput !== undefined || textPurpose(session.model) !== undefined;
  }

  // --- focus transitions -----------------------------------------------------

  /**
   * One entry point for every focus change. `FocusTracker.update` fires per
   * (kind, component) change, so a Telegram action that closes a dialog and a
   * terminal keystroke that closes it arrive through here alike, and the new
   * focus is already readable — which is what rule 4.1 needs to tell a
   * replacement from a plain close.
   */
  private handleFocus(info: FocusInfo): void {
    if (!this.deps.enabled()) {
      this.session = undefined;
      return;
    }
    const component = info.component;
    const session = this.session;
    // A paged output keeps its message while the editor has the focus; only a
    // dialog that actually opens takes the message over (retire below).
    if (session && session.state !== "closed" && this.detached.has(session)
      && !(isDialogKind(info.kind) && component && info.kind !== "progress")) return;
    if (isDialogKind(info.kind) && component) {
      if (session && session.state !== "closed" && session.focus === component) {
        // Same component, different kind (dialog -> progress): redraw in place.
        this.redraw(session);
        return;
      }
      // A progress widget - the spinner that holds the keyboard so Esc can interrupt -
      // is not a question. Drawing it would put a keyboard in the chat before the
      // dialog anyone asked for has opened, and the terminal shows the spinner
      // anyway (§4.5 rule 1). A component with a recorded entry classifies as
      // "dialog", so this only skips panels no adapter could answer anyway.
      if (info.kind === "progress") {
        // The spinner holds the keyboard so Esc can interrupt the turn; the question behind
        // it is still open. Retiring here withdraws a keyboard the user is about to press,
        // so only the *drawing* rule applies: never mirror the spinner itself (§4.5 rule 1).
        return;
      }
      // A prompt opened over a live ask dialog (OMP's "Other"/note input, a HookEditorComponent) takes
      // focus while the ask call is still open, and restoreAskDialog hands focus back to the SAME ask
      // object afterwards (oh-my-pi@v18.12.5 packages/coding-agent/src/modes/controllers/extension-ui-controller.ts,
      // #showLocalAskDialog / openPrompt / restoreAskDialog). The question is still the one on screen, so the
      // session, its message and its focus stay as they are; the same-component branch redraws when focus returns.
      if (session && session.state !== "closed" && session.focus !== component) {
        const race = session.entry?.kind === "ask" ? session.entry.race : undefined;
        if (race && !race.settled && this.deps.focus.entryFor(component) === undefined) return;
      }
      // Same question, different object: the host moved focus from the dialog to the
      // overlay wrapper that holds it, and the wrapper is what receives keys from then
      // on. Keep the session - its message, keyboard and pending button taps stay
      // valid - and re-point it at the component that now owns the keystrokes.
      const nextEntry = this.deps.focus.entryFor(component);
      if (session && session.state !== "closed" && nextEntry && session.entry === nextEntry) {
        session.focus = component;
        session.root = info.root;
        // The model is read from the entry, and the cursor lives on the inner component
        // the wrapper now holds, so re-reading from the wrapper would report a different
        // (usually empty) dialog. Keep what is on screen; the next real change re-reads.
        this.show(session);
        return;
      }
      const closedBy = this.retire(session, info);
      this.open(component, info, closedBy === "replaced" ? session : undefined);
      return;
    }
    if (session && session.state !== "closed") this.retire(session, info);
  }

  /**
   * Rules 4.1-4.3. Returns how the session ended, so the caller can tell a
   * replacement (draw the next dialog on the same message) from a plain close.
   */
  private retire(session: DialogSession | undefined, next: FocusInfo): DialogSession["closedBy"] | undefined {
    if (!session || session.state === "closed") return undefined;
    const telegramAction = session.telegramAction;
    const byTelegram = session.state === "resolving" || telegramAction !== undefined;
    session.state = "closed";
    this.forgetPending(session);
    const telegram = session.telegram;
    if (!telegram) return undefined;
    if (this.detached.has(session)) {
      // A paged output has no answer and no summary: only its keyboard goes.
      this.rate(telegram, () => {
        void this.deps.transport.removeInlineKeyboard(telegram.chatId, telegram.messageId).catch(() => undefined);
      });
      return undefined;
    }

    // Rule 4.1: a new dialog that belongs to the same command scope replaces
    // this one, so no summary line — the message keeps being the dialog.
    const owner = this.owner();
    const replaced
      = next.kind === "dialog"
      && next.component !== session.focus
      && session.ownerFromScope
      && owner.fromScope
      && owner.origin !== undefined
      && sameTarget(telegram, { chatId: owner.origin.chatId, messageThreadId: owner.origin.messageThreadId });
    if (replaced) {
      session.closedBy = "replaced";
      return session.closedBy;
    }

    session.closedBy = byTelegram ? "telegram" : "terminal";
    const summary = byTelegram
      ? telegramAction?.cancelled
        ? "✖ Cancelled"
        : `✅ ${isSecretSession(session) ? "Submitted (hidden)" : session.lastAction ?? "Done"}`
      : "Answered in the terminal";
    this.publish(session, summary);
    return session.closedBy;
  }

  /** Open a session for a freshly focused component and show it (§4.5 rule 1). */
  private open(component: Record<string, unknown>, info: FocusInfo, carried?: DialogSession): void {
    const ctx = this.context(component, info);
    // One adapter for the life of the dialog: the one that read it owns the
    // actions on it (§4.6.1, a dialog is only ever handed to one adapter).
    const adapter = pickAdapterSafely(component, ctx) ?? unsupportedAdapter;
    const owner = this.owner(info.commandScope);
    const session: DialogSession = {
      id: `${Date.now().toString(36)}.${(this.sequence++).toString(36)}`,
      generation: 0,
      openedAt: Date.now(),
      focus: component,
      subject: component,
      root: info.root,
      kind: info.kind === "progress" ? "progress" : "dialog",
      adapter,
      model: this.read(component, ctx, adapter) ?? { kind: "unsupported", what: `${adapter.id}: read failed` },
      owner: owner.origin,
      ownerFromScope: owner.fromScope,
      entry: ctx.entry,
      keyMap: new Map(),
      page: 0,
      state: "open",
    };
    this.session = session;
    // Whether a dialog reaches the chat at all is decided here, so record what the
    // ownership rules were handed.
    brokerLog.debug("dialog owner", {
      ctor: ctorName(component),
      adapter: adapter.id,
      fromScope: owner.fromScope,
      chatId: owner.origin?.chatId ?? null,
      reuseMessageId: owner.reuseMessageId ?? null,
    });
    if (!owner.origin) return; // A local dialog: tracked, never mirrored (§4.3 rule 3).

    const purpose = textPurpose(session.model);
    if (purpose) {
      session.pendingInput = {
        flowId: session.id,
        secret: effectiveInput(session.model)?.secret === true,
        purpose,
      };
    }

    const chatId = owner.origin.chatId;
    const messageThreadId = owner.origin.messageThreadId;
    const carriedMessage = carried?.telegram;
    let messageId = 0;
    if (carriedMessage && !session.ownerFromScope) {
      // Rule 4.1: the replacement keeps the message of the dialog it replaced.
      messageId = carriedMessage.messageId;
    } else if (session.ownerFromScope && owner.reuseMessageId !== undefined && owner.scope) {
      messageId = owner.reuseMessageId;
      // The command's message now belongs to this dialog until it closes.
      this.scopes.set(session, owner.scope);
      owner.scope.dialogOpen = true;
    }
    session.telegram = { chatId, messageThreadId, messageId };
    this.show(session);
  }

  // --- Telegram input --------------------------------------------------------

  /**
   * A dialog button press (§4.5 rule 3). The returned toast is what the caller
   * should answer the callback query with; `clear` means the keyboard is dead
   * and has to go.
   */
  handleCallback(chatId: number, messageThreadId: number | undefined, callback: DialogCallback):
    { handled: boolean; toast?: string; clear?: boolean } {
    // The host may have moved focus since the last read (§4.1.3): settle it before judging the tap.
    this.deps.focus.validate();
    const session = this.session;
    if (!session || session.state === "closed") return { handled: true, toast: "Answered in the terminal", clear: true };
    // Every way a tap can be refused is a user-visible dead button, so say which one
    // fired and what focus looked like at that moment.
    const refuse = (reason: string, toast: string, clear = true) => {
      const now = this.deps.focus.current().component;
      const name = (value: object | undefined) => (value ? ctorName(value as Record<string, unknown>) : null);
      brokerLog.debug("callback refused", {
        reason,
        toast,
        sessionId: session.id,
        callbackId: callback.sessionId,
        generation: session.generation,
        callbackGeneration: callback.generation,
        focus: name(now),
        sessionFocus: name(session.focus),
        subject: name(session.subject),
      });
      return { handled: true, toast, clear };
    };
    const telegram = session.telegram;
    const wrongTarget = telegram === undefined
      || telegram.chatId !== chatId
      || (telegram.messageThreadId ?? undefined) !== (messageThreadId ?? undefined);
    if (session.id !== callback.sessionId || wrongTarget) {
      return refuse("stale-session", "This menu has expired");
    }
    if (callback.generation !== session.generation) {
      // Rule 3.2: something else moved the list; show the current one.
      this.redraw(session);
      return refuse("generation", "The list changed. Please choose again", false);
    }
    if (!this.canDrive(session)) {
      this.retire(session, this.deps.focus.current());
      return refuse("focus-moved", "Answered in the terminal");
    }

    const subject = (session.subject ?? session.focus) as Record<string, unknown>;
    const ctx = this.context(subject, this.deps.focus.current());
    // The adapter that read the dialog owns it (§4.6.1), so re-reading must not
    // ask the registry again: `detect` means "a session is opening for this
    // component", and an adapter may reset per-dialog state there.
    const model = this.read(subject, ctx, session.adapter);
    if (!model) {
      this.retire(session, this.deps.focus.current());
      return refuse("no-model", "Answered in the terminal");
    }
    const resolved = this.resolve(session, model, callback);
    if (resolved.kind === "page") {
      session.page = resolved.page;
      session.model = model;
      this.redraw(session);
      return { handled: true };
    }
    if (resolved.kind === "text") {
      session.pendingInput = {
        flowId: session.id,
        secret: effectiveInput(model)?.secret === true,
        purpose: resolved.purpose,
      };
      session.model = model;
      this.redraw(session);
      return {
        handled: true,
        toast: resolved.purpose === "search" ? "Send a keyword to search" : "Send a message as the answer",
      };
    }
    if (resolved.kind === "none") {
      // Rule 3.4: the row the button was drawn for is gone (or never existed).
      this.redraw(session);
      return refuse("row-gone", "The list changed. Please choose again", false);
    }

    session.model = model;
    session.state = "resolving";
    session.lastAction = resolved.label;
    const done = this.act(subject, resolved.action, ctx);
    if (!done) {
      session.state = "open";
      this.redraw(session);
      return refuse("act-refused", "This button does nothing here", false);
    }
    // The host call may have moved focus already (a selector opens its next list inside Enter):
    // read it now, so the message follows the dialog that is open, not the one the tap closed.
    this.deps.focus.validate();
    // The host may close the dialog after this tap returns (the Esc it received is handled
    // asynchronously), so the close is attributed to Telegram by this marker, not by state.
    const cancelled = resolved.action.type === "cancel";
    session.telegramAction = { cancelled };
    // Rule 3.5: the component may already be gone (selectors resolve inline),
    // or it may stay open (multi-select, settings rows).
    if (this.session === session && session.state === "resolving") {
      if (this.canDrive(session)) {
        session.state = "open";
        // A toggle or a settings row keeps the same dialog open on purpose: its later close
        // is not this tap's, so forget the tap.
        if (resolved.action.type === "toggle" || resolved.action.type === "cycle" || resolved.action.type === "submenu") {
          session.telegramAction = undefined;
        }
        this.redraw(session);
      } else {
        this.retire(session, this.deps.focus.current());
      }
    }
    return { handled: true };
  }

  /**
   * Free text aimed at a dialog (§4.5.1). Returns whether the message was
   * consumed: `false` lets it continue to slash dispatch or the chat prompt.
   * `messageId` is the incoming message, deleted when it carried a secret.
   */
  handleText(session: DialogSession, text: string, messageId?: number): { handled: boolean; toast?: string } {
    if (!this.canDrive(session)) {
      this.retire(session, this.deps.focus.current());
      return { handled: false };
    }
    const purpose = session.pendingInput?.purpose ?? textPurpose(session.model);
    if (!purpose) return { handled: false };
    const secret = isSecretSession(session);
    const flowId = session.pendingInput?.flowId ?? session.id;
    session.pendingInput = undefined;

    // The adapter types into the component's own field, which keeps cursor and
    // undo state coherent and works without a terminal to type into. A raw
    // write is only for text the plugin never modelled as a field of its own:
    // a search filter that re-filters as it types, or a questionnaire's custom
    // answer. For a modelled field - a top-level input/editor, or the input a
    // settings submenu opened - a submit the host refused must stay out of the
    // terminal: with the settings page focused those keystrokes land in its own
    // search box (or the editor), which the user never asked for.
    const subject = (session.subject ?? session.focus) as Record<string, unknown>;
    const ctx = this.context(subject, this.deps.focus.current());
    const driven = purpose === "input" || purpose === "editor"
      ? this.act(subject, { type: "submit", text }, ctx)
      : purpose === "search"
        ? this.act(subject, { type: "search", query: text }, ctx)
        : false;
    const modeledField = effectiveInput(session.model) !== undefined;
    const written = driven || (!modeledField && this.deps.writeText(purpose === "search" ? text : `${text}\r`));
    const telegram = session.telegram;
    // The secret travelled in a Telegram message either way: it is deleted even
    // when the host refused it, because the chat is the one place it is readable.
    if (secret && telegram && messageId !== undefined) {
      this.deps.secrets?.remember(targetKey(telegram), flowId, text);
      void this.deps.transport.deleteMessage(telegram.chatId, messageId).catch(() => undefined);
    }
    if (!written) {
      return { handled: true, toast: "The host did not accept this input" };
    }
    if (this.session === session && session.state !== "closed") {
      if (this.canDrive(session)) this.redraw(session);
      else this.retire(session, this.deps.focus.current());
    }
    return { handled: true };
  }

  /** `/stop` (§4.5 rule 6): cancel the dialog this chat owns, if any. */
  cancelFor(chatId: number, messageThreadId?: number): boolean {
    const session = this.sessionFor(chatId, messageThreadId);
    if (!session) return false;
    if (!this.canDrive(session)) return false;
    const subject = (session.subject ?? session.focus) as Record<string, unknown>;
    const ctx = this.context(subject, this.deps.focus.current());
    const done = this.act(subject, { type: "cancel" }, ctx);
    this.forgetPending(session);
    if (done && this.session === session) this.retire(session, this.deps.focus.current());
    return done;
  }

  /**
   * A new command from this chat means the remote user abandoned the question *this chat* was
   * being asked: the host queues every later command behind that dialog, so press Esc for them
   * and report what was closed (§4.5 rule 6). A question drawn for another chat, or never drawn
   * for anyone, is not this chat's to discard - it is reported as a blocker so the controller can
   * answer the user instead of submitting a command that would only wait out the host's timeout.
   */
  abandonFor(chatId: number, messageThreadId?: number): AbandonOutcome {
    const session = this.session;
    if (!session || session.state === "closed") return { kind: "nothing" };
    if (this.detached.has(session)) {
      this.retire(session, this.deps.focus.current());
      return { kind: "nothing" };
    }
    const telegram = session.telegram;
    const forThisChat = telegram !== undefined
      && telegram.chatId === chatId
      && (telegram.messageThreadId ?? undefined) === (messageThreadId ?? undefined);
    const title = (session.model as { title?: string } | undefined)?.title?.trim() || undefined;
    if (!forThisChat) {
      // Nobody in this chat was ever shown the question, so pressing Esc would throw away
      // another chat's - or the terminal's - decision. It still blocks the host queue: say so
      // rather than let the command sit there unseen.
      if (this.canDrive(session)) {
        brokerLog.debug("command blocked by a dialog owned elsewhere", { title: title ?? null, chatId });
        return { kind: "blocked", title };
      }
      return { kind: "nothing" };
    }
    const info = this.deps.focus.current();
    if (!this.canDrive(session) && info.kind === "editor") {
      // The question is already off screen: the host answered or discarded it, and the session
      // only still exists because its command scope was holding it. Nothing blocks the queue,
      // so this command needs no Esc and the chat needs no notice - retire it quietly.
      this.forgetPending(session);
      session.telegram = undefined;
      this.retire(session, info);
      brokerLog.debug("dialog already closed", { title: title ?? null, chatId });
      return { kind: "nothing" };
    }
    if (this.canDrive(session)) {
      const subject = (session.subject ?? session.focus) as Record<string, unknown>;
      this.act(subject, { type: "cancel" }, this.context(subject, this.deps.focus.current()));
    }
    this.forgetPending(session);
    // The message is left as it stands: the command that just arrived draws its own answer on
    // it (same scope, same message), so writing "answered in the terminal" over it would
    // swallow that answer. Only the now-dead keyboard is stripped; the chat is told separately
    // which question was closed.
    if (telegram && telegram.messageId > 0) {
      void this.deps.transport.removeInlineKeyboard(telegram.chatId, telegram.messageId)
        .catch(() => undefined);
    }
    session.telegram = undefined;
    this.retire(session, this.deps.focus.current());
    brokerLog.debug("dialog abandoned", { title: title ?? null, chatId });
    return { kind: "closed", title };
  }

  /**
   * Draw a command's output that does not fit one message (OutputCapture's pager)
   * on the command's own message, as read-only pages with ◀ / ▶ buttons. No
   * focus stands behind it: the page is a session of its own, takes no text, and
   * is retired by the next dialog or command in the chat.
   */
  showPaged(target: { chatId: number; messageThreadId?: number; messageId: number }, title: string, html: string): void {
    if (this.session && this.session.state !== "closed") this.retire(this.session, this.deps.focus.current());
    const model: DialogModel = { kind: "info", title, text: html, closable: false, html: true };
    const focus = {};
    const adapter: DialogAdapter = { id: "paged-output", detect: () => false, read: () => model, act: () => false };
    const session: DialogSession = {
      id: `${Date.now().toString(36)}.${(this.sequence++).toString(36)}`,
      generation: 0,
      openedAt: Date.now(),
      focus,
      subject: focus,
      kind: "dialog",
      adapter,
      model,
      ownerFromScope: false,
      keyMap: new Map(),
      page: 0,
      state: "open",
      telegram: { chatId: target.chatId, messageThreadId: target.messageThreadId, messageId: target.messageId },
    };
    this.detached.add(session);
    this.session = session;
    this.show(session);
  }

  // --- plumbing --------------------------------------------------------------

  /**
   * Whether Telegram may still drive this dialog (§4.5 rule 3): either the dialog holds the
   * keyboard, or the host's progress widget is standing in front of it to catch Esc. The
   * question is open either way, and keys go to the dialog's own component.
   */
  private canDrive(session: DialogSession): boolean {
    if (this.detached.has(session)) return true;
    const info = this.deps.focus.current();
    if (!info.component) return false;
    return info.component === session.focus || info.kind === "progress";
  }

  /**
   * The background poll (REFRESH_MS): the host can fill a dialog in after drawing it -
   * `/resume`'s "show all" paints an empty list and loads sessions behind it - and
   * neither a Telegram event nor a focus change fires for that. Re-read the open
   * Telegram dialog; `redraw` and `show` keep a poll that changed nothing silent.
   */
  private refresh(): void {
    try {
      const session = this.current();
      if (!session || !session.telegram) return;
      if (session.state === "resolving") return;
      if (this.detached.has(session)) return;
      if (!this.canDrive(session)) return;
      this.redraw(session);
    } catch (err) {
      brokerLog.debug("refresh failed", { err });
    }
  }

  /** Re-read the live model and draw it, honouring the per-chat edit cap. */
  private redraw(session: DialogSession): void {
    if (session.state === "closed") return;
    if (!this.canDrive(session)) return;
    const subject = (session.subject ?? session.focus) as Record<string, unknown>;
    const ctx = this.context(subject, this.deps.focus.current());
    const model = this.read(subject, ctx, session.adapter);
    if (!model) {
      this.retire(session, this.deps.focus.current());
      return;
    }
    // What typed text is *for* belongs to the model, not to the moment the
    // dialog opened: tapping into a settings submenu turns "type to search"
    // into "type the value of this row" (and a multi-select takes no text at
    // all). A marker left over from the previous draw would send the next
    // message to the wrong field, and the secret flag with it.
    if (session.pendingInput) {
      const purpose = textPurpose(model);
      if (purpose !== session.pendingInput.purpose) {
        session.pendingInput = purpose === undefined ? undefined : {
          flowId: session.id,
          secret: effectiveInput(model)?.secret === true,
          purpose,
        };
      }
    }
    // The page number belongs to the list it was made for: when the dialog
    // swaps in a different one (`/model`'s model list becoming "Assign ...
    // to"), the chat goes back to the first page, like the terminal does; a
    // repaint of the same list that only moves a cursor or refreshes a value
    // keeps it.
    if (!sameList(session.model, model)) session.page = 0;
    // The buttons are replaced by this draw, so the previous generation dies with them - but
    // only when the buttons themselves changed. OMP repaints an unchanged question and moves a
    // cursor the keyboard never shows, which used to report the keyboard the user is looking at
    // as stale ("the list changed, choose again") while nothing on screen had moved
    // (§4.5 rule 3.2).
    const surface = this.surfaceOf(renderDialog(model, {
      sessionId: session.id,
      generation: session.generation,
      page: session.page,
      redact: this.deps.secrets ? (text) => this.redact(session, text) : undefined,
    }));
    if (surface !== session.surface) session.generation += 1;
    session.model = model;
    this.show(session);
  }

  private read(component: Record<string, unknown>, ctx: AdapterContext, adapter?: DialogAdapter): DialogModel | undefined {
    const picked = adapter ?? pickAdapterSafely(component, ctx) ?? unsupportedAdapter;
    try {
      const model = picked.read(component, ctx);
      dumpDescribedTree(component, picked.id, model);
      return model;
    } catch (err) {
      brokerLog.debug("adapter read failed", { err, ctor: ctorName(component) });
      return undefined;
    }
  }

  private act(component: Record<string, unknown>, action: DialogAction, ctx: AdapterContext): boolean {
    const adapter = this.session?.adapter;
    if (!adapter) return false;
    try {
      return adapter.act(component, action, ctx) === true;
    } catch (err) {
      brokerLog.debug("adapter act failed", { err, ctor: ctorName(component) });
      return false;
    }
  }

  /**
   * What the user can press in a draw: button labels and callback keys, not their generation.
   * The terminal's own cursor mark travels inside the button text (`▸ cheese`); moving it
   * changes no button's meaning - each resolves by its own key against the live model - so it
   * must not cost the keyboard its generation.
   */
  private surfaceOf(rendered: RenderedDialog): string {
    const plain = (text: string) => text.replace(/[▸❯→]\s*/g, "").trim();
    return JSON.stringify([
      rendered.rows.map((row) => row.map((button) => plain(button.text))),
      [...rendered.keyMap.entries()].sort(),
    ]);
  }

  private context(component: Record<string, unknown>, info: FocusInfo): AdapterContext {
    const state = currentHostState();
    const entry = this.deps.focus.entryFor(component);
    // Whether a dialog models as a list or as a screen of arrow keys depends on
    // this entry arriving, so record what the hooks actually handed over.
    brokerLog.debug("adapter context", {
      ctor: ctorName(component),
      entry: entry?.kind,
      method: entry?.method,
      options: entry?.options?.length ?? 0,
      questions: entry?.questions?.length ?? 0,
    });
    return {
      // Adapters only ever run against a known host; "unknown" means no host
      // object was found, in which case no adapter detects anything anyway.
      host: state.host === "omp" ? "omp" : "pi",
      root: info.root,
      entry,
      redact: (text: string) => this.redactForTarget(text),
      sendKey: (name: string) => sendKeyTo(component, name),
      requestRender: () => {
        const render = state.ui?.requestRender;
        if (typeof render !== "function") return;
        try {
          (render as () => void).call(state.ui);
        } catch (err) {
          brokerLog.debug("requestRender failed", { err });
        }
      },
    };
  }

  /** Redacts with the secrets of the chat this dialog is (or will be) shown in. */
  private redactForTarget(text: string): string {
    if (!this.deps.secrets) return text;
    const target = this.session?.telegram ?? this.owner().origin;
    return target ? this.deps.secrets.redact(targetKey(target), text) : text;
  }

  /**
   * Who the dialog belongs to (§4.3): the running command scope, else the most
   * recent Telegram turn (preferring the chat the user last touched), else
   * nobody — a purely local dialog is tracked but never mirrored.
   */
  private owner(captured?: CommandScope): Owner {
    // The command whose call chain made the host open this dialog owns it, even when
    // that command's scope has already ended (a dialog opened after the command's idle end).
    if (captured) return this.scopeOwner(captured);
    const scope = this.deps.origin.active();
    if (scope && !scope.ended) return this.scopeOwner(scope);
    const turns = this.deps.activeTurns();
    if (turns.length === 0) return { fromScope: false };
    const chatId = this.deps.activeChatId();
    const turn = (chatId !== undefined ? findLast(turns, (entry) => entry.chatId === chatId) : undefined)
      ?? turns[turns.length - 1];
    if (!turn) return { fromScope: false };
    return {
      origin: { chatId: turn.chatId, messageThreadId: turn.messageThreadId, sourceMessageId: turn.sourceMessageId },
      fromScope: false,
    };
  }

  private scopeOwner(scope: CommandScope): Owner {
    return {
      origin: {
        chatId: scope.origin.chatId,
        messageThreadId: scope.origin.messageThreadId,
        sourceMessageId: scope.origin.sourceMessageId,
      },
      fromScope: true,
      reuseMessageId: scope.telegramMessageId,
      scope,
    };
  }

  /** Draw the session's current model onto its message. */
  private show(session: DialogSession): void {
    const telegram = session.telegram;
    if (!telegram) return;
    const rendered = renderDialog(session.model, {
      sessionId: session.id,
      generation: session.generation,
      page: session.page,
      redact: this.deps.secrets ? (text) => this.redact(session, text) : undefined,
    });
    session.surface = this.surfaceOf(rendered);
    this.rememberKeys(session, rendered.keyMap);
    const signature = `${session.page}|${rendered.text}|${JSON.stringify(rendered.rows)}`;
    const fresh = telegram.messageId <= 0;
    // While the first send is pending the message id is still 0; the send's own completion
    // redraws the live model, so nothing else is needed here.
    if (fresh && session.sending) return;
    if (!fresh && session.published === signature) return;
    session.published = signature;

    if (fresh) {
      const chatId = telegram.chatId;
      session.sending = true;
      void this.deps.transport
        .sendButtons(chatId, rendered.text, rendered.rows, telegram.messageThreadId, session.owner?.sourceMessageId)
        .then((sent) => {
          session.sending = false;
          // Keep the id even when the session was replaced or closed meanwhile: the sent message still needs closing.
          session.telegram = { ...telegram, messageId: sent.message_id };
          if (session.state === "closed") {
            const summary = session.pendingSummary;
            session.pendingSummary = undefined;
            if (summary !== undefined) this.publish(session, summary);
            return;
          }
          // Content may have changed while the send was pending. `published` still holds what was
          // sent, so show() edits only when the live content differs from it.
          if (this.session === session) this.show(session);
        })
        .catch((err) => {
          session.sending = false;
          brokerLog.debug("sendButtons failed", { err, chatId });
        });
      return;
    }
    this.rate(telegram, () => {
      void this.deps.transport
        .editButtons(telegram.chatId, telegram.messageId, rendered.text, rendered.rows)
        .catch((err) => {
          // Do not shed the keyboard here: an edit can fail for a reason that says nothing
          // about the dialog - flood control, or identical content - and the question behind
          // it is still open. The next repaint redraws it; a closed dialog loses its
          // keyboard through publish(), which is the only place a strip is justified.
          brokerLog.debug("editButtons failed", { err });
        });
    });
  }

  /** The one-line replacement for a finished dialog (rules 4.2/4.3). */
  private publish(session: DialogSession, summary: string): void {
    const telegram = session.telegram;
    if (!telegram) return;
    if (telegram.messageId <= 0) {
      // The first send is still in flight: keep the summary until its message id arrives.
      if (session.sending) session.pendingSummary = summary;
      return;
    }
    session.published = `${summary}|closed`;
    const scope = this.scopes.get(session);
    if (scope) {
      // The command's own message: its text is the command's final content, which
      // OutputCapture writes (header, summaries, output). While the scope runs the
      // summary is only recorded; once it has ended, the message is redrawn now.
      scope.dialogOpen = false;
      scope.dialogSummaries.push(this.redact(session, summary));
      if (scope.ended) this.deps.settleScope?.(scope);
      this.rate(telegram, () => {
        void this.deps.transport.removeInlineKeyboard(telegram.chatId, telegram.messageId).catch(() => undefined);
      });
      return;
    }
    this.rate(telegram, () => {
      // Telegram only guarantees keyboard removal through editMessageReplyMarkup,
      // so the summary edit is followed by an explicit strip: a finished dialog
      // must never leave a tappable dead menu behind.
      void this.deps.transport
        .editButtons(telegram.chatId, telegram.messageId, summary, [])
        .catch((err) => brokerLog.debug("summary edit failed", { err }))
        .then(() => this.deps.transport.removeInlineKeyboard(telegram.chatId, telegram.messageId))
        .catch(() => undefined);
    });
  }

  /** One edit per chat per second; a newer model replaces a queued older one. */
  private rate(target: { chatId: number; messageThreadId?: number; messageId?: number }, edit: () => void): void {
    // The spacing is per chat; the queued edit is per message, so an edit for one message
    // never replaces a queued edit for another message in the same chat.
    const chat = targetKey(target);
    const key = `${chat}#${target.messageId ?? ""}`;
    const last = this.lastEditAt.get(chat) ?? 0;
    const wait = EDIT_THROTTLE_MS - (Date.now() - last);
    const pending = this.deferred.get(key);
    if (pending !== undefined) clearTimeout(pending);
    if (wait <= 0) {
      this.deferred.delete(key);
      this.lastEditAt.set(chat, Date.now());
      edit();
      return;
    }
    const timer = setTimeout(() => {
      this.deferred.delete(key);
      this.lastEditAt.set(chat, Date.now());
      edit();
    }, wait);
    timer.unref?.();
    this.deferred.set(key, timer);
  }

  private rememberKeys(session: DialogSession, keyMap: Map<string, string>): void {
    session.keyMap.set(session.generation, keyMap);
    while (session.keyMap.size > KEEP_GENERATIONS) {
      const oldest = session.keyMap.keys().next().value;
      if (oldest === undefined) break;
      session.keyMap.delete(oldest);
    }
  }

  private forgetPending(session: DialogSession): void {
    const telegram = session.telegram;
    const pending = session.pendingInput;
    if (pending && telegram) this.deps.secrets?.forget(targetKey(telegram), pending.flowId);
    session.pendingInput = undefined;
  }

  private redact(session: DialogSession, text: string): string {
    const telegram = session.telegram;
    if (!telegram || !this.deps.secrets) return text;
    return this.deps.secrets.redact(targetKey(telegram), text);
  }

  /**
   * Callback data -> the action to perform (§4.7.1). Anything that names an
   * item is resolved by key against the live model first; `none` means the
   * button no longer points at anything and must not act.
   */
  private resolve(session: DialogSession, model: DialogModel, callback: DialogCallback): Resolved {
    const arg = callback.arg ?? "";
    switch (callback.op) {
      case "p": {
        const page = Number.parseInt(arg, 10);
        if (!Number.isFinite(page) || page < 0) return { kind: "none" };
        return { kind: "page", page };
      }
      case "s":
        return { kind: "text", purpose: "search" };
      case "i":
        return { kind: "text", purpose: "input" };
      case "y":
      case "n":
        return {
          kind: "action",
          action: { type: "confirm", yes: callback.op === "y" },
          label: callback.op === "y" ? "Confirm" : "Cancel",
        };
      case "x":
        return { kind: "action", action: { type: "cancel" }, label: "Cancel" };
      case "k":
        // Enter means "submit this dialog": the multi-select and questionnaire
        // adapters act on `submit`, the mirror on the raw key.
        return arg === "enter"
          ? { kind: "action", action: { type: "submit" }, label: "Submit" }
          : { kind: "action", action: { type: "key", name: arg }, label: `Key ${arg}` };
      case "q": {
        const index = Number.parseInt(arg, 10);
        if (!Number.isFinite(index)) return { kind: "none" };
        return { kind: "action", action: { type: "question", index }, label: `Question ${index + 1}` };
      }
      default:
        break;
    }

    const key = session.keyMap.get(callback.generation)?.get(arg);
    if (key === undefined) return { kind: "none" };
    const items = activeItems(model);
    switch (callback.op) {
      case "c":
      case "t": {
        const item = items.find((entry) => entry.key === key);
        if (!item) return { kind: "none" };
        return callback.op === "c"
          ? { kind: "action", action: { type: "choose", key }, label: `Choose ${item.label}` }
          : { kind: "action", action: { type: "toggle", key }, label: `Toggle ${item.label}` };
      }
      case "m": {
        const item = items.find((entry) => entry.key === key);
        if (!item) return { kind: "none" };
        return { kind: "action", action: { type: "submenu", key }, label: `Open ${item.label}` };
      }
      case "a": {
        const option = model.kind === "approval" ? model.options.find((entry) => entry.key === key) : undefined;
        if (!option) return { kind: "none" };
        return { kind: "action", action: { type: "approve", key }, label: option.label };
      }
      case "v": {
        const split = key.lastIndexOf("=");
        const itemKey = split > 0 ? key.slice(0, split) : key;
        const value = split > 0 ? key.slice(split + 1) : undefined;
        const item = items.find((entry) => entry.key === itemKey);
        if (!item) return { kind: "none" };
        return {
          kind: "action",
          action: value === undefined ? { type: "cycle", key: itemKey } : { type: "cycle", key: itemKey, value },
          label: `${item.label}${value === undefined ? "" : `: ${value}`}`,
        };
      }
      default:
        return { kind: "none" };
    }
  }
}

/** `pickAdapter` that never lets a throwing probe kill the dialog. */
function pickAdapterSafely(component: Record<string, unknown>, ctx: AdapterContext): DialogAdapter | undefined {
  try {
    return pickAdapter(component, ctx);
  } catch (err) {
    brokerLog.debug("adapter lookup failed", { err, ctor: ctorName(component) });
    return undefined;
  }
}
