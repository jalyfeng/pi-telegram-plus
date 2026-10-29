/**
 * Adapter T3.2d: OMP components that describe themselves through the Tern
 * Surface Protocol (§4.11.3).
 *
 * OMP's picker-shaped components implement `describe(cx)` (a semantic tree of
 * `NativeNode`s) and `handleNativeEvent(event)` (structured events keyed by a
 * node's keypath inside its owner component). Reading the tree and answering
 * with events means this adapter never looks at the screen and never sends
 * keys - the two things §4.11 forbids.
 *
 * Keypath rules (pi-tui `native/reconcile.ts`): a component's root node has
 * keypath `""`; a child's segment is its `key`, or its index when unkeyed,
 * joined with `/`. A child `Component` is a boundary: its nodes live in its
 * own namespace, so the keypath restarts at `""` and events go to the child.
 *
 * Scope: single-select pickers, settings pages and OMP's built-in text
 * prompts (the login dialog's API-key field). While an extension dialog
 * is racing the host (§4.12), these adapters decline - the race owns the entry.
 * While a picker's action strip is open (the model hub's role chips after
 * activating a model), the picker adapter shows and answers the strip, not
 * the list; a strip without chips (name entry) stays with the terminal.
 * Multi-select is T3.2f.
 */
import type { AdapterContext, DialogAction, DialogAdapter, DialogItem, DialogModel } from "../model.ts";
import { setInputValue } from "../keys.ts";

/** What a component may consult while describing itself (§4.11.3); never a clock. */
const DESCRIBE_CONTEXT = {
  cols: 80,
  reduceMotion: true,
  dark: true,
  hour12: false,
  supports: () => true,
  feature: () => false,
};

/** How deep we follow component boundaries before giving up. */
const MAX_COMPONENT_DEPTH = 4;

type HostRecord = Record<string, unknown>;

/** A described node, matched by shape only (the host may load its own copy). */
export type NativeNodeLike = HostRecord & { k?: unknown; p?: unknown; c?: unknown; key?: unknown };

/** The picker props this adapter reads (`TspPickerProps` in pi-wire). */
type PickerProps = {
  title?: unknown;
  items?: readonly PickerItemLike[];
  order?: readonly unknown[];
  selected?: unknown;
  current?: readonly unknown[];
  total?: unknown;
  /** The chip strip docked above the action bar; null when absent. */
  strip?: unknown;
  /** Shown in place of the list when it holds no visible items (`TspText`). */
  empty?: unknown;
  /** Status line above the list (`TspText`); fallback for `empty`. */
  message?: unknown;
  /** Tab row above the list (`TspPickerProps.tabs`); `tab` is the active id. */
  tabs?: readonly PickerEntryLike[];
  tab?: unknown;
  /** Scope filter row; `scope` is the active id, entries may be disabled. */
  scopes?: readonly PickerEntryLike[];
  scope?: unknown;
  /** Action bar below the list (e.g. `/tree`'s Switch / Label / Filter). */
  actions?: readonly PickerEntryLike[];
  /** Search box contents; null/absent means the picker has no search box. */
  query?: unknown;
  /** The search box's hint while it is empty (`TspPickerProps.placeholder`). */
  placeholder?: unknown;
  /** Text under the title (`TspPickerProps.subtitle`). */
  subtitle?: unknown;
  /** What the list holds, plural ("sessions"). */
  noun?: unknown;
  /**
   * Pending confirmation over the list (OMP session picker's Delete): `text`
   * is the question, `act` the native action that answers yes. Null/absent
   * when nothing waits for an answer.
   */
  confirm?: unknown;
};

/** Tab, scope or action-bar entry: an id, a `TspText` label, optional disable. */
type PickerEntryLike = { id?: unknown; label?: unknown; disabled?: unknown };

type PickerItemLike = {
  id?: unknown;
  label?: unknown;
  detail?: unknown;
  disabled?: unknown;
  /** Tags after the label (`TspPickerItem.badges`): a model's `default`, `vision`, … */
  badges?: unknown;
};

/** The picker's action strip: chips the user picks after activating an item. */
type StripChipLike = { id?: unknown; label?: unknown; on?: unknown };

type StripLike = { label?: unknown; items: readonly StripChipLike[]; selected?: unknown };

/** The settings-page props (`TspPrefsProps` in pi-wire). */
type PrefsProps = {
  title?: unknown;
  pages?: readonly PrefsPageLike[];
  page?: unknown;
  sections?: readonly PrefsSectionLike[];
  focus?: unknown;
  /** The program's search text; a string switches the page to search results. */
  query?: unknown;
  /** Lead text of the current page (`TspPrefsProps.lead`). */
  lead?: unknown;
};

type PrefsPageLike = { id?: unknown; label?: unknown; disabled?: unknown };

type PrefsSectionLike = { id?: unknown; title?: unknown; rows?: unknown };

type PrefsRowLike = { id?: unknown; label?: unknown; hint?: unknown; disabled?: unknown; control?: unknown };

/** A settings page's section: the heading its rows sit under (`TspPrefsSection.title`). */
type PrefsGroupedRow = { row: PrefsRowLike; group?: string };

/** The text-field props this adapter reads (`TspInputProps` in pi-wire):
 * what the field holds (mask dots when the host masks it) and the placeholder. */
type InputProps = { text?: unknown; placeholder?: unknown };

/** The described kinds this file drives, and the props each one carries. */
type NodePropsByKind = { picker: PickerProps; prefs: PrefsProps; input: InputProps };

type NodeKind = keyof NodePropsByKind;

type NodeFound<K extends NodeKind> = { owner: object; keypath: string; props: NodePropsByKind[K] };

type Describable = object & {
  describe(cx: unknown): unknown;
  handleNativeEvent(event: unknown): unknown;
};

const isObject = (value: unknown): value is HostRecord => typeof value === "object" && value !== null;

/** A child slot that is another component: its own describe, its own events. */
function asComponent(value: unknown): Describable | undefined {
  if (!isObject(value)) return undefined;
  const candidate = value as Partial<Describable>;
  if (typeof candidate.describe !== "function" || typeof candidate.handleNativeEvent !== "function") return undefined;
  return value as Describable;
}

/** A child slot to descend into when reading: only its own describe is needed.
 * OMP's form fields (`TextFormField`) describe themselves but take no events
 * of their own; the dialog root takes them. */
export type DescribableChild = Pick<Describable, "describe"> & object;

export function describableChild(value: unknown): DescribableChild | undefined {
  if (!isObject(value)) return undefined;
  if (typeof (value as Partial<Describable>).describe !== "function") return undefined;
  return value as DescribableChild;
}

/** `TspText`: a plain string, or spans whose `t` pieces concatenate. */
export function tspText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((span) => (isObject(span) && typeof span.t === "string" ? span.t : "")).join("");
  }
  return "";
}

/** A node's readable text: `p.text`, else `p.spans` (styled or linked text
 * keeps its content there), or a spinner's `p.label`. Empty when it has none. */
function nodeText(node: NativeNodeLike): string {
  if (!isObject(node.p)) return "";
  if (node.k === "spinner") return tspText(node.p.label);
  return tspText(node.p.text) || tspText(node.p.spans);
}

export function describeTree(component: object): NativeNodeLike | undefined {
  const describe = (component as Partial<Describable>).describe;
  if (typeof describe !== "function") return undefined;
  try {
    const node = describe.call(component, DESCRIBE_CONTEXT);
    return isObject(node) ? (node as NativeNodeLike) : undefined;
  } catch {
    // A describe that throws is "nothing described": never take the dialog down.
    return undefined;
  }
}

/** A node of the wanted kind; props trusted only as far as each adapter's own checks. */
function nodeProps<K extends NodeKind>(node: NativeNodeLike, kind: K): NodePropsByKind[K] | undefined {
  if (node.k !== kind || !isObject(node.p)) return undefined;
  return node.p as NodePropsByKind[K];
}

/**
 * The keypath of a plain (non-component) child inside its parent's keypath
 * (reconcile.ts rules): its `key` when keyed, else its index in `children`.
 * The root's keypath is `""`, so its first segment has no leading `/`.
 */
export function childKeypath(parent: string, child: NativeNodeLike, index: number): string {
  const segment = child.key === undefined ? String(index) : String(child.key);
  return parent === "" ? segment : `${parent}/${segment}`;
}

function walkNode<K extends NodeKind>(node: NativeNodeLike, keypath: string, owner: object, kind: K, depth: number, visited: Set<object>): NodeFound<K> | undefined {
  const props = nodeProps(node, kind);
  if (props) return { owner, keypath, props };
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!isObject(child)) continue;
    const component = describableChild(child);
    if (component) {
      const found = findNodeVisited(component, kind, depth + 1, visited);
      if (found) return found;
      continue;
    }
    const childNode = child as NativeNodeLike;
    if (visited.has(childNode)) continue;
    visited.add(childNode);
    const found = walkNode(childNode, childKeypath(keypath, childNode, i), owner, kind, depth, visited);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first `picker` node in `component`'s own description, or in one of the
 * components it nests (up to {@link MAX_COMPONENT_DEPTH} boundaries deep). The
 * returned `owner` is the component whose `handleNativeEvent` takes events for
 * that node, and `keypath` is relative to that owner.
 */
export function findPicker(component: object, depth = 0): NodeFound<"picker"> | undefined {
  return findNode(component, "picker", depth);
}

/**
 * The first node of `kind` in `component`'s own description, or in one of the
 * components it nests (up to {@link MAX_COMPONENT_DEPTH} boundaries deep).
 */
function findNode<K extends NodeKind>(component: object, kind: K, depth = 0): NodeFound<K> | undefined {
  return findNodeVisited(component, kind, depth, new Set<object>());
}

function findNodeVisited<K extends NodeKind>(component: object, kind: K, depth: number, visited: Set<object>): NodeFound<K> | undefined {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return undefined;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return undefined;
  visited.add(root);
  return walkNode(root, "", component, kind, depth, visited);
}

/** A described node found by {@link findDescribedNode}: `owner` is the component whose `handleNativeEvent` takes its events, `keypath` its path inside that owner. */
export type DescribedNode = { owner: object; keypath: string; node: NativeNodeLike };

/**
 * The first node in `component`'s own description, or in a nested component it
 * describes (up to {@link MAX_COMPONENT_DEPTH} boundaries deep), that `match`
 * accepts. Matching is by shape only (`k`, `p.role`, `p.actions`, child keys);
 * nothing here reads rendered text.
 */
export function findDescribedNode(component: object, match: (node: NativeNodeLike) => boolean): DescribedNode | undefined {
  return findMatchVisited(component, match, 0, new Set<object>());
}

function findMatchVisited(component: object, match: (node: NativeNodeLike) => boolean, depth: number, visited: Set<object>): DescribedNode | undefined {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return undefined;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return undefined;
  return walkMatch(root, "", component, match, depth, visited);
}

function walkMatch(node: NativeNodeLike, keypath: string, owner: object, match: (node: NativeNodeLike) => boolean, depth: number, visited: Set<object>): DescribedNode | undefined {
  if (match(node)) return { owner, keypath, node };
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!isObject(child)) continue;
    const component = describableChild(child);
    if (component) {
      const found = findMatchVisited(component, match, depth + 1, visited);
      if (found) return found;
      continue;
    }
    const childNode = child as NativeNodeLike;
    if (visited.has(childNode)) continue;
    visited.add(childNode);
    const found = walkMatch(childNode, childKeypath(keypath, childNode, i), owner, match, depth, visited);
    if (found) return found;
  }
  return undefined;
}

/**
 * True when `component` is an OMP text prompt (login API keys): the root
 * routes keystrokes through its own `handleNativeEvent` and its description
 * tree holds an `input` node. Shared by {@link tspInputAdapter}, which drives
 * such a prompt, and {@link describesDialog}, where focus classification uses
 * it to tell an OMP login dialog from a spinner.
 */
export function describesTextInput(component: object): boolean {
  if (typeof (component as Partial<Describable>).handleNativeEvent !== "function") return false;
  return findNode(component, "input") !== undefined;
}

/**
 * True when `component` describes itself as something the TSP dialog adapters
 * below could drive - a picker, a settings page, or a plain text prompt (see
 * {@link describesTextInput}). Focus classification uses this to tell an OMP
 * dialog (model picker, settings page, login prompt) from a spinner: OMP's
 * dialogs carry `signal`/`abortController` fields like a loader does. A
 * `describe` that throws describes nothing, so this is false.
 */
export function describesDialog(component: object): boolean {
  if (findNode(component, "picker") !== undefined || findNode(component, "prefs") !== undefined) return true;
  return describesTextInput(component);
}

/**
 * True when `component`'s own description, or one of the components it nests,
 * holds an OMP login-dialog node (`omp.login.*`) or the login overlay root
 * (`omp.overlay.login`). The "only a link, waiting for the browser" form has no
 * `input` node, so {@link describesDialog} misses it. A `describe` that throws
 * describes nothing, so this is false.
 */
export function describesLoginSheet(component: object): boolean {
  return loginSheetIn(component, 0, new Set<object>());
}

function loginSheetIn(component: object, depth: number, visited: Set<object>): boolean {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return false;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return false;
  visited.add(root);
  return loginSheetNode(root, depth, visited);
}

function loginSheetNode(node: NativeNodeLike, depth: number, visited: Set<object>): boolean {
  if (isObject(node.p) && isLoginRole(node.p.role)) return true;
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return false;
  for (const child of children) {
    if (!isObject(child)) continue;
    const component = describableChild(child);
    if (component) {
      if (loginSheetIn(component, depth + 1, visited)) return true;
      continue;
    }
    if (visited.has(child)) continue;
    visited.add(child);
    if (loginSheetNode(child as NativeNodeLike, depth, visited)) return true;
  }
  return false;
}

function isLoginRole(role: unknown): boolean {
  return typeof role === "string" && (role.startsWith("omp.login.") || role === "omp.overlay.login");
}

/** The catalogue id list, honouring `order` (string entries that exist) when present. */
function visibleItems(props: PickerProps): PickerItemLike[] {
  const items = Array.isArray(props.items) ? (props.items as readonly PickerItemLike[]) : [];
  const byId = new Map<string, PickerItemLike>();
  for (const item of items) {
    if (isObject(item) && typeof item.id === "string") byId.set(item.id, item);
  }
  const ordered: PickerItemLike[] = [];
  if (Array.isArray(props.order)) {
    for (const entry of props.order) {
      if (typeof entry !== "string") continue;
      const item = byId.get(entry);
      if (item) ordered.push(item);
    }
  } else {
    ordered.push(...byId.values());
  }
  return ordered.filter((item) => !item.disabled);
}

/**
 * An item's badges as message text: `text`, with the host's tooltip `title`
 * after it when the title says something more than the text does.
 */
function pickerBadges(badges: unknown): string[] {
  if (!Array.isArray(badges)) return [];
  const shown: string[] = [];
  for (const badge of badges) {
    if (!isObject(badge) || typeof badge.text !== "string" || badge.text === "") continue;
    const title = typeof badge.title === "string" ? badge.title.trim() : "";
    const more = title !== "" && title.toLowerCase() !== badge.text.toLowerCase();
    shown.push(more ? `${badge.text} (${title})` : badge.text);
  }
  return shown;
}

/** The search hint the host gives while the box is empty, when it has one. */
function pickerPlaceholder(props: PickerProps): { placeholder?: string } {
  const placeholder = tspText(props.placeholder).trim();
  return placeholder ? { placeholder } : {};
}

/** The picker's pending confirmation: its question text and the yes action. */
type PickerConfirmLike = { text?: unknown; act?: unknown; label?: unknown };

/**
 * The open confirmation over the picker, or undefined when none is pending.
 * While one is open the host draws it in place of the list, so Telegram shows
 * it as a yes/no dialog and the list actions stay out of reach.
 */
function pickerConfirm(props: PickerProps): PickerConfirmLike | undefined {
  if (!isObject(props.confirm)) return undefined;
  const confirm = props.confirm as PickerConfirmLike;
  return typeof confirm.text === "string" && confirm.text.length > 0 ? confirm : undefined;
}

/**
 * The native event that answers an open picker confirmation: yes sends the
 * host's own confirm action, no (or Cancel) sends `close`, which the host maps
 * onto cancelling the confirmation alone. Every other action is refused.
 */
function pickerConfirmEvent(keypath: string, confirm: PickerConfirmLike, action: DialogAction): unknown {
  if (action.type === "cancel" || (action.type === "confirm" && !action.yes)) {
    return { type: "action", key: keypath, act: "close", mods: [] };
  }
  if (action.type === "confirm" && typeof confirm.act === "string" && confirm.act.length > 0) {
    return { type: "action", key: keypath, act: confirm.act, mods: [] };
  }
  return undefined;
}

/** Prefix of the synthetic keys that address a strip chip by index. */
const STRIP_KEY_PREFIX = "strip:";

/**
 * The picker's open action strip, or undefined when there is nothing to pick:
 * a null/absent strip, or one without chips (the name-entry strip wants
 * typing, not choosing, so we leave it to the terminal).
 */
function pickerStrip(props: PickerProps): StripLike | undefined {
  if (!isObject(props.strip)) return undefined;
  const strip = props.strip as Partial<StripLike>;
  if (!Array.isArray(strip.items) || strip.items.length === 0) return undefined;
  return strip as StripLike;
}

/**
 * Prefixes of the synthetic extraAction keys addressing picker entries by
 * index (tab row, scope row, action bar). The key travels verbatim inside
 * callback_data (64-byte Bot API cap) while host ids are unbounded, so the
 * key carries the array index and `act` re-resolves it against live props.
 */
const TAB_KEY_PREFIX = "tab:";
const SCOPE_KEY_PREFIX = "scope:";
const BAR_KEY_PREFIX = "act:";

/** Action-bar ids the renderer's own cancel row already covers. */
const BAR_HIDDEN_IDS: Record<string, true> = { close: true, cancel: true };

/** The tab / scope / action-bar buttons Telegram shows beside the list. */
function pickerExtraActions(props: PickerProps): { label: string; key: string }[] {
  const extras: { label: string; key: string }[] = [];
  if (Array.isArray(props.tabs)) {
    props.tabs.forEach((tab, index) => {
      if (!isObject(tab) || typeof tab.id !== "string") return;
      const marker = props.tab === tab.id ? "● " : "";
      extras.push({ label: `${marker}${tspText(tab.label)}`, key: `${TAB_KEY_PREFIX}${index}` });
    });
  }
  if (Array.isArray(props.scopes)) {
    props.scopes.forEach((scope, index) => {
      if (!isObject(scope) || typeof scope.id !== "string" || scope.disabled) return;
      const marker = props.scope === scope.id ? "● " : "";
      extras.push({ label: `${marker}${tspText(scope.label)}`, key: `${SCOPE_KEY_PREFIX}${index}` });
    });
  }
  if (Array.isArray(props.actions)) {
    props.actions.forEach((entry, index) => {
      // close/cancel are covered by the renderer's own cancel row.
      if (!isObject(entry) || typeof entry.id !== "string" || entry.disabled) return;
      if (BAR_HIDDEN_IDS[entry.id]) return;
      extras.push({ label: tspText(entry.label), key: `${BAR_KEY_PREFIX}${index}` });
    });
  }
  return extras;
}

/** The entry a synthetic key's index points at, with a usable string id. */
function entryAt(list: readonly unknown[] | undefined, raw: string): { id: string; disabled?: unknown } | undefined {
  if (!Array.isArray(list) || !/^\d+$/.test(raw)) return undefined;
  const entry = list[Number(raw)];
  return isObject(entry) && typeof entry.id === "string" ? (entry as { id: string; disabled?: unknown }) : undefined;
}

/**
 * The native event for a `tab:` / `scope:` / `act:` key, re-resolved against
 * the live props on every press: an out-of-range index, or an entry that is
 * now disabled (scopes, bar actions), is refused. A bar entry fires its own
 * id as the action name; tabs and scopes fire `tab` / `scope` carrying the
 * id as value (the OMP picker events).
 */
function pickerBarEvent(keypath: string, props: PickerProps, name: string): unknown {
  if (name.startsWith(TAB_KEY_PREFIX)) {
    const tab = entryAt(props.tabs, name.slice(TAB_KEY_PREFIX.length));
    return tab ? { type: "action", key: keypath, act: "tab", value: tab.id, mods: [] } : undefined;
  }
  if (name.startsWith(SCOPE_KEY_PREFIX)) {
    const scope = entryAt(props.scopes, name.slice(SCOPE_KEY_PREFIX.length));
    return scope && !scope.disabled ? { type: "action", key: keypath, act: "scope", value: scope.id, mods: [] } : undefined;
  }
  if (name.startsWith(BAR_KEY_PREFIX)) {
    const entry = entryAt(props.actions, name.slice(BAR_KEY_PREFIX.length));
    // Same exclusion as read: a stale `act:` key must not resurrect close/cancel.
    if (!entry || entry.disabled || BAR_HIDDEN_IDS[entry.id]) return undefined;
    return { type: "action", key: keypath, act: entry.id, mods: [] };
  }
  return undefined;
}

/**
 * Action-bar ids that act on one list row (OMP session picker's Delete, and
 * its siblings in other pickers). The host applies them to its own highlight,
 * and Telegram has no highlight to move: tapping a row activates it. So these
 * buttons first ask which row they are for, then send the host `select` for
 * that row followed by the action, the order the TUI user follows with the
 * arrow keys and the action key. Every other bar entry (the primary action,
 * scope toggles, ...) keeps firing at once.
 */
const ROW_ACTION_IDS: Record<string, true> = { delete: true, rename: true, pin: true, unpin: true };

/** Synthetic key of the "leave pick mode" button. */
const PICK_BACK_KEY = "pick:back";

/**
 * Pick mode per picker component: the row-scoped action waiting for its row.
 * Keyed by the component the picker belongs to, so a closed picker takes its
 * mode with it and a new picker starts clean.
 */
const pendingRowAction = new WeakMap<object, string>();

/** The enabled bar entry `id` names, when the live picker still offers it. */
function rowActionEntry(props: PickerProps, id: string): { id: string; label?: unknown } | undefined {
  if (!Array.isArray(props.actions)) return undefined;
  const entry = props.actions.find((candidate) => isObject(candidate) && candidate.id === id && !candidate.disabled);
  return isObject(entry) && typeof entry.id === "string" ? (entry as { id: string; label?: unknown }) : undefined;
}

/** "sessions" -> "session": the noun the picker lists, in the singular. */
function pickerNoun(props: PickerProps): string {
  const noun = typeof props.noun === "string" ? props.noun.trim() : "";
  return noun ? noun.replace(/s$/, "") : "item";
}

export const tspPickerAdapter: DialogAdapter = {
  id: "tsp-picker",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    return ctx.host === "omp" && findPicker(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const found = findPicker(component);
    if (!found) return { kind: "unsupported", what: "OMP picker closed or no longer a picker" };
    const { props } = found;
    const confirm = pickerConfirm(props);
    if (confirm) {
      const confirmLabel = tspText(confirm.label);
      return { kind: "confirm", title: tspText(confirm.text), ...(confirmLabel ? { confirmLabel } : {}) };
    }
    const strip = pickerStrip(props);
    if (strip) {
      // The strip is open (e.g. the model hub's role chips after activating a
      // model): the terminal shows the chips, so Telegram shows the chips.
      const items: DialogItem[] = strip.items.map((chip, index) => ({
        key: `${STRIP_KEY_PREFIX}${index}`,
        label: tspText(chip.label),
        current: chip.on === true,
        focused: typeof strip.selected === "string" && strip.selected === chip.id,
      }));
      return {
        kind: "select",
        title: tspText(strip.label) || "Choose a role",
        items,
        total: items.length,
      };
    }
    const pendingAction = pendingRowAction.get(found.owner);
    const pending = pendingAction === undefined ? undefined : rowActionEntry(props, pendingAction);
    if (pendingAction !== undefined && !pending) pendingRowAction.delete(found.owner);
    const currentIds = Array.isArray(props.current) ? props.current : [];
    const items: DialogItem[] = visibleItems(props).map((item) => {
      const description = item.detail === undefined ? undefined : tspText(item.detail);
      const badges = pickerBadges(item.badges);
      return {
        key: item.id as string,
        label: tspText(item.label),
        ...(description ? { description, note: description } : {}),
        ...(badges.length > 0 ? { badges } : {}),
        current: currentIds.includes(item.id),
        focused: props.selected === item.id,
      };
    });
    const extraActions = pending
      ? [
          ...pickerExtraActions(props).filter((extra) => !extra.key.startsWith(BAR_KEY_PREFIX)),
          { label: "Back", key: PICK_BACK_KEY },
        ]
      : pickerExtraActions(props);
    const search = typeof props.query === "string" ? { query: props.query, ...pickerPlaceholder(props) } : undefined;
    const title = typeof props.title === "string" ? props.title : "Select";
    const subtitle = pending
      ? `${tspText(pending.label) || pending.id}: choose a ${pickerNoun(props)}`
      : tspText(props.subtitle) || undefined;
    if (items.length === 0) {
      const text = tspText(props.empty) || tspText(props.message) || "Nothing to show";
      if (extraActions.length === 0 && !search) {
        // Nothing to choose and nothing to switch/filter/search by either
        // (e.g. `/hub` with no running agents): an info card whose only
        // action is close; `act` maps cancel onto the picker's `close`.
        return { kind: "info", title, text: subtitle ? `${subtitle}\n${text}` : text, closable: true };
      }
      // Tabs, scopes, bar actions and search still apply to an empty result
      // (e.g. `/tree` filtered down to nothing): stay a select with no rows
      // so those buttons survive, with the empty-state text in the body.
      return {
        kind: "select",
        title,
        items: [],
        total: 0,
        notice: text,
        ...(subtitle ? { subtitle } : {}),
        ...(search ? { search } : {}),
        ...(extraActions.length > 0 ? { extraActions } : {}),
      };
    }
    return {
      kind: "select",
      title,
      items,
      total: typeof props.total === "number" ? props.total : items.length,
      ...(subtitle ? { subtitle } : {}),
      ...(search ? { search } : {}),
      ...(extraActions.length > 0 ? { extraActions } : {}),
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the list may have been filtered underneath us.
    const found = findPicker(component);
    if (!found) return false;
    const { owner, keypath, props } = found;
    const confirm = pickerConfirm(props);
    if (confirm) return sendPickerEvent(owner, pickerConfirmEvent(keypath, confirm, action), ctx);
    if (action.type === "search") {
      // The picker filters through its own input box: replace its contents
      // and let the host re-filter the list.
      if (!setInputValue(component, action.query)) return false;
      try {
        ctx.requestRender();
      } catch {
        // A host without a live renderer has nothing to redraw; the text landed.
      }
      return true;
    }
    const pendingAction = pendingRowAction.get(owner);
    if (pendingAction !== undefined && action.type === "key" && action.name === PICK_BACK_KEY) {
      pendingRowAction.delete(owner);
      return requestRedraw(ctx);
    }
    if (pendingAction !== undefined && action.type === "choose" && !action.key.startsWith(STRIP_KEY_PREFIX)) {
      // The row the user picked for the waiting action: move the host's
      // highlight there, then fire the action at it.
      pendingRowAction.delete(owner);
      if (!rowActionEntry(props, pendingAction)) return false;
      if (!visibleItems(props).some((item) => item.id === action.key)) return false;
      if (!sendPickerEvent(owner, { type: "select", key: keypath, item: action.key }, ctx)) return false;
      return sendPickerEvent(owner, { type: "action", key: keypath, act: pendingAction, mods: [] }, ctx);
    }
    if (action.type === "key" && action.name.startsWith(BAR_KEY_PREFIX)) {
      const entry = entryAt(props.actions, action.name.slice(BAR_KEY_PREFIX.length));
      if (entry && ROW_ACTION_IDS[entry.id] && !entry.disabled) {
        // Nothing to aim at: the host would ignore it, so say the press did nothing.
        if (visibleItems(props).length === 0) return false;
        pendingRowAction.set(owner, entry.id);
        return requestRedraw(ctx);
      }
    }
    let target: unknown;
    if (action.type === "choose" && action.key.startsWith(STRIP_KEY_PREFIX)) {
      const raw = action.key.slice(STRIP_KEY_PREFIX.length);
      const index = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      const strip = pickerStrip(props);
      if (!strip || !Number.isInteger(index) || index >= strip.items.length) return false;
      target = { type: "action", key: keypath, act: "strip", value: String(index), mods: [] };
    } else if (action.type === "choose") {
      const catalogue = Array.isArray(props.items) ? props.items : [];
      if (!catalogue.some((item) => isObject(item) && item.id === action.key)) return false;
      target = { type: "activate", key: keypath, item: action.key };
    } else if (action.type === "key") {
      target = pickerBarEvent(keypath, props, action.name);
    } else if (action.type === "cancel") {
      target = { type: "action", key: keypath, act: "close", mods: [] };
    }
    return sendPickerEvent(owner, target, ctx);
  },
};

/** Ask the host to redraw after a change that lives only in this adapter. */
function requestRedraw(ctx: AdapterContext): boolean {
  try {
    ctx.requestRender();
  } catch {
    // A host without a live renderer has nothing to redraw; the mode still changed.
  }
  return true;
}

/**
 * Hand a native event to the picker's owner and ask the host to redraw so the
 * terminal catches up with what Telegram just showed (3E). False when there is
 * no event or the host refuses it.
 */
function sendPickerEvent(owner: object, target: unknown, ctx: AdapterContext): boolean {
  if (!target) return false;
  const handle = (owner as Partial<Describable>).handleNativeEvent;
  if (typeof handle !== "function") return false;
  try {
    handle.call(owner, target);
  } catch {
    return false;
  }
  try {
    ctx.requestRender();
  } catch {
    // A host without a live renderer has nothing to redraw; the act landed.
  }
  return true;
}

/** The live page's rows, in section order (the host only describes that page). */
function prefsRows(props: PrefsProps): PrefsRowLike[] {
  return prefsGroupedRows(props).map((entry) => entry.row);
}

/** The live page's rows with the title of the section each sits under. */
function prefsGroupedRows(props: PrefsProps): PrefsGroupedRow[] {
  const sections = Array.isArray(props.sections) ? (props.sections as readonly PrefsSectionLike[]) : [];
  const rows: PrefsGroupedRow[] = [];
  for (const section of sections) {
    if (!isObject(section) || !Array.isArray(section.rows)) continue;
    const group = tspText(section.title).trim() || undefined;
    for (const row of section.rows as readonly unknown[]) {
      if (isObject(row) && typeof (row as PrefsRowLike).id === "string") rows.push({ row: row as PrefsRowLike, group });
    }
  }
  return rows;
}

/** A choice control's usable options: entries carrying a string `value`. */
function choiceOptions(control: HostRecord): { value: string; label: string; detail?: string }[] {
  const options = Array.isArray(control.options) ? (control.options as readonly unknown[]) : [];
  const usable: { value: string; label: string; detail?: string }[] = [];
  for (const option of options) {
    if (!isObject(option) || typeof option.value !== "string") continue;
    const detail = tspText(option.detail).trim();
    usable.push({ value: option.value, label: tspText(option.label), ...(detail ? { detail } : {}) });
  }
  return usable;
}

/** How many steps a number control may enumerate as buttons before the input opens instead. */
const MAX_NUMBER_STEPS = 12;

/** How a number control shows `value`: its label when mapped, else the number with its unit. */
function numberDisplay(control: HostRecord, value: number): string {
  const named = isObject(control.labels) ? (control.labels as HostRecord)[String(value)] : undefined;
  if (typeof named === "string") return named;
  return `${value}${typeof control.unit === "string" ? control.unit : ""}`;
}

/** The values a number control can cycle between with their display text; undefined when they do not fit. */
function numberSteps(control: HostRecord): { values: number[]; labels: string[] } | undefined {
  const { min, max } = control;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || max < min) return undefined;
  const step = typeof control.step === "number" && Number.isFinite(control.step) && control.step > 0 ? control.step : 1;
  const count = (max - min) / step + 1;
  if (!Number.isInteger(count) || count > MAX_NUMBER_STEPS) return undefined;
  const values: number[] = [];
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = min + index * step;
    values.push(value);
    labels.push(numberDisplay(control, value));
  }
  return { values, labels };
}

/** The values a multi control has on, as plain strings. */
function multiSelected(control: HostRecord): string[] {
  return Array.isArray(control.values)
    ? (control.values as readonly unknown[]).filter((value): value is string => typeof value === "string")
    : [];
}

/** One row's control as the host describes it *now*: re-describe `owner` and
 * look the row up again. undefined when the row (or the page) is gone. */
function prefsRowControl(owner: object, rowId: string): HostRecord | undefined {
  const found = findNode(owner, "prefs");
  if (!found) return undefined;
  const row = prefsRows(found.props).find((candidate) => candidate.id === rowId);
  return row && isObject(row.control) ? row.control : undefined;
}

/** Whether a multi control holds exactly `wanted`, in any order. */
function sameSelection(control: HostRecord, wanted: readonly string[]): boolean {
  const selected = new Set(multiSelected(control));
  const wantedSet = new Set(wanted);
  return selected.size === wantedSet.size && [...selected].every((value) => wantedSet.has(value));
}

/**
 * Whether the host actually took a change. Sending the event proves nothing:
 * OMP silently ignores values its own editor would not offer (a number outside
 * the range/step list), so the row would keep its old value while Telegram was
 * told the press worked. A secret text control is the one value a host may keep
 * out of its description, so that one is trusted rather than compared.
 */
function prefsChangeAdopted(owner: object, rowId: string, value: unknown): boolean {
  const control = prefsRowControl(owner, rowId);
  if (!control) return false;
  if (control.k === "switch") return typeof value === "boolean" && (control.on === true) === value;
  if (control.k === "choice") return typeof value === "string" && control.value === value;
  if (control.k === "number") return typeof value === "number" && control.value === value;
  if (control.k === "text") {
    return control.secret === true || (typeof value === "string" && control.value === value);
  }
  if (control.k === "multi") {
    return Array.isArray(value)
      && value.every((entry): entry is string => typeof entry === "string")
      && sameSelection(control, value);
  }
  return false;
}

/** The row kinds whose editor this adapter keeps on the Telegram side. */
type PrefsSubmenuKind = "text" | "number" | "multi";

/** The submenu open on the plugin side, per prefs component: the row it edits and its kind. */
const prefsSubmenus = new WeakMap<object, { rowId: string; kind: PrefsSubmenuKind }>();

/** A choice's option detail for its current value, when the host gives one. */
function choiceDetail(control: HostRecord): string | undefined {
  const options = Array.isArray(control.options) ? (control.options as readonly unknown[]) : [];
  const current = options.find((option) => isObject(option) && option.value === control.value);
  const detail = isObject(current) ? tspText(current.detail).trim() : "";
  return detail || undefined;
}

/** The text after a row's label: its hint, then a choice's current-option detail. */
function prefsRowNote(row: PrefsRowLike, control: HostRecord | undefined): string | undefined {
  const hint = tspText(row.hint).trim();
  const detail = control?.k === "choice" ? choiceDetail(control) : undefined;
  const note = [hint, detail].filter((part): part is string => part !== undefined && part !== "").join(" · ");
  return note || undefined;
}

/** One prefs row as a settings item; controls Telegram cannot edit stay read-only. */
function prefsRowItem(row: PrefsRowLike, group?: string): DialogItem & { values?: string[]; hasSubmenu?: boolean } {
  const item = prefsControlItem(row);
  const control = isObject(row.control) ? row.control : undefined;
  const note = prefsRowNote(row, control);
  return { ...item, ...(note ? { note } : {}), ...(group ? { group } : {}) };
}

/** The row's label, value and submenu flag, from its control. */
function prefsControlItem(row: PrefsRowLike): DialogItem & { values?: string[]; hasSubmenu?: boolean } {
  const key = row.id as string;
  const label = tspText(row.label);
  const control = isObject(row.control) ? row.control : undefined;
  if (control?.k === "switch") {
    return { key, label, value: control.on === true ? "On" : "Off", values: ["On", "Off"] };
  }
  if (control?.k === "choice") {
    const options = choiceOptions(control);
    const current = options.find((option) => option.value === control.value);
    return {
      key,
      label,
      value: current ? current.label : typeof control.value === "string" ? control.value : "",
      values: options.map((option) => option.label),
    };
  }
  if (control?.k === "number" && typeof control.value === "number") {
    const steps = numberSteps(control);
    if (steps) return { key, label, value: numberDisplay(control, control.value), values: steps.labels };
    return { key, label, value: numberDisplay(control, control.value), hasSubmenu: true };
  }
  if (control?.k === "text") {
    const value = control.secret === true ? "•••" : typeof control.value === "string" ? control.value : "";
    return { key, label, value, hasSubmenu: true };
  }
  if (control?.k === "multi") {
    const options = choiceOptions(control);
    const value = multiSelected(control)
      .map((selected) => options.find((option) => option.value === selected)?.label ?? selected)
      .join(", ");
    return { key, label, value, hasSubmenu: true };
  }
  if (control?.k === "action") {
    return { key, label: typeof control.label === "string" && control.label ? control.label : label, value: "", hasSubmenu: true };
  }
  return { key, label, value: "(change it in the terminal)" };
}

/** The change event for cycling a settings row, or undefined when unmappable. */
function prefsChangeEvent(keypath: string, props: PrefsProps, rowKey: string, wanted?: string): unknown {
  const row = prefsRows(props).find((candidate) => candidate.id === rowKey);
  if (!row) return undefined;
  const control = isObject(row.control) ? row.control : undefined;
  if (!control) return undefined;
  if (control.k === "switch") {
    let next: boolean;
    if (wanted === "On") next = true;
    else if (wanted === "Off") next = false;
    else if (wanted === undefined) next = control.on !== true;
    else return undefined;
    return { type: "change", key: keypath, item: rowKey, value: next };
  }
  if (control.k === "choice") {
    const options = choiceOptions(control);
    if (options.length === 0) return undefined;
    if (wanted !== undefined) {
      const chosen = options.find((option) => option.label === wanted);
      if (!chosen) return undefined;
      return { type: "change", key: keypath, item: rowKey, value: chosen.value };
    }
    const current = options.findIndex((option) => option.value === control.value);
    return { type: "change", key: keypath, item: rowKey, value: options[(current + 1) % options.length].value };
  }
  if (control.k === "number") {
    const steps = numberSteps(control);
    if (!steps) return undefined;
    if (wanted !== undefined) {
      const index = steps.labels.indexOf(wanted);
      if (index < 0) return undefined;
      return { type: "change", key: keypath, item: rowKey, value: steps.values[index] };
    }
    const current = typeof control.value === "number" ? steps.values.indexOf(control.value) : -1;
    return { type: "change", key: keypath, item: rowKey, value: steps.values[(current + 1) % steps.values.length] };
  }
  return undefined;
}

/** The submenu model for the row this adapter has open; stale state is dropped. */
function prefsSubmenuModel(owner: object, props: PrefsProps): { itemKey: string; model: DialogModel } | undefined {
  const state = prefsSubmenus.get(owner);
  if (!state) return undefined;
  const row = prefsRows(props).find((candidate) => candidate.id === state.rowId);
  const control = row && isObject(row.control) ? row.control : undefined;
  if (!row || !control || control.k !== state.kind || row.disabled) {
    prefsSubmenus.delete(owner);
    return undefined;
  }
  const title = tspText(row.label);
  if (state.kind === "multi") {
    const selected = multiSelected(control);
    const items = choiceOptions(control).map((option) => ({
      key: option.value,
      label: option.label,
      checked: selected.includes(option.value),
      ...(option.detail ? { note: option.detail } : {}),
    }));
    return { itemKey: state.rowId, model: { kind: "select", title, items, total: items.length, multi: true } };
  }
  const secret = state.kind === "text" && control.secret === true;
  const current = typeof control.value === "string" ? control.value : "";
  const named = typeof control.placeholder === "string" ? control.placeholder : undefined;
  const placeholder = state.kind === "number"
    ? typeof control.value === "number" ? numberDisplay(control, control.value) : undefined
    : secret
      ? named
      : current || named;
  return {
    itemKey: state.rowId,
    model: {
      kind: "input",
      title,
      ...(placeholder ? { placeholder } : {}),
      secret,
    },
  };
}

/** An action taken while this adapter's own submenu is open on row `state.rowId`. */
function prefsSubmenuAct(
  owner: object,
  keypath: string,
  props: PrefsProps,
  state: { rowId: string; kind: PrefsSubmenuKind },
  action: DialogAction,
  ctx: AdapterContext,
): boolean {
  const row = prefsRows(props).find((candidate) => candidate.id === state.rowId);
  const control = row && isObject(row.control) ? row.control : undefined;
  if (!row || row.disabled || !control || control.k !== state.kind) {
    prefsSubmenus.delete(owner);
    return false;
  }
  const sendChange = (value: unknown): boolean => {
    const handle = (owner as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(owner, { type: "change", key: keypath, item: state.rowId, value });
    } catch {
      return false;
    }
    try {
      ctx.requestRender();
    } catch {
      // A host without a live renderer has nothing to redraw.
    }
    // The event landing is not the end of it: the host may have dropped it.
    return prefsChangeAdopted(owner, state.rowId, value);
  };
  if (action.type === "cancel" || (action.type === "submit" && action.text === undefined)) {
    // "↩ Back" and the multi-select's "⏎ Submit" leave the editor and nothing else.
    prefsSubmenus.delete(owner);
    return true;
  }
  if (action.type === "submit" && typeof action.text === "string") {
    if (state.kind === "multi") return false;
    let value: string | number = action.text;
    if (state.kind === "number") {
      const parsed = Number(action.text);
      if (!Number.isFinite(parsed)) return false; // the editor stays up for a retry
      value = parsed;
    }
    if (!sendChange(value)) return false;
    prefsSubmenus.delete(owner);
    return true;
  }
  if (action.type === "toggle" && state.kind === "multi") {
    if (!choiceOptions(control).some((option) => option.value === action.key)) return false;
    const selected = multiSelected(control);
    const next = selected.includes(action.key)
      ? selected.filter((value) => value !== action.key)
      : [...selected, action.key];
    // Every toggle applies on its own (the host's own editor is not open); the
    // submenu stays up so more options can follow.
    return sendChange(next);
  }
  return false;
}

export const tspPrefsAdapter: DialogAdapter = {
  id: "tsp-prefs",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    if (ctx.host !== "omp") return false;
    const found = findNode(component, "prefs");
    if (!found) return false;
    // `detect` runs when the broker opens a session for this component (§4.5
    // rule 1), so anything left in the submenu map belongs to a page this
    // session never showed: the terminal may have closed the settings page
    // (or switched page) without this adapter ever seeing a cancel.
    prefsSubmenus.delete(component);
    prefsSubmenus.delete(found.owner);
    return true;
  },

  read(component, ctx): DialogModel {
    const found = findNode(component, "prefs");
    if (!found) return { kind: "unsupported", what: "OMP settings page closed or no longer a settings page" };
    const { owner, props } = found;
    const currentPage = typeof props.page === "string" ? props.page : "";
    const query = typeof props.query === "string" ? props.query : "";
    const items: (DialogItem & { values?: string[]; hasSubmenu?: boolean })[] = [];
    // The current page's label is the subtitle; its lead text is the notice, which a search replaces.
    const allPages = Array.isArray(props.pages) ? (props.pages as readonly PrefsPageLike[]) : [];
    const currentLabel = tspText(allPages.find((page) => isObject(page) && page.id === currentPage)?.label).trim();
    const lead = query ? "" : tspText(props.lead).trim();
    // While a search is active the host filters rows across every page, so the
    // page shortcuts would only push the results off the first page: show the
    // matches alone, the same view the terminal gives.
    const pages = query ? [] : (Array.isArray(props.pages) ? (props.pages as readonly PrefsPageLike[]) : []);
    for (const page of pages) {
      if (!isObject(page) || typeof page.id !== "string" || page.disabled) continue;
      if (page.id === currentPage) continue;
      items.push({ key: `page:${page.id}`, label: `📄 ${tspText(page.label)}`, hasSubmenu: true });
    }
    for (const { row, group } of prefsGroupedRows(props)) {
      if (row.disabled) continue;
      items.push(prefsRowItem(row, group));
    }
    const submenu = prefsSubmenuModel(owner, props);
    // The page takes typed text as a search term whenever no submenu holds the
    // keyboard (its footer says "Type to search"), so advertise the box even
    // before the terminal has typed anything - otherwise Telegram has no way to
    // start a search, only to continue one.
    const search = { query };
    return {
      kind: "settings",
      title: typeof props.title === "string" ? props.title : "Settings",
      items,
      ...(currentLabel ? { subtitle: currentLabel } : {}),
      ...(lead ? { notice: lead } : {}),
      ...(submenu ? { submenu } : { search }),
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the page may have been switched underneath us.
    const found = findNode(component, "prefs");
    if (!found) return false;
    const { owner, keypath, props } = found;
    if (action.type === "search") {
      // The page filters through its own search field: replace its contents
      // and let the host re-filter (the same path the picker's search takes).
      if (!setInputValue(component, action.query)) return false;
      try {
        ctx.requestRender();
      } catch {
        // A host without a live renderer has nothing to redraw; the text landed.
      }
      return true;
    }
    const submenu = prefsSubmenus.get(owner);
    if (submenu) return prefsSubmenuAct(owner, keypath, props, submenu, action, ctx);
    let target: unknown;
    if (action.type === "submenu" && action.key.startsWith("page:")) {
      const pageId = action.key.slice("page:".length);
      const pages = Array.isArray(props.pages) ? (props.pages as readonly PrefsPageLike[]) : [];
      if (!pages.some((page) => isObject(page) && page.id === pageId && !page.disabled)) return false;
      target = { type: "action", key: keypath, act: "page", value: pageId, mods: [] };
    } else if (action.type === "submenu") {
      const row = prefsRows(props).find((candidate) => candidate.id === action.key);
      const control = row && isObject(row.control) ? row.control : undefined;
      if (!row || row.disabled || !control) return false;
      if (control.k === "action" && typeof control.act === "string") {
        // An action control fires its own event with its row id as `value`
        // (what the native backend sends when its button is pressed).
        target = { type: "action", key: keypath, act: control.act, value: row.id, mods: [] };
      } else if (control.k === "text" || control.k === "number" || control.k === "multi") {
        // The host's editor is a terminal widget Telegram cannot type into
        // later; keep the input on this side and remember the row it edits.
        prefsSubmenus.set(owner, { rowId: row.id as string, kind: control.k });
        return true;
      } else {
        return false;
      }
    } else if (action.type === "cycle") {
      target = prefsChangeEvent(keypath, props, action.key, action.value);
      if (!target) return false;
    } else if (action.type === "cancel") {
      target = { type: "action", key: keypath, act: "close", mods: [] };
    } else {
      return false;
    }
    const handle = (owner as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(owner, target);
    } catch {
      return false;
    }
    // Same as the picker: the page/row state changed under the terminal; the
    // host only repaints on request (3E).
    try {
      ctx.requestRender();
    } catch {
      // ignore
    }
    // A change the host dropped is a dead button, not a successful press; page
    // switches and action controls have no value to read back and stand as-is.
    const change = target as { type?: unknown; item?: unknown; value?: unknown };
    if (change.type !== "change") return true;
    return typeof change.item === "string" && prefsChangeAdopted(owner, change.item, change.value);
  },
};

/** What the document-order scan of a prompt returns: the first `input` node
 * and the plain text of the last `text` node printed before it - the prompt
 * line OMP's login dialog puts above the field. */
type PromptScan = {
  input: NodeFound<"input">;
  label?: string;
  detail?: string;
  /** The step title of a wizard step (`omp.mcpAdd.title`), when the host marks one. */
  heading?: string;
  /** The wizard's phase strip, when the field sits in a wizard. */
  steps?: { label: string; current: boolean }[];
};

type ScanState = {
  lastText?: string;
  detail: string[];
  detailSeen: Set<object>;
  heading?: string;
  steps?: { label: string; current: boolean }[];
};

/** OMP login dialog body above the field, by `p.role`: the lead text, the
 * device code, the login link (its URL text) and the local shortcut. The MCP
 * add wizard's step lead is the same kind of body text. */
const PROMPT_DETAIL_ROLES = new Set([
  "omp.login.lead",
  "omp.login.code",
  "omp.login.url",
  "omp.login.shortcut",
  "omp.mcpAdd.lead",
]);

/** The MCP add wizard's phase strip, its step title and the tone of the step on screen. */
const WIZARD_PROGRESS_ROLE = "omp.mcpAdd.progress";
const WIZARD_TITLE_ROLE = "omp.mcpAdd.title";
const WIZARD_CURRENT_TONE = "accent";

/** First text under a node, in document order: a phase segment's label. */
function firstText(node: NativeNodeLike): string {
  if (node.k === "text") return nodeText(node).trim();
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child) || describableChild(child)) continue;
    const text = firstText(child as NativeNodeLike);
    if (text) return text;
  }
  return "";
}

/** The wizard's phases in order; the one lit with the current tone is the step on screen. */
function wizardSteps(progress: NativeNodeLike): { label: string; current: boolean }[] {
  const children = Array.isArray(progress.c) ? (progress.c as unknown[]) : [];
  const steps: { label: string; current: boolean }[] = [];
  for (const child of children) {
    if (!isObject(child)) continue;
    const label = firstText(child as NativeNodeLike);
    if (!label) continue;
    const tone = isObject(child.p) ? child.p.tone : undefined;
    steps.push({ label, current: tone === WIZARD_CURRENT_TONE });
  }
  return steps;
}

/** Plain text of a detail node and its native descendants, in document order. */
function collectPromptDetail(node: NativeNodeLike, state: ScanState): void {
  if (state.detailSeen.has(node)) return;
  state.detailSeen.add(node);
  if (node.k === "text" && isObject(node.p)) {
    const text = nodeText(node).trim();
    if (text) state.detail.push(text);
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child) || describableChild(child)) continue;
    collectPromptDetail(child as NativeNodeLike, state);
  }
}

function scanPromptRoot(component: object, depth: number, visited: Set<object>, state: ScanState): PromptScan | undefined {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return undefined;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return undefined;
  visited.add(root);
  return scanPromptNode(root, component, depth, visited, state);
}

/** Depth-first, document order: stop at the first `input` node, remembering
 * the last non-empty `text` node seen on the way (component boundaries
 * descend like `walkNode` does, so the login dialog's nested
 * `TextFormField` is found and the label before it is kept). */
function scanPromptNode(node: NativeNodeLike, owner: object, depth: number, visited: Set<object>, state: ScanState): PromptScan | undefined {
  const props = nodeProps(node, "input");
  if (props) {
    const detail = state.detail.length > 0 ? state.detail.join("\n") : undefined;
    return {
      input: { owner, keypath: "", props },
      ...(state.lastText === undefined ? {} : { label: state.lastText }),
      ...(detail === undefined ? {} : { detail }),
      ...(state.heading === undefined ? {} : { heading: state.heading }),
      ...(state.steps === undefined ? {} : { steps: state.steps }),
    };
  }
  const role = isObject(node.p) && typeof node.p.role === "string" ? node.p.role : undefined;
  if (role === WIZARD_PROGRESS_ROLE) {
    // The phase strip holds labels only, no field: record it and do not let its text become the prompt's label.
    state.steps = wizardSteps(node);
    return undefined;
  }
  if (node.k === "text" && isObject(node.p)) {
    const text = tspText(node.p.text).trim();
    if (text) state.lastText = text;
    if (role === WIZARD_TITLE_ROLE && text) state.heading = text;
  }
  if (isObject(node.p) && typeof node.p.role === "string" && PROMPT_DETAIL_ROLES.has(node.p.role)) {
    collectPromptDetail(node, state);
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return undefined;
  for (const child of children) {
    if (!isObject(child)) continue;
    const component = describableChild(child);
    if (component) {
      const found = scanPromptRoot(component, depth + 1, visited, state);
      if (found) return found;
      continue;
    }
    if (visited.has(child)) continue;
    visited.add(child);
    const found = scanPromptNode(child as NativeNodeLike, owner, depth, visited, state);
    if (found) return found;
  }
  return undefined;
}

function findPrompt(component: object): PromptScan | undefined {
  return scanPromptRoot(component, 0, new Set<object>(), { detail: [], detailSeen: new Set<object>() });
}

/** Trailing hints the terminal needs but Telegram does not ("…, then press
 * Enter"): the answer arrives through the send button, so the clause says
 * nothing the user cannot infer. */
const PROMPT_HINT = /[,;]?\s*(?:and\s+)?(?:then\s+)?press\s+enter\b.*$/i;

/** The prompt line as a Telegram title: hint clause and trailing colon gone. */
function promptTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const title = text.replace(PROMPT_HINT, "").replace(/[:：;.,\s]+$/u, "").trim();
  return title === "" ? undefined : title;
}

/** Titles that name a credential: treat the field as secret even when the
 * host forgot to mask it, so Telegram deletes the answer message. */
const SECRET_TITLE = /key|token|password|secret/i;

/** Whether the host masks the field: the input's owner component (OMP's
 * `TextFormField`) or the pi-tui `Input` it wraps carries `mask: true`.
 * A field read, never a screen. */
function ownerMasks(owner: object): boolean {
  const record = owner as HostRecord;
  if (record.mask === true) return true;
  const inner = record.input;
  return isObject(inner) && inner.mask === true;
}

/**
 * OMP's built-in text prompts (login API keys): the host describes the field
 * as an `input` node and takes `{ act: "submit" | "cancel" }` on its root.
 * The answer is typed through the root's own `handleInput` (the same
 * delegation the terminal does), never by parsing what is on screen.
 */
export const tspInputAdapter: DialogAdapter = {
  id: "tsp-input",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    if (ctx.host !== "omp") return false;
    if (!describesTextInput(component)) return false;
    // A tree that also describes a picker or a settings page belongs to the
    // adapter that owns the dialog; this one only takes plain text prompts.
    if (findNode(component, "picker") !== undefined || findNode(component, "prefs") !== undefined) return false;
    return true;
  },

  read(component): DialogModel {
    const found = findPrompt(component);
    if (!found) return { kind: "unsupported", what: "OMP text prompt closed or no longer an input" };
    const title = found.heading ?? promptTitle(found.label) ?? "Input";
    const secret = ownerMasks(found.input.owner) || SECRET_TITLE.test(title);
    const placeholder = tspText(found.input.props.placeholder).trim();
    return {
      kind: "input",
      title,
      ...(placeholder ? { placeholder } : {}),
      ...(found.detail === undefined ? {} : { detail: found.detail }),
      ...(found.steps === undefined ? {} : { steps: found.steps }),
      secret,
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the prompt may be gone underneath us.
    if (findNode(component, "input") === undefined) return false;
    const handle = (component as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    let event: unknown;
    if (action.type === "submit") {
      // The dialog routes keystrokes to its current field: clear it, then
      // type. Enter is the `submit` action below, not a raw newline.
      if (!setInputValue(component, action.text ?? "")) return false;
      event = { type: "action", key: "", act: "submit", mods: [] };
    } else if (action.type === "cancel") {
      event = { type: "action", key: "", act: "cancel", mods: [] };
    } else {
      return false;
    }
    try {
      handle.call(component, event);
    } catch {
      return false;
    }
    // Same as the picker/prefs adapters: the host only repaints on request (3E).
    try {
      ctx.requestRender();
    } catch {
      // A host without a live renderer has nothing to redraw; the act landed.
    }
    return true;
  },
};

/** Lines of the login sheet's body, by `p.role`: the lead text, the device
 * code, the login link's URL and the local shortcut. */
const LOGIN_BODY_ROLES = new Set(["omp.login.lead", "omp.login.code", "omp.login.url", "omp.login.shortcut"]);

/** The status line OMP shows while it waits (progress, failure reason). */
const LOGIN_STATUS_ROLE = "omp.login.status";

/**
 * Collect the plain text of a login sheet's body and status, in document
 * order. A node counts when it, or an ancestor, carries a body role or sits
 * under the status node; text nodes contribute their trimmed text once.
 * Component boundaries descend like the other scans do.
 */
function collectLoginLines(component: object, depth: number, visited: Set<object>, lines: string[]): void {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return;
  visited.add(root);
  collectLoginNode(root, depth, visited, lines, false);
}

function collectLoginNode(node: NativeNodeLike, depth: number, visited: Set<object>, lines: string[], inside: boolean): void {
  const role = isObject(node.p) && typeof node.p.role === "string" ? node.p.role : undefined;
  const collecting = inside || (role !== undefined && (LOGIN_BODY_ROLES.has(role) || role === LOGIN_STATUS_ROLE));
  if (collecting && (node.k === "text" || node.k === "spinner") && isObject(node.p)) {
    // Each node is reached once: the loop below guards every child by `visited`.
    const text = nodeText(node).trim();
    if (text) lines.push(text);
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child)) continue;
    const component = describableChild(child);
    if (component) {
      collectLoginLines(component, depth + 1, visited, lines);
      continue;
    }
    if (visited.has(child)) continue;
    visited.add(child);
    collectLoginNode(child as NativeNodeLike, depth, visited, lines, collecting);
  }
}

/** The login overlay's heading: `p.head` of the first `overlay` node in the
 * described tree (depth-first), or a generic one. */
function loginHeading(component: object): string {
  const root = describeTree(component);
  const head = root ? overlayHead(root, new Set<object>()) : "";
  return head === "" ? "Sign in" : head;
}

function overlayHead(node: NativeNodeLike, visited: Set<object>): string {
  if (visited.has(node)) return "";
  visited.add(node);
  if (node.k === "overlay" && isObject(node.p)) {
    const head = tspText(node.p.head).trim();
    if (head !== "") return head;
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (!isObject(child)) continue;
    const head = overlayHead(child as NativeNodeLike, visited);
    if (head !== "") return head;
  }
  return "";
}

/**
 * OMP's login dialog (`/login`), as one adapter for both of its phases: the
 * "only a link, waiting for the browser" sheet (OAuth providers, and device
 * codes before any field shows) and the sheet that also holds a text field
 * (API keys, device-code confirmation). The field phase is delegated to
 * {@link tspInputAdapter}; the link phase is a progress view with Cancel,
 * built from the sheet's `omp.login.*` roles and never from its rendered text.
 */
export const tspLoginAdapter: DialogAdapter = {
  id: "tsp-login",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    if (ctx.host !== "omp") return false;
    if (!describesLoginSheet(component)) return false;
    return findNode(component, "picker") === undefined && findNode(component, "prefs") === undefined;
  },

  read(component, ctx) {
    if (findPrompt(component) !== undefined) return tspInputAdapter.read(component, ctx);
    const lines: string[] = [loginHeading(component)];
    collectLoginLines(component, 0, new Set<object>(), lines);
    return { kind: "progress", text: lines.join("\n"), cancellable: true };
  },

  act(component, action, ctx) {
    if (findNode(component, "input") !== undefined) return tspInputAdapter.act(component, action, ctx);
    if (action.type !== "cancel") return false;
    const handle = (component as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(component, { type: "action", key: "", act: "cancel", mods: [] });
    } catch {
      return false;
    }
    try {
      ctx.requestRender();
    } catch {
      // A host without a live renderer has nothing to redraw; the act landed.
    }
    return true;
  },
};
