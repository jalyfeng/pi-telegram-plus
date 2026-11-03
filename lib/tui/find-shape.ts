/**
 * Shape discovery inside a host component tree (§4.1.4).
 *
 * The host may load its own copy of pi-tui, so `instanceof` is unreliable:
 * everything is decided by duck typing. Depth is capped at 3 and the walk
 * never enters message containers, which hold the whole transcript.
 */

const SKIP_FIELDS = new Set([
  "chat", "chatContainer", "messagesContainer", "messages", "transcript",
  "history", "parent", "ui", "tui", "renderer", "theme", "keybindings",
  "session", "agent", "modelRegistry", "settings", "settingsManager",
]);

export function findShape<T>(
  start: object,
  test: (candidate: unknown) => candidate is T,
  maxDepth = 3,
): T | undefined {
  const seen = new Set<unknown>();
  let frontier: unknown[] = [start];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const node of frontier) {
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (test(node)) return node;
    }
    const next: unknown[] = [];
    for (const node of frontier) {
      if (!node || typeof node !== "object") continue;
      for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
        if (SKIP_FIELDS.has(name)) continue;
        if (typeof value === "function") continue;
        if (Array.isArray(value)) {
          for (const item of value) if (item && typeof item === "object") next.push(item);
        } else if (value && typeof value === "object") {
          next.push(value);
        }
      }
    }
    frontier = next;
  }
  return undefined;
}

const fn = (o: Record<string, unknown>, name: string) => typeof o[name] === "function";
const arr = (o: Record<string, unknown>, name: string) => Array.isArray(o[name]);
const num = (o: Record<string, unknown>, name: string) => typeof o[name] === "number";

/** pi-tui `SelectList`. */
export function isSelectList(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return arr(o, "items") && num(o, "selectedIndex")
    && (fn(o, "onSelectCallback") || fn(o, "onSelect") || fn(o, "getSelectedItem"));
}

/** pi-tui `SettingsList`. */
export function isSettingsList(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return arr(o, "settings") && num(o, "selectedIndex")
    && (fn(o, "onSelectCallback") || fn(o, "onChange") || fn(o, "onToggle"));
}

/**
 * The convention every hand-drawn host selector follows (§4.1.4): a
 * `filtered*` array plus `selectedIndex` plus a submit callback.
 */
export function isFilteredList(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const filteredKey = Object.keys(o).find((k) => /^filtered[A-Z]/.test(k) && Array.isArray(o[k]));
  if (!filteredKey || !num(o, "selectedIndex")) return false;
  const submit = Object.keys(o).find((k) => /^on(Select|Change)(Callback)?$/.test(k) && typeof o[k] === "function");
  return submit !== undefined;
}

export function filteredKeyOf(o: Record<string, unknown>): string | undefined {
  return Object.keys(o).find((k) => /^filtered[A-Z]/.test(k) && Array.isArray(o[k]));
}

/** pi-tui `Input`. */
export function isInputShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return fn(o, "getValue") && fn(o, "handleInput");
}

/** pi-tui `Editor` / `CustomEditor`. */
export function isEditorShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return fn(o, "getText") && fn(o, "setText") && fn(o, "handleInput");
}

/** Anything that can take keyboard input, i.e. a dialog component. */
export function isInteractiveShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).handleInput === "function";
}

/** An AbortSignal's shape: the `aborted` flag and a way to listen for the abort. */
function isAbortSignalShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const signal = value as Record<string, unknown>;
  return typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function";
}

/** The describe tree's root node of a component, read without rendering it; undefined when it has none. */
function describedRoot(o: Record<string, unknown>): { k?: unknown; p?: unknown } | undefined {
  if (typeof o.describe !== "function") return undefined;
  try {
    const root = (o.describe as () => unknown).call(o);
    return typeof root === "object" && root !== null ? (root as { k?: unknown; p?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A waiting box that Escape aborts through (§4.6.4 #12), by structure only: its `signal` is an AbortSignal,
 * and it says that Escape is its cancel: pi's BorderedLoader with its public `cancellable` flag, the
 * `onAbort` hook the cancellable loaders call on Escape, or OMP's loader card (describe root `card` with
 * role `omp.hook.loader`). Class names are never read: OMP ships minified classes.
 */
export function isCancelOnlyLoader(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (!isAbortSignalShape(o.signal)) return false;
  if (o.cancellable === true || "onAbort" in o) return true;
  const root = describedRoot(o);
  const props = root?.p as Record<string, unknown> | undefined;
  return root?.k === "card" && props?.role === "omp.hook.loader";
}

/** Panels that bind nothing at all. */
const INERT_PANELS = new Set(["BtwHistoryPanel", "BackgroundToolsPanel", "CustomMessage", "Container", "Panel"]);

/** Real choice/text controls: a panel must not hide one of these. */
export const isControlShape = (value: unknown): value is Record<string, unknown> =>
  isSelectList(value) || isInputShape(value) || isEditorShape(value) || isFilteredList(value);

export function isReadOnlyPanel(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (!fn(o, "render")) return false;
  const name = Object.getPrototypeOf(o)?.constructor?.name ?? "";
  if (fn(o, "handleInput")) {
    // Escape-to-cancel is the only binding a loader has, and it is only a
    // panel while nothing it wraps still expects to be typed into.
    return isCancelOnlyLoader(o) && findShape(o, isControlShape, 2) === undefined;
  }
  // A wrapper around a live control is not a wall of text.
  return INERT_PANELS.has(name) && findShape(o, isInteractiveShape, 2) === undefined;
}
