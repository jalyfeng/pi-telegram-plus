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

/**
 * Focus-owning components that only show text (§4.6.4 #12): loaders, history
 * and debug views. Verified against both hosts, so the list is closed —
 * anything not on it is `inert`, not a panel.
 *
 * The loaders are listed separately from the rest because the real ones do bind
 * a key: pi's `BorderedLoader.handleInput` forwards Escape to the inner
 * `CancellableLoader`, which aborts the running work. A rule that bans
 * `handleInput` outright therefore never matches a loader, which is the one
 * family this adapter exists for.
 */
const CANCEL_ONLY_PANELS = new Set(["BorderedLoader", "CancellableLoader", "Loader"]);

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
    return CANCEL_ONLY_PANELS.has(name) && findShape(o, isControlShape, 2) === undefined;
  }
  // A wrapper around a live control is not a wall of text.
  return INERT_PANELS.has(name) && findShape(o, isInteractiveShape, 2) === undefined;
}
