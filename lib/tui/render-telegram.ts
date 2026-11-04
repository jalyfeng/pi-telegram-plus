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
import { splitTelegramHtml } from "../text-split.ts";
import type { TelegramButton } from "../types.ts";
import { confirmDeclineLabel } from "./model.ts";
import type { DialogItem, DialogModel, SearchModel } from "./model.ts";

/** §4.7.2: ten items per page, one button per row. */
/** The hint every secret prompt carries; plugin prompts outside the host dialogs use it too. */
export const SECRET_INPUT_HINT = "Secret input: send a message; the bot will not echo it.";
export const PAGE_SIZE = 10;
export const BUTTONS_PER_ROW = 3;
const MAX_LABEL = 45;
/** Longest host detail or hint shown after an item's label in the message body. */
const MAX_NOTE = 100;
/** Longest host lead or notice shown in the message body. */
const MAX_NOTICE = 300;
/** Longest badge shown after an item's label. */
const MAX_BADGE = 40;
/** Body text one list page may carry; past it the page drops its details, not its items (Telegram caps a message at 4096). */
const MAX_LIST_BODY = 3400;

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
  /** The next message from the chat is this dialog's typed answer (the Broker set it on a text button). */
  awaitingText?: boolean;
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
  return shorten(`${marker}${marker ? " " : ""}${item.mark ?? ""}${item.label}${value}`, MAX_LABEL);
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
  return pageNav(Math.max(1, Math.ceil(total / PAGE_SIZE)), page, ctx);
}

/** ◀ / ▶ and the position, for a list of `pages` pages; empty when there is one page. */
function pageNav(pages: number, page: number, ctx: RenderContext): TelegramButton[] {
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

/**
 * One item as a line of message text: its label, then the host's badges in
 * brackets and its note after a dash. The buttons still carry the label only.
 */
function itemLine(item: DialogItem, multi: boolean, details: boolean): string {
  if (!details) return escapeHtml(itemLabel(item, multi));
  const badges = (item.badges ?? []).map((badge) => ` [${escapeHtml(shorten(badge, MAX_BADGE))}]`).join("");
  const note = item.note ? ` — ${escapeHtml(shorten(item.note, MAX_NOTE))}` : "";
  return `${escapeHtml(itemLabel(item, multi))}${badges}${note}`;
}

/** The page's lines, with a bold heading wherever the section (`group`) changes. */
function itemBody(items: DialogItem[], multi: boolean, details: boolean): string[] {
  const body: string[] = [];
  let group: string | undefined;
  for (const item of items) {
    if (item.group !== undefined && item.group !== group) {
      body.push(`<b>${escapeHtml(shorten(item.group, 60))}</b>\n`);
    }
    group = item.group;
    body.push(`${itemLine(item, multi, details)}\n`);
  }
  return body;
}

/** A host lead or notice, as plain text above the items; empty when there is none. */
function noticeBody(notice: string | undefined): string[] {
  return notice ? [`${escapeHtml(shorten(notice, MAX_NOTICE))}\n\n`] : [];
}

function listText(
  title: string,
  subtitle: string | undefined,
  items: DialogItem[],
  page: number,
  multi = false,
  notice?: string,
): string {
  const visible = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const detailed = [...noticeBody(notice), ...itemBody(visible, multi, true)];
  const fits = detailed.join("").length <= MAX_LIST_BODY;
  return header(title, subtitle, fits ? detailed : [...noticeBody(notice), ...itemBody(visible, multi, false)]);
}

/** The search box's shown text: its query, else the host's placeholder, else `empty`. */
function searchHint(search: SearchModel, empty = "(all)"): string {
  return shorten(search.query || search.placeholder || empty, 30);
}

function renderSelect(model: Extract<DialogModel, { kind: "select" }>, ctx: RenderContext): RenderedDialog {
  // `items` is what the host shows after its filter, so pages count those rows;
  // `total` is the list before filtering and only feeds the "of" in the title.
  const shown = model.items.length;
  const total = Math.max(model.total || 0, shown);
  const pages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
  const page = Math.min(Math.max(0, ctx.page ?? 0), pages - 1);
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
  const nav = pageButtons(shown, page, ctx);
  if (nav.length > 0) rows.push(nav);
  rows.push(...chunk(extras));
  rows.push(actions);
  const count = shown < total ? `${shown} of ${total} items` : `${total} items`;
  const pageLine = `Page ${page + 1}/${pages} · ${count}`;
  const searchLine = model.search ? `${pageLine} · 🔍 ${searchHint(model.search)}` : pageLine;
  return {
    text: listText(
      model.title,
      [model.subtitle, searchLine].filter((line) => line !== undefined && line !== "").join("\n"),
      model.items,
      page,
      model.multi,
      model.notice,
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
    return { text: inner.text, rows, keyMap, page: 0, pages: 1 };
  }
  const page = Math.max(0, ctx.page ?? 0);
  // Page switches (shortcuts) are not list rows: they form a compact block under the list.
  const rowItems = model.items.filter((item) => item.shortcut !== true);
  const shortcutItems = model.items.filter((item) => item.shortcut === true);
  const pages = Math.max(1, Math.ceil(rowItems.length / PAGE_SIZE));
  const window = rowItems.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const rows: TelegramButton[][] = [];
  const keyMap = new Map<string, string>();
  window.forEach((item, index) => {
    const values = item.values ?? [];
    if (item.hasSubmenu) {
      const arg = `${page}.${index}`;
      const built = button(`▸ ${shorten(`${item.mark ?? ""}${item.label}${item.value ? `: ${item.value}` : ""}`, MAX_LABEL)}`, ctx, "m", arg);
      if (!built) return;
      rows.push([built]);
      keyMap.set(arg, item.key);
      return;
    }
    const arg = `${page}.${index}`;
    if (values.length === 2) {
      // One button shows the current value; a press moves to the other one.
      const other = values[0] === item.value ? values[1] : values[0];
      const built = button(itemLabel(item), ctx, "v", arg);
      if (!built) return;
      rows.push([built]);
      keyMap.set(arg, `${item.key}=${other}`);
      return;
    }
    const built = button(itemLabel(item), ctx, values.length > 2 ? "v" : "t", arg);
    if (!built) return;
    rows.push([built]);
    keyMap.set(arg, item.key);
  });
  const nav = pageButtons(rowItems.length, page, ctx);
  if (nav.length > 0) rows.push(nav);
  // The compact block of page switches sits under the list on every page; the
  // arg `g<n>` cannot collide with the row args (`<page>.<index>...`).
  const shortcutButtons: TelegramButton[] = [];
  shortcutItems.forEach((item, index) => {
    const arg = `g${index}`;
    const built = button(shorten(item.label, MAX_LABEL), ctx, "m", arg);
    if (!built) return;
    shortcutButtons.push(built);
    keyMap.set(arg, item.key);
  });
  rows.push(...chunk(shortcutButtons));
  rows.push(cancelRow(ctx));
  const pageLine = `Page ${page + 1}/${pages} · ${rowItems.length} items`;
  const searchLine = model.search ? `${pageLine} · 🔍 ${searchHint(model.search, "Type to search")}` : pageLine;
  return {
    text: listText(
      model.title,
      [model.subtitle, searchLine].filter((line) => line !== undefined && line !== "").join("\n"),
      rowItems,
      page,
      false,
      model.notice,
    ),
    rows,
    keyMap,
    page,
    pages,
  };
}

const TYPED_ANSWER_HINT = "Send a message as the answer, or tap Cancel.";

function renderQuestionnaire(model: Extract<DialogModel, { kind: "questionnaire" }>, ctx: RenderContext): RenderedDialog {
  const activeIndex = Math.max(0, Math.min(model.active, model.questions.length - 1));
  const active = model.questions[activeIndex];
  if (!active) {
    return { text: header(model.title, undefined, ["(no questions to show)"]), rows: [cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
  }
  // A single question has no tabs to show: no progress line and no switch row.
  const multiple = model.questions.length > 1;
  const answeredCount = model.questions.filter((question) => question.answered).length;
  const status = multiple
    ? `Question ${activeIndex + 1} of ${model.questions.length} · answered: ${answeredCount}`
    : undefined;
  const body = [`${escapeHtml(shorten(active.prompt, 300))}\n`];
  // The same wording the input dialogs use for their text, so a typed answer is asked for the same way.
  if (ctx.awaitingText) body.push(`${escapeHtml(TYPED_ANSWER_HINT)}\n`);
  const { rows, keyMap } = itemButtons(active.items, 0, ctx, active.multi ? "t" : "c");
  if (multiple) {
    const switchRow = keep([
      activeIndex > 0 ? button("◀ Prev question", ctx, "q", String(activeIndex - 1)) : undefined,
      button(`Question ${activeIndex + 1}/${model.questions.length}`, ctx, "q", String((activeIndex + 1) % model.questions.length)),
      activeIndex < model.questions.length - 1 ? button("Next question ▶", ctx, "q", String(activeIndex + 1)) : undefined,
    ]);
    if (switchRow.length > 0) rows.unshift(switchRow);
  }
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
  return { text: header(model.title, status, body), rows, keyMap, page: 0, pages: 1 };
}

/** What a tool-approval card says about typed text: a message denies the call and gives the new instructions. */
const APPROVAL_HINT = "Send a message to deny and give new instructions.";

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
  // A Cancel beside a Deny is the same answer twice, and its name says neither what it does nor what it ends.
  if (!model.options.some((option) => option.key === "deny")) buttons.push(...cancelRow(ctx));
  return { text: header(model.title, undefined, [body, `${escapeHtml(APPROVAL_HINT)}\n`]), rows: chunk(buttons), keyMap, page: 0, pages: 1 };
}

function renderConfirm(model: Extract<DialogModel, { kind: "confirm" }>, ctx: RenderContext): RenderedDialog {
  const body = model.message ? `${escapeHtml(messageBody(model.message))}\n` : "";
  if (model.confirmLabel) {
    // The host named its own buttons (e.g. Delete / Cancel): use them, not Yes / No.
    const answers = keep([
      button(shorten(model.confirmLabel, MAX_LABEL), ctx, "y"),
      button(shorten(confirmDeclineLabel(model), MAX_LABEL), ctx, "n"),
    ]);
    return { text: header(model.title, undefined, [body]), rows: [answers], keyMap: new Map(), page: 0, pages: 1 };
  }
  // Yes and No only: No is the decline, so a separate Cancel would be the same answer twice.
  const rows = [keep([button("✅ Yes", ctx, "y"), button("❌ No", ctx, "n")])];
  return { text: header(model.title, undefined, [body]), rows, keyMap: new Map(), page: 0, pages: 1 };
}

const DETAIL_BUDGET = 900;
const HAS_LINK = /https?:\/\//i;

/**
 * An input's detail as Telegram text. A line with a link is kept whole, however long: a link cut in the
 * middle is not tappable. The other lines fill the budget that the links leave, in order, and are dropped
 * from the end once it is spent.
 */
function detailBody(detail: string): string {
  const lines = clean(detail).split("\n");
  const linkCost = lines.filter((line) => HAS_LINK.test(line)).reduce((sum, line) => sum + line.length + 1, 0);
  let budget = Math.max(0, DETAIL_BUDGET - linkCost);
  let room = true;
  const kept: string[] = [];
  for (const line of lines) {
    if (HAS_LINK.test(line)) {
      kept.push(line);
      continue;
    }
    if (!room) continue;
    if (line.length + 1 > budget) {
      room = false;
      continue;
    }
    budget -= line.length + 1;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

function renderInput(model: Extract<DialogModel, { kind: "input" }>, ctx: RenderContext): RenderedDialog {
  // Plain text, not `<pre>`: Telegram makes a bare URL tappable and copyable.
  const steps = model.steps && model.steps.length > 0
    ? [`${model.steps
        .map((step) => (step.current ? `<b>${escapeHtml(shorten(step.label, 20))}</b>` : escapeHtml(shorten(step.label, 20))))
        .join(" › ")}\n\n`]
    : [];
  const detail = model.detail ? detailBody(model.detail) : "";
  const body = [
    ...steps,
    detail ? `${escapeHtml(detail)}\n` : "",
    // The host's placeholder is plain text, as the host writes it (not a code block).
    model.placeholder ? `${escapeHtml(shorten(model.placeholder, 300))}\n` : "",
    model.secret ? `<i>${escapeHtml(SECRET_INPUT_HINT)}</i>\n` : "",
    "Send a message as the input, or tap Cancel.",
  ];
  // The input's extra buttons (e.g. Skip) sit above Cancel, as a select's do.
  const extras = keep((model.extraActions ?? []).map((extra) => button(shorten(extra.label, MAX_LABEL), ctx, "k", extra.key)));
  return { text: header(model.title, undefined, body), rows: [...chunk(extras), cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
}

/** Progress lines keep their line breaks: each line is shortened on its own,
 * and whole lines are dropped from the end once the 900-character budget is spent. */
/**
 * A confirmation's message as Telegram text: each line shortened on its own,
 * so the host's line breaks and paragraph breaks survive; whole lines are
 * dropped from the end once the 900-character budget is spent.
 */
function messageBody(text: string): string {
  const kept: string[] = [];
  let total = 0;
  for (const raw of text.split("\n")) {
    const line = shorten(raw, 900);
    if (line === "") {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > 900) break;
    kept.push(line);
    total += cost;
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

function progressBody(text: string): string {
  const kept: string[] = [];
  let total = 0;
  for (const raw of text.split("\n")) {
    const line = shorten(raw, 900);
    if (line === "") continue;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > 900) break;
    kept.push(line);
    total += cost;
  }
  return kept.join("\n");
}

function renderProgress(model: Extract<DialogModel, { kind: "progress" }>, ctx: RenderContext): RenderedDialog {
  const body = `⏳ ${escapeHtml(progressBody(model.text))}\n`;
  return {
    text: header("Running", undefined, [body]),
    rows: model.cancellable ? [cancelRow(ctx)] : [],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** Read-only panel: the text plus one way out (§4.6.5 #12). */
/** Bytes of HTML one info message carries; the rest of the message is buttons and header. */
const INFO_PAGE_BYTES = 3400;

/** The title of a read-only panel that the host did not name, on every message it is drawn on. */
export const PANEL_TITLE = "Panel";

/** A panel's text cut into pages (HTML split at block boundaries so no tag is cut). */
function infoPages(model: Extract<DialogModel, { kind: "info" }>): string[] {
  return model.html === true ? splitTelegramHtml(model.text, INFO_PAGE_BYTES) : [`<pre>${escapeHtml(clean(model.text).slice(0, 3000))}</pre>`];
}

/**
 * What a read-only panel leaves on its message when it closes: its title and the page the user last
 * saw (`page`, clamped), then one status line. No buttons. `redact` is applied to the text before it
 * is cut, as `renderDialog` does for a live draw.
 */
export function closedPanelHtml(
  model: Extract<DialogModel, { kind: "info" }>,
  page: number,
  status: string,
  redact?: (text: string) => string,
): string {
  const shown = redact ? redactModel(model, redact) : model;
  const pages = infoPages(shown);
  const body = pages[Math.min(Math.max(0, page), pages.length - 1)] ?? "";
  return `${header(shown.title ?? PANEL_TITLE, undefined, [`${body}\n`])}\n\n${escapeHtml(status)}`;
}

/**
 * A read-only panel: the text (one page of it for HTML), the panel's own action buttons, paging, and
 * the renderer's Close when the panel has none of its own.
 */
function renderInfo(model: Extract<DialogModel, { kind: "info" }>, ctx: RenderContext): RenderedDialog {
  const pages = infoPages(model);
  const count = Math.max(1, pages.length);
  const page = Math.min(Math.max(0, ctx.page ?? 0), count - 1);
  const body = `${pages[page] ?? ""}\n`;
  const actions = model.actions ?? [];
  const buttons = actions.map((action) => button(action.label, ctx, "c", action.key)).filter((built): built is TelegramButton => built !== undefined);
  const keyMap = new Map<string, string>();
  actions.forEach((action) => keyMap.set(action.key, action.key));
  const rows = chunk(buttons);
  const nav = pageNav(count, page, ctx);
  if (nav.length > 0) rows.push(nav);
  if (model.closable) rows.push(cancelRow(ctx, "Close"));
  return {
    text: header(model.title ?? PANEL_TITLE, count > 1 ? `Page ${page + 1}/${count}` : undefined, [body]),
    rows: fitRows(rows),
    keyMap,
    page,
    pages: count,
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
