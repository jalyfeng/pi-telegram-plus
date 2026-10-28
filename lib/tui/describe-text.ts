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

/** A button of the panel: what is needed to replay it through `handleNativeEvent`. */
export type DescribedAction = {
  label: string;
  /** The `act` name the button fires (`close`, `page`, ...). */
  act: string;
  /** The keypath of the button node inside its owner (`#routeUiEvent`'s `target.keypath`). */
  keypath: string;
  /** The `value` the node carries, when it has one. */
  value?: string;
  /** The component whose `handleNativeEvent` takes the event (a child component, or the root). */
  owner: object;
};

/**
 * Stable keys for the actions of one described tree: the `act` name, or
 * `keypath|act` when that act name occurs more than once. Keys depend on what
 * the button is, not on its position in the list, so a press can be matched
 * against the live tree later.
 */
export function actionKeys(actions: readonly DescribedAction[]): string[] {
  const counts = new Map<string, number>();
  for (const action of actions) counts.set(action.act, (counts.get(action.act) ?? 0) + 1);
  return actions.map((action) => ((counts.get(action.act) ?? 0) > 1 ? `${action.keypath}|${action.act}` : action.act));
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

const BUTTON_ROLE = "omp.btn";

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

type Walk = {
  redact: (text: string) => string;
  actions: DescribedAction[];
  title?: string;
  visited: Set<object>;
};

/** Text of one node (HTML), or `null` when it contributes nothing. */
function renderNode(node: NativeNodeLike, keypath: string, owner: object, walk: Walk, depth: number): string | null {
  if (depth > MAX_DEPTH || walk.visited.has(node)) return null;
  walk.visited.add(node);
  if (isObject(node.p) && node.p.hidden === true) return null;

  const button = buttonAct(node);
  if (button) {
    const label = walk.redact(buttonLabel(node)) || button.act;
    walk.actions.push({ label, act: button.act, keypath, owner, ...(button.value !== undefined ? { value: button.value } : {}) });
    return null;
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
    case "progress":
      return escapeHtml(walk.redact(meterText(props)));
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

/** The children of `node` in order, joined by `separator`; nested components are described in their own namespace. */
function children(node: NativeNodeLike, keypath: string, owner: object, walk: Walk, depth: number, separator = "\n"): string {
  const list = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  const parts: string[] = [];
  list.forEach((child, index) => {
    if (!isObject(child)) return;
    const component = describableChild(child);
    if (component) {
      const tree = describeTree(component);
      if (!tree) return;
      const text = renderNode(tree, "", component, walk, depth + 1);
      if (text !== null && text !== "") parts.push(text);
      return;
    }
    const text = renderNode(child as NativeNodeLike, childKeypath(keypath, child as NativeNodeLike, index), owner, walk, depth + 1);
    if (text !== null && text !== "") parts.push(text);
  });
  return parts.join(separator);
}

/**
 * Walks a described tree (`root`, owned by `owner`) into Telegram HTML plus its
 * action buttons. Blank runs are collapsed so the text reads as the panel does.
 */
export function describedText(root: NativeNodeLike, redact: (text: string) => string, owner: object): DescribedText {
  const walk: Walk = { redact, actions: [], visited: new Set<object>() };
  const html = renderNode(root, "", owner, walk, 0) ?? "";
  return {
    html: html.replace(/\n{3,}/g, "\n\n").trim(),
    ...(walk.title !== undefined ? { title: walk.title } : {}),
    actions: walk.actions,
  };
}
