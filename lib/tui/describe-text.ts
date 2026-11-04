/**
 * OMP text panels as Telegram text (plan v8 §0.2): a `describe(cx)` semantic
 * tree is turned into HTML text plus the panel's own action buttons.
 *
 * Only described data is read - never `render()`. Every text run goes through
 * `redact` before it is converted or escaped, so a registered secret never
 * reaches the HTML.
 */
import { stripAnsi } from "../ansi.ts";
import { log } from "../logger.ts";
import { markdownToTelegramHtml } from "../markdown.ts";
import { childKeypath, describableChild, describeTree, tspText, type NativeNodeLike } from "./adapters/tsp.ts";

const describeLog = log.child("describe-text");

/**
 * A button of the panel: what is needed to replay it through `handleNativeEvent`. A button of a
 * selectable list's item carries `item`; it replays as `{ type: "activate", key, item }` on the list.
 */
export type DescribedAction = {
  label: string;
  /** The `act` name the button fires (`close`, `page`, ...); `activate` for a list item. */
  act: string;
  /** The keypath of the button node inside its owner (`#routeUiEvent`'s `target.keypath`); the list's keypath for an item. */
  keypath: string;
  /** The `value` the node carries, when it has one. */
  value?: string;
  /** The key of the list item this button selects and activates. */
  item?: string;
  /** A node of a list pressed as a whole (its own `actions`, e.g. an entry's open): its `act` goes to its keypath. */
  node?: boolean;
  /** The component whose `handleNativeEvent` takes the event (a child component, or the root). */
  owner: object;
};

/**
 * Stable keys for the actions of one described tree: the `act` name, or
 * `keypath|act` when that act name occurs more than once; a list item's key is
 * `keypath|item`. Keys depend on what the button is, not on its position in the
 * list, so a press can be matched against the live tree later. If two buttons
 * still share a key (nested owners with the same keypath), the later one gets a
 * `#n` suffix in tree order.
 */
export function actionKeys(actions: readonly DescribedAction[]): string[] {
  const counts = new Map<string, number>();
  for (const action of actions) {
    if (action.item === undefined && !action.node) counts.set(action.act, (counts.get(action.act) ?? 0) + 1);
  }
  const bases = actions.map((action) => {
    if (action.item !== undefined) return `${action.keypath}|${action.item}`;
    // A node's keypath names it alone; its act is not needed in the key (keeps the callback under 64 bytes).
    if (action.node) return action.keypath;
    return (counts.get(action.act) ?? 0) > 1 ? `${action.keypath}|${action.act}` : action.act;
  });
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}#${occurrence}`;
  });
}

export type DescribedText = {
  /** Telegram HTML: every text run escaped, markdown converted, code kept in `<pre>`. */
  html: string;
  /** The first section or card heading, when the tree has one (plain, unescaped). */
  title?: string;
  /** Action buttons in tree order. */
  actions: DescribedAction[];
};

/** Guards against cyclic or absurdly deep trees. */
const MAX_DEPTH = 12;

/** How many component boundaries (a child that is itself a described component) are read inside one another. */
const MAX_COMPONENT_DEPTH = 6;

const BUTTON_ROLE = "omp.btn";

/** The role of a QR code block (OMP's `/collab` share): it is read as its link, never as its symbol. */
const QR_ROLE = "omp.collab.qrcode";

const loggedKinds = new Set<string>();

type Props = Record<string, unknown>;

const isObject = (value: unknown): value is Props => typeof value === "object" && value !== null;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text of a node (its `text`/`spans` props, or a spinner's `label`). */
function ownText(props: Props): string {
  return tspText(props.text) || tspText(props.spans);
}

/** The button's visible label: the text children, without the keyboard hint. */
function buttonLabel(node: NativeNodeLike): string {
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  let label = "";
  for (const child of children) {
    if (!isObject(child) || !isObject(child.p)) continue;
    if (child.k === "text") label += ownText(child.p);
    else if (child.k !== "kbd") label += buttonLabel(child as NativeNodeLike);
  }
  return label.trim();
}

/** A button node is a `row` with the `omp.btn` role and a string `actions.click`. */
function buttonAct(node: NativeNodeLike): { act: string; value?: string } | undefined {
  if (!isObject(node.p) || node.p.role !== BUTTON_ROLE || !isObject(node.p.actions)) return undefined;
  const act = node.p.actions.click;
  if (typeof act !== "string") return undefined;
  const value = typeof node.p.value === "string" ? node.p.value : undefined;
  return value === undefined ? { act } : { act, value };
}

/** Percent text for a 0-1 value, or the host's own label when it gave one. */
function meterText(props: Props): string {
  const label = tspText(props.label);
  if (label !== "") return label;
  return typeof props.value === "number" ? `${Math.round(props.value * 100)}%` : "unknown";
}

/**
 * A meter as text: one line per part (its own label), then one line per mark (its title). A meter
 * without parts is its label or percentage, as before.
 */
function renderMeter(props: Props, walk: Walk): string {
  const parts = Array.isArray(props.parts) ? (props.parts as unknown[]).filter(isObject) : [];
  const lines = parts.length > 0 ? parts.map((part) => escapeHtml(walk.redact(meterText(part)))) : [escapeHtml(walk.redact(meterText(props)))];
  const marks = Array.isArray(props.marks) ? (props.marks as unknown[]).filter(isObject) : [];
  for (const mark of marks) {
    const title = tspText(mark.title);
    if (title !== "") lines.push(escapeHtml(walk.redact(title)));
  }
  return lines.join("\n");
}

/** One item's lines: `label — value`, its detail indented under it. A pressable item is also a button. */
function itemLines(item: NativeNodeLike, keypath: string, owner: object, walk: Walk, pressable: boolean): string[] {
  const props: Props = isObject(item.p) ? item.p : {};
  if (props.hidden === true) return [];
  const label = walk.redact(tspText(props.label));
  const value = walk.redact(tspText(props.value));
  const detail = walk.redact(tspText(props.detail));
  const lines = [value === "" ? escapeHtml(label) : `${escapeHtml(label)} — ${escapeHtml(value)}`];
  if (detail !== "") lines.push(`  ${escapeHtml(detail)}`);
  const itemActions: Props = isObject(props.actions) ? props.actions : {};
  const clickable = pressable || typeof itemActions.click === "string" || typeof itemActions.dblclick === "string";
  if (clickable && props.disabled !== true && item.key !== undefined) {
    const buttonLabelText = walk.redact(buttonText(props.label)) || label;
    walk.actions.push({ label: buttonLabelText, act: "activate", keypath, owner, item: String(item.key) });
  }
  return lines;
}

/**
 * A list's text: its items one line each (`label — value`, the detail indented under it, a disabled
 * item shown without a button), and its other children written as blocks, one blank line apart. The
 * list's `empty` text stands in when it writes nothing. A selectable list (`click` selects,
 * `dblclick` activates), or one whose owner takes native events, makes each enabled item a button
 * that replays as an `activate` event for that item on the list.
 */
function renderList(node: NativeNodeLike, keypath: string, owner: object, walk: Walk, depth: number): string | null {
  const props: Props = isObject(node.p) ? node.p : {};
  const actions: Props = isObject(props.actions) ? props.actions : {};
  const selectable = actions.click === "select" || actions.dblclick === "activate";
  // A component that takes native events can select and activate its own items, selectable or not.
  const ownerAnswers = typeof (owner as { handleNativeEvent?: unknown }).handleNativeEvent === "function";
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  const blocks: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) blocks.push(run.join("\n"));
    run = [];
  };
  children.forEach((child, index) => {
    if (!isObject(child)) return;
    if (child.k === "item") {
      run.push(...itemLines(child as NativeNodeLike, keypath, owner, walk, selectable || ownerAnswers));
      return;
    }
    flush();
    walk.lists += 1;
    const text = renderNode(child as NativeNodeLike, childKeypath(keypath, child as NativeNodeLike, index), owner, walk, depth + 1);
    walk.lists -= 1;
    if (text !== null && text.trim() !== "") blocks.push(text);
  });
  flush();
  if (blocks.length === 0) {
    const empty = tspText(props.empty);
    return empty === "" ? null : escapeHtml(walk.redact(empty));
  }
  return blocks.join("\n\n");
}

/** The act a node of a list is pressed with: its double-click (opens it), else its click. */
function nodeAct(node: NativeNodeLike): string | undefined {
  if (!isObject(node.p) || !isObject(node.p.actions)) return undefined;
  const actions = node.p.actions;
  if (typeof actions.dblclick === "string") return actions.dblclick;
  return typeof actions.click === "string" ? actions.click : undefined;
}

/** The first line of the text in a node's subtree (the heading of an entry), plain. */
function firstLine(node: NativeNodeLike, depth = 0): string {
  if (depth > MAX_DEPTH || !isObject(node.p)) return "";
  if (node.k === "text") {
    const line = ownText(node.p).split("\n").map((part) => part.trim()).find((part) => part !== "");
    if (line !== undefined) return line;
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child) || describableChild(child)) continue;
    const line = firstLine(child as NativeNodeLike, depth + 1);
    if (line !== "") return line;
  }
  return "";
}

/** Whether a text node is a terminal key hint: keyed `hint`, with an accent-styled span (`⏎ View Content`). */
function isKeyHint(node: NativeNodeLike): boolean {
  if (node.k !== "text" || node.key !== "hint" || !isObject(node.p) || !Array.isArray(node.p.spans)) return false;
  return (node.p.spans as unknown[]).some((span) => isObject(span) && typeof span.s === "string" && span.s.split(" ").includes("accent"));
}

/**
 * A label as a button caption: its spans without a leading decoration span (a span made only of
 * symbols, such as the `■` swatch of a category). A label that is not spans is kept as it is.
 */
function buttonText(label: unknown): string {
  if (!Array.isArray(label)) return tspText(label).trim();
  const [first, ...rest] = label as unknown[];
  const decorative = isObject(first) && typeof first.t === "string" && first.t.trim() !== "" && !/[\p{L}\p{N}]/u.test(first.t);
  return tspText(decorative && rest.length > 0 ? rest : label).trim();
}

/** A QR code block's link: the `href` of a span in it. The symbols themselves are never written. */
function qrLink(node: NativeNodeLike, walk: Walk): string | null {
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child) || !isObject(child.p) || !Array.isArray(child.p.spans)) continue;
    for (const span of child.p.spans as unknown[]) {
      if (isObject(span) && typeof span.href === "string" && span.href !== "") return escapeHtml(walk.redact(span.href));
    }
  }
  return null;
}

type Walk = {
  redact: (text: string) => string;
  actions: DescribedAction[];
  title?: string;
  visited: Set<object>;
  /** Component boundaries currently open around the node being read. */
  components: number;
  /** Lists currently open around the node being read: their nodes with `actions` are buttons. */
  lists: number;
};

/** Text of one node (HTML), or `null` when it contributes nothing. */
function renderNode(node: NativeNodeLike, keypath: string, owner: object, walk: Walk, depth: number): string | null {
  if (depth > MAX_DEPTH || walk.visited.has(node)) return null;
  walk.visited.add(node);
  if (isObject(node.p) && node.p.hidden === true) return null;

  if (isObject(node.p) && node.p.role === QR_ROLE) return qrLink(node, walk);
  if (isKeyHint(node)) return null;

  const button = buttonAct(node);
  if (button) {
    const label = walk.redact(buttonLabel(node)) || button.act;
    walk.actions.push({ label, act: button.act, keypath, owner, ...(button.value !== undefined ? { value: button.value } : {}) });
    return null;
  }

  // Inside a list, a node with its own actions is a button too: its first line names it.
  const entryAction = walk.lists > 0 ? nodeAct(node) : undefined;
  if (entryAction !== undefined) {
    walk.actions.push({ label: walk.redact(firstLine(node)) || entryAction, act: entryAction, keypath, owner, node: true });
  }

  const props: Props = isObject(node.p) ? node.p : {};
  switch (node.k) {
    case "text":
      return escapeHtml(walk.redact(ownText(props)));
    case "spinner":
      return escapeHtml(walk.redact(tspText(props.label)));
    case "md":
      return markdownToTelegramHtml(walk.redact(typeof props.text === "string" ? props.text : ""));
    case "code":
    case "ansi":
      return `<pre>${escapeHtml(walk.redact(stripAnsi(typeof props.text === "string" ? props.text : "")))}</pre>`;
    case "diff": {
      const text = typeof props.text === "string" ? props.text : "";
      return `<pre>${escapeHtml(walk.redact(stripAnsi(text)))}</pre>`;
    }
    case "kv": {
      const items = Array.isArray(props.items) ? (props.items as unknown[]) : [];
      return items
        .filter(isObject)
        .map((item) => `${escapeHtml(walk.redact(tspText(item.k)))}: ${escapeHtml(walk.redact(tspText(item.v)))}`)
        .join("\n");
    }
    case "meter":
      return renderMeter(props, walk);
    case "progress":
      return escapeHtml(walk.redact(meterText(props)));
    case "list":
      return renderList(node, keypath, owner, walk, depth);
    case "badge": {
      const badge = tspText(props.text);
      return badge === "" ? null : `[${escapeHtml(walk.redact(badge))}]`;
    }
    case "rule":
      return "";
    case "spacer":
      return null;
    case "section":
    case "card": {
      const head = tspText(props.head);
      if (head !== "" && walk.title === undefined) walk.title = head;
      const heading = head !== "" ? `<b>${escapeHtml(walk.redact(head))}</b>` : null;
      const body = children(node, keypath, owner, walk, depth);
      return [heading, body].filter((part): part is string => part !== null && part !== "").join("\n");
    }
    case "row":
      return children(node, keypath, owner, walk, depth, " ");
    case "col":
      return children(node, keypath, owner, walk, depth);
    default: {
      // Unknown kind: its children, if any; the kind is logged once.
      if (node.k !== undefined && !loggedKinds.has(String(node.k))) {
        loggedKinds.add(String(node.k));
        describeLog.debug("unknown describe kind", { kind: String(node.k) });
      }
      return children(node, keypath, owner, walk, depth);
    }
  }
}

/**
 * The children of `node` in order, joined by `separator`. A nested component is described in its own
 * namespace, up to {@link MAX_COMPONENT_DEPTH} boundaries deep, and never twice (a component that
 * holds itself is read once).
 */
function children(node: NativeNodeLike, keypath: string, owner: object, walk: Walk, depth: number, separator = "\n"): string {
  const list = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  const parts: string[] = [];
  list.forEach((child, index) => {
    if (!isObject(child)) return;
    const component = describableChild(child);
    if (component) {
      if (walk.components >= MAX_COMPONENT_DEPTH || walk.visited.has(component)) return;
      const tree = describeTree(component);
      if (!tree) return;
      walk.visited.add(component);
      walk.components += 1;
      const text = renderNode(tree, "", component, walk, depth + 1);
      walk.components -= 1;
      if (text !== null && text !== "") parts.push(text);
      return;
    }
    const childNode = child as NativeNodeLike;
    const text = renderNode(childNode, childKeypath(keypath, childNode, index), owner, walk, depth + 1);
    if (walk.lists > 0) {
      // Inside a list a whitespace-only run is dropped, and an entry (a node with its own actions) is set apart by a blank line.
      if (text === null || text.trim() === "") return;
      parts.push(nodeAct(childNode) !== undefined ? `\n${text}` : text);
      return;
    }
    if (text !== null && text !== "") parts.push(text);
  });
  return parts.join(separator);
}

/**
 * `html` without the heading lines at its start that repeat `title` exactly: a panel's title is already
 * its message header, so the body does not write it again.
 */
export function withoutLeadingTitle(html: string, title: string | undefined): string {
  if (title === undefined || title.trim() === "") return html;
  const heading = `<b>${escapeHtml(title.trim())}</b>`;
  let rest = html;
  while (rest === heading || rest.startsWith(`${heading}\n`)) rest = rest.slice(heading.length).replace(/^\n+/, "");
  return rest;
}

/**
 * Walks a described tree (`root`, owned by `owner`) into Telegram HTML plus its
 * action buttons. Blank runs are collapsed so the text reads as the panel does.
 */
export function describedText(root: NativeNodeLike, redact: (text: string) => string, owner: object): DescribedText {
  // The owner is already being read: a child that is the owner itself is not read again.
  const walk: Walk = { redact, actions: [], visited: new Set<object>([owner]), components: 0, lists: 0 };
  const html = renderNode(root, "", owner, walk, 0) ?? "";
  return {
    html: html.replace(/\n{3,}/g, "\n\n").trim(),
    ...(walk.title !== undefined ? { title: walk.title } : {}),
    actions: walk.actions,
  };
}
