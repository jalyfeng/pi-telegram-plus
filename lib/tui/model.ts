/**
 * Shared vocabulary for the TUI parity architecture (docs/tui-parity-refactor-plan.md §4.6).
 *
 * Adapters translate a host dialog component into a `DialogModel`; the Telegram
 * renderer turns that model into a message plus an inline keyboard; the Broker
 * turns a button press back into a `DialogAction` that the adapter performs on
 * the live component. Nothing here imports the host: the model is plain data.
 */

import type { RaceHandle } from "./race.ts";

export type DialogItem = {
  /** Stable inside one adapter: value/id when present, else "index + label". */
  key: string;
  label: string;
  description?: string;
  /** Current value of a settings row. */
  value?: string;
  /** The value the host is currently using (e.g. the active model). */
  current?: boolean;
  /** Multi-select checkbox. */
  checked?: boolean;
  /** Where the terminal cursor was when the model was read. */
  focused?: boolean;
};

export type Question = {
  id: string;
  prompt: string;
  items: DialogItem[];
  multi: boolean;
  /** A free-text answer is accepted for this question. */
  allowCustom: boolean;
  answered: boolean;
};

export type DialogModel =
  | {
      kind: "select";
      title: string;
      items: DialogItem[];
      /** Full list size before filtering, when the host reports it. */
      total: number;
      search?: { query: string };
      multi?: boolean;
      extraActions?: { label: string; key: string }[];
    }
  | {
      kind: "settings";
      title: string;
      items: (DialogItem & { values?: string[]; hasSubmenu?: boolean })[];
      search?: { query: string };
      /** A submenu is nested state of the same session (§4.6.4 #5). */
      submenu?: { itemKey: string; model: DialogModel };
    }
  | {
      kind: "questionnaire";
      title: string;
      questions: Question[];
      active: number;
      canSubmit: boolean;
    }
  | { kind: "approval"; title: string; detail?: string; options: { key: string; label: string }[] }
  | { kind: "confirm"; title: string; message?: string }
  | { kind: "input"; title: string; detail?: string; placeholder?: string; secret: boolean; prefill?: string }
  | { kind: "editor"; title: string; prefill?: string }
  | { kind: "progress"; text: string; cancellable: boolean }
  /**
   * Read-only panel. `text` is plain text unless `html` is set, in which case it is
   * Telegram HTML already escaped by its producer. `actions` become one button each;
   * `closable` adds the renderer's own Close button (an adapter whose actions already
   * include a close sets it false).
   */
  | { kind: "info"; title?: string; text: string; closable: boolean; html?: boolean; actions?: { label: string; key: string }[] }
  /** §4.6.5 #13: nothing can model this dialog; the chat gets a plain notice, never a frame. */
  | { kind: "unsupported"; title?: string; what: string };

export type DialogAction =
  | { type: "choose"; key: string }
  | { type: "toggle"; key: string }
  | { type: "cycle"; key: string; value?: string }
  | { type: "submenu"; key: string }
  | /** switch the active question inside a questionnaire */
    { type: "question"; index: number }
  | { type: "search"; query: string }
  | { type: "submit"; text?: string }
  | { type: "confirm"; yes: boolean }
  | { type: "approve"; key: string }
  | /** component-specific key; only dialogs that advertise one may receive it */
    { type: "key"; name: string }
  | { type: "cancel" };

/** Semantic information captured at the host's dialog entry point (§4.1.2). */
export type EntryKind =
  | "select" | "confirm" | "input" | "editor" | "custom"
  | "ask" | "approval" | "panel";

export type AskQuestion = {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
  recommended?: number;
  allowCustom?: boolean;
};

export type EntryInfo = {
  kind: EntryKind;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Only true when the host entry itself marks the input as a secret. */
  secret?: boolean;
  questions?: AskQuestion[];
  approval?: { full?: string; compact?: string; session?: string };
  /** Which host family produced this entry. */
  source: "pi" | "omp";
  /** Entry method name, for logs and adapter whitelists. */
  method?: string;
  /** Live race handle when the extension's own dialog call (`select`/`confirm`/`input`, OMP's `editor`/`approve`) is racing the host dialog (§4.12). */
  race?: RaceHandle;
};

export type AdapterContext = {
  host: "pi" | "omp";
  /** Root component; only used to find titles/entry info, never for identity. */
  root?: object;
  entry?: EntryInfo;
  /**
   * Secret redaction for the dialog's chat (§4.7.4): adapters that build text from raw
   * host data apply it to each text run before converting or escaping it. Absent when
   * no secret store is wired; identity then.
   */
  redact?: (text: string) => string;
  /** Send one named key to the focused component's handleInput. */
  sendKey(name: string): boolean;
  requestRender(): void;
};

export type DialogAdapter = {
  id: string;
  /** Shape checks only; `instanceof` is forbidden (host may load its own copy). */
  detect(F: object, ctx: AdapterContext): boolean;
  read(F: object, ctx: AdapterContext): DialogModel;
  /** false = could not perform it; the Broker reports and redraws. */
  act(F: object, action: DialogAction, ctx: AdapterContext): boolean;
};

export type DialogOrigin = {
  chatId: number;
  messageThreadId?: number;
  sourceMessageId?: number;
};

/** Broker's per-dialog state (§4.5). */
export type DialogSession = {
  id: string;
  /** +1 on every Telegram-side redraw. */
  generation: number;
  /**
   * The buttons of the last draw (labels plus callback keys), so a redraw that changes nothing
   * the user can press keeps its generation.
   */
  surface?: string;
  /** When the dialog was focused: how a command tells its own dialog from a stale one. */
  openedAt: number;
  /** The focused component F: the session identity. */
  focus: object;
  /**
   * The component that holds the dialog's state. Focus may sit on an overlay wrapper
   * that only forwards keys; reads, acts and keys all still target this one (§4.1.2).
   */
  subject?: object;
  root?: object;
  kind: "dialog" | "progress";
  adapter?: DialogAdapter;
  model: DialogModel;
  owner?: DialogOrigin;
  /** True when the owner came from a command scope (in-place message reuse). */
  ownerFromScope: boolean;
  /** The entry that named this dialog, so a wrapper taking focus keeps it (§4.1.2). */
  entry?: EntryInfo;
  telegram?: { chatId: number; messageThreadId?: number; messageId: number };
  pendingInput?: {
    flowId: string;
    secret: boolean;
    purpose: "input" | "editor" | "search";
  };
  /**
   * generation -> callback argument -> item/option key, exactly as rendered.
   * A callback is resolved against the *live* model by key, so a stale button
   * can never act on a different row. Only the last generations are kept.
   */
  keyMap: Map<number, Map<string, string>>;
  page: number;
  /** The exact text+keyboard last put on the message; equal means no edit. */
  published?: string;
  state: "open" | "resolving" | "closed";
  closedBy?: "telegram" | "terminal" | "replaced";
  lastAction?: string;
  /**
   * Set when the broker itself sent a Telegram tap to the host and the host has not closed the
   * dialog yet. The close that follows belongs to Telegram, even when it is observed after the
   * session already left `resolving`. `cancelled` tells a Cancel button from an answer.
   */
  telegramAction?: { cancelled: boolean };
};
