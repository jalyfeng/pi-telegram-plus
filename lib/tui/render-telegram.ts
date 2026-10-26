/**
 * Telegram renderer for dialog models (§4.7).
 *
 * One model in, one message + keyboard out. Buttons never carry item identity:
 * they encode a page and an index, and the Broker resolves that against the
 * *live* model, so a stale button can never act on the wrong row. Every
 * callback also carries the generation it was drawn for.
 *
 * Ops (§4.7.1): `c` choose, `t` toggle, `v` cycle value, `m` submenu,
 * `q` switch question, `p` page, `s` search, `y`/`n` confirm, `a` approval,
 * `i` free text, `k` terminal key, `x` cancel.
 */
import { encodeDialogCallback } from "../callback-protocol.ts";
import type { TelegramButton } from "../types.ts";
import type { DialogItem, DialogModel } from "./model.ts";

/** §4.7.2: ten items per page, one button per row. */
export const PAGE_SIZE = 10;
export const BUTTONS_PER_ROW = 3;
const MAX_LABEL = 45;

export type RenderedDialog = {
  text: string;
  rows: TelegramButton[][];
  /** callback argument -> item/option key, resolved against the live model. */
  keyMap: Map<string, string>;
  page: number;
  pages: number;
};

export type RenderContext = {
  sessionId: string;
  generation: number;
  page?: number;
  /** §4.7.4: applied to every string of the model *before* anything is escaped. */
  redact?: (text: string) => string;
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function clean(value: string | undefined): string {
  if (!value) return "";
  return value.replace(ANSI, "").replace(CONTROL, "");
}

function shorten(value: string, limit: number): string {
  const text = clean(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chunk(buttons: TelegramButton[]): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(index, index + BUTTONS_PER_ROW));
  }
  return rows;
}

/** Telegram Bot API hard limit: at most 8 buttons per inline keyboard row. */
export const MAX_ROW_BUTTONS = 8;

/** Safety net at the render exit: an oversized row is re-chunked. */
export function fitRows(rows: TelegramButton[][]): TelegramButton[][] {
  return rows.flatMap((row) => (row.length > MAX_ROW_BUTTONS ? chunk(row) : [row]));
}

function button(label: string, ctx: RenderContext, op: string, arg?: string): TelegramButton | undefined {
  try {
    return { text: label, value: encodeDialogCallback(ctx.sessionId, ctx.generation, op, arg) };
  } catch {
    // Past the 64-byte Bot API limit: drop the button rather than throw.
    return undefined;
  }
}

function keep(buttons: (TelegramButton | undefined)[]): TelegramButton[] {
  return buttons.filter((built): built is TelegramButton => built !== undefined);
}

function itemLabel(item: DialogItem, multi = false): string {
  const checkbox = multi || item.checked === true ? (item.checked ? "☑" : "☐") : "";
  const cursor = item.focused ? "▸" : "";
  const current = item.current ? "✓" : "";
  const marker = [checkbox, cursor, current].filter((part) => part !== "").join("");
  const value = item.value ? `: ${shorten(item.value, 18)}` : "";
  return shorten(`${marker}${marker ? " " : ""}${item.label}${value}`, MAX_LABEL);
}

/** Item buttons, one per row, labelled with cursor/state markers. */
function itemButtons(items: DialogItem[], page: number, ctx: RenderContext, op: string) {
  const rows: TelegramButton[][] = [];
  const keyMap = new Map<string, string>();
  items.forEach((item, index) => {
    const arg = `${page}.${index}`;
    const built = button(itemLabel(item, op === "t"), ctx, op, arg);
    if (!built) return;
    rows.push([built]);
    keyMap.set(arg, item.key);
  });
  return { rows, keyMap };
}

function pageButtons(total: number, page: number, ctx: RenderContext): TelegramButton[] {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return [];
  const previous = page > 0 ? button("◀ Prev", ctx, "p", String(page - 1)) : undefined;
  const next = page < pages - 1 ? button("Next ▶", ctx, "p", String(page + 1)) : undefined;
  return keep([previous, button(`${page + 1}/${pages}`, ctx, "p", String((page + 1) % pages)), next]);
}

function cancelRow(ctx: RenderContext, label = "Cancel"): TelegramButton[] {
  const cancel = button(label, ctx, "x");
  return cancel ? [cancel] : [];
}

function header(title: string, subtitle: string | undefined, body: string[]): string {
  const lines = [`<b>${escapeHtml(shorten(title, 80))}</b>`];
  if (subtitle) lines.push(`<i>${escapeHtml(subtitle)}</i>`);
  lines.push("");
  return `${lines.join("\n")}${body.join("")}`;
}

function listText(title: string, subtitle: string | undefined, items: DialogItem[], page: number, multi = false): string {
  const body = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((item) => `${escapeHtml(itemLabel(item, multi))}\n`);
  return header(title, subtitle, body);
}

function renderSelect(model: Extract<DialogModel, { kind: "select" }>, ctx: RenderContext): RenderedDialog {
  const page = Math.max(0, ctx.page ?? 0);
  const total = model.total || model.items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const window = model.items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const { rows, keyMap } = itemButtons(window, page, ctx, model.multi ? "t" : "c");
  const actions: TelegramButton[] = [];
  if (model.multi) {
    const submit = button("⏎ Submit", ctx, "k", "enter");
    if (submit) actions.push(submit);
  }
  if (model.search) {
    const search = button(`🔍 ${shorten(model.search.query || "Search", 20)}`, ctx, "s");
    if (search) actions.push(search);
  }
  // Footer extras get their own rows: a single footer row carrying nine
  // buttons (OMP /agents: 2 scope + 5 action + Search + Cancel) is rejected
  // by the Bot API (max 8 per row), so the whole list never reaches the chat.
  const extras = keep((model.extraActions ?? []).map(
    (extra) => button(shorten(extra.label, MAX_LABEL), ctx, "k", extra.key),
  ));
  actions.push(...cancelRow(ctx));
  const nav = pageButtons(total, page, ctx);
  if (nav.length > 0) rows.push(nav);
  rows.push(...chunk(extras));
  rows.push(actions);
  const subtitle = `Page ${page + 1}/${pages} · ${total} items`;
  return {
    text: listText(
      model.title,
      model.search ? `${subtitle} · 🔍 ${shorten(model.search.query || "(all)", 20)}` : subtitle,
      model.items,
      page,
      model.multi,
    ),
    rows,
    keyMap,
    page,
    pages,
  };
}

/** Settings rows: two-valued rows switch directly, longer value lists cycle. */
function renderSettings(model: Extract<DialogModel, { kind: "settings" }>, ctx: RenderContext): RenderedDialog {
  if (model.submenu) {
    const inner = renderDialog(model.submenu.model, { ...ctx, page: 0 });
    const rows = inner.rows.slice();
    rows.push(cancelRow(ctx, "↩ Back"));
    const keyMap = new Map<string, string>();
    // Keys are the exact callback arguments of the buttons drawn above, so the
    // Broker can look one up without knowing this is a nested view.
    for (const [key, value] of inner.keyMap) keyMap.set(key, value);
    return { text: `${inner.text}\n<i>Submenu · Back sends Esc</i>`, rows, keyMap, page: 0, pages: 1 };
  }
  const page = Math.max(0, ctx.page ?? 0);
  const pages = Math.max(1, Math.ceil(model.items.length / PAGE_SIZE));
  const window = model.items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const rows: TelegramButton[][] = [];
  const keyMap = new Map<string, string>();
  window.forEach((item, index) => {
    const values = item.values ?? [];
    if (item.hasSubmenu) {
      const arg = `${page}.${index}`;
      const built = button(`▸ ${shorten(`${item.label}${item.value ? `: ${item.value}` : ""}`, MAX_LABEL)}`, ctx, "m", arg);
      if (!built) return;
      rows.push([built]);
      keyMap.set(arg, item.key);
      return;
    }
    if (values.length === 2) {
      values.forEach((value, position) => {
        const arg = `${page}.${index}.${position}`;
        const built = button(`${item.value === value ? "◉" : "○"} ${item.label}: ${shorten(value, MAX_LABEL - 12)}`, ctx, "v", arg);
        if (!built) return;
        rows.push([built]);
        keyMap.set(arg, `${item.key}=${value}`);
      });
      return;
    }
    const arg = `${page}.${index}`;
    const built = button(itemLabel(item), ctx, values.length > 2 ? "v" : "t", arg);
    if (!built) return;
    rows.push([built]);
    keyMap.set(arg, item.key);
  });
  const nav = pageButtons(model.items.length, page, ctx);
  if (nav.length > 0) rows.push(nav);
  rows.push(cancelRow(ctx));
  const subtitle = `Page ${page + 1}/${pages} · ${model.items.length} items`;
  return {
    text: listText(
      model.title,
      model.search ? `${subtitle} · 🔍 ${shorten(model.search.query || "Type to search", 20)}` : subtitle,
      model.items,
      page,
    ),
    rows,
    keyMap,
    page,
    pages,
  };
}

function renderQuestionnaire(model: Extract<DialogModel, { kind: "questionnaire" }>, ctx: RenderContext): RenderedDialog {
  const activeIndex = Math.max(0, Math.min(model.active, model.questions.length - 1));
  const active = model.questions[activeIndex];
  if (!active) {
    return { text: header(model.title, undefined, ["(no questions to show)"]), rows: [cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
  }
  const status = model.questions
    .map((question, index) => `${index === activeIndex ? "▸" : ""}${index + 1}${question.answered ? "✓" : "·"}`)
    .join(" ");
  const body = `${escapeHtml(shorten(active.prompt, 300))}\n`;
  const { rows, keyMap } = itemButtons(active.items, 0, ctx, active.multi ? "t" : "c");
  const switchRow = keep([
    activeIndex > 0 ? button("◀ Prev question", ctx, "q", String(activeIndex - 1)) : undefined,
    button(`Question ${activeIndex + 1}/${model.questions.length}`, ctx, "q", String((activeIndex + 1) % model.questions.length)),
    activeIndex < model.questions.length - 1 ? button("Next question ▶", ctx, "q", String(activeIndex + 1)) : undefined,
  ]);
  if (switchRow.length > 0) rows.unshift(switchRow);
  const actions: TelegramButton[] = [];
  if (active.allowCustom) {
    const custom = button("✏️ Type an answer", ctx, "i");
    if (custom) actions.push(custom);
  }
  if (model.canSubmit) {
    const submit = button("⏎ Submit all", ctx, "k", "enter");
    if (submit) actions.push(submit);
  }
  actions.push(...cancelRow(ctx));
  rows.push(...chunk(actions));
  return { text: header(model.title, status, [body]), rows, keyMap, page: 0, pages: 1 };
}

function renderApproval(model: Extract<DialogModel, { kind: "approval" }>, ctx: RenderContext): RenderedDialog {
  const body = model.detail ? `<pre>${escapeHtml(clean(model.detail).slice(0, 900))}</pre>\n` : "";
  const buttons: TelegramButton[] = [];
  const keyMap = new Map<string, string>();
  model.options.forEach((option, index) => {
    const built = button(shorten(option.label, MAX_LABEL), ctx, "a", String(index));
    if (!built) return;
    buttons.push(built);
    keyMap.set(String(index), option.key);
  });
  buttons.push(...cancelRow(ctx));
  return { text: header(model.title, undefined, [body]), rows: chunk(buttons), keyMap, page: 0, pages: 1 };
}

function renderConfirm(model: Extract<DialogModel, { kind: "confirm" }>, ctx: RenderContext): RenderedDialog {
  const body = model.message ? `${escapeHtml(shorten(model.message, 900))}\n` : "";
  const rows = [keep([button("✅ Yes", ctx, "y"), button("❌ No", ctx, "n")]), cancelRow(ctx)];
  return { text: header(model.title, undefined, [body]), rows, keyMap: new Map(), page: 0, pages: 1 };
}

function renderInput(model: Extract<DialogModel, { kind: "input" }>, ctx: RenderContext): RenderedDialog {
  // Plain text, not `<pre>`: Telegram makes a bare URL tappable and copyable.
  const body = [
    model.detail ? `${escapeHtml(clean(model.detail).slice(0, 900))}\n` : "",
    model.placeholder ? `<pre>${escapeHtml(shorten(model.placeholder, 300))}</pre>\n` : "",
    model.secret ? "<i>Secret input: send a message; the bot will not echo it.</i>\n" : "",
    "Send a message as the input, or tap Cancel.",
  ];
  return { text: header(model.title, undefined, body), rows: [cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
}

function renderProgress(model: Extract<DialogModel, { kind: "progress" }>, ctx: RenderContext): RenderedDialog {
  const body = `⏳ ${escapeHtml(shorten(model.text, 900))}\n`;
  return {
    text: header("Running", undefined, [body]),
    rows: model.cancellable ? [cancelRow(ctx)] : [],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** Read-only panel: the text plus one way out (§4.6.5 #12). */
function renderInfo(model: Extract<DialogModel, { kind: "info" }>, ctx: RenderContext): RenderedDialog {
  const body = `<pre>${escapeHtml(clean(model.text).slice(0, 3000))}</pre>\n`;
  return {
    text: header(model.title ?? "Terminal", undefined, [body]),
    rows: [cancelRow(ctx, "Close")],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** §4.6.5 #13: an unrecognised dialog is announced, never mirrored. */
function renderUnsupported(model: Extract<DialogModel, { kind: "unsupported" }>, ctx: RenderContext): RenderedDialog {
  const body = `The terminal shows a dialog Telegram can't handle (${escapeHtml(shorten(clean(model.what), 120))}). Please answer it in the terminal.\n`;
  return {
    text: header(model.title ?? "Dialog Telegram can't handle", undefined, [body]),
    rows: [cancelRow(ctx, "Cancel")],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** Escape-free view of one model: message text plus inline keyboard. */
function renderModel(model: DialogModel, ctx: RenderContext): RenderedDialog {
  switch (model.kind) {
    case "select":
      return renderSelect(model, ctx);
    case "settings":
      return renderSettings(model, ctx);
    case "questionnaire":
      return renderQuestionnaire(model, ctx);
    case "approval":
      return renderApproval(model, ctx);
    case "confirm":
      return renderConfirm(model, ctx);
    case "input":
      return renderInput(model, ctx);
    case "editor":
      return renderInput({ kind: "input", title: model.title, secret: false, prefill: model.prefill }, ctx);
    case "progress":
      return renderProgress(model, ctx);
    case "info":
      return renderInfo(model, ctx);
    case "unsupported":
      return renderUnsupported(model, ctx);
  }
}

/**
 * §4.7.4: every string a model can show — titles, bodies, option labels,
 * placeholders, current values — is redacted *before* anything is HTML-escaped
 * or copied into a button label. Non-strings are kept as they are.
 */
function redactModel<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactModel(entry, redact)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactModel(entry, redact);
    }
    return out as T;
  }
  return value;
}

/**
 * Turns a model into message text plus inline keyboard. Secrets are redacted on
 * the way in (§4.7.4), so neither the HTML body nor the button labels ever see
 * the raw value. The key map comes from the un-redacted model: the Broker
 * resolves it against the live model, where `***` would match nothing.
 */
export function renderDialog(model: DialogModel, ctx: RenderContext): RenderedDialog {
  const renderContext: RenderContext = { ...ctx, page: ctx.page ?? 0 };
  if (!ctx.redact) {
    const shown = renderModel(model, renderContext);
    return { ...shown, rows: fitRows(shown.rows) };
  }
  const shown = renderModel(redactModel(model, ctx.redact), renderContext);
  return { ...shown, rows: fitRows(shown.rows), keyMap: renderModel(model, renderContext).keyMap };
}
