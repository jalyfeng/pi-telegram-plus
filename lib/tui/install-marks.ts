/**
 * Install marks: "this object already has our wrapper for this key" (H6).
 *
 * The host hands out a fresh wrapper function on every read of a dialog
 * method, so identity of the function cannot tell whether we already wrapped
 * the object. The object itself is stable for the whole session, so the mark
 * is kept per object and per key (for example `race:select`, `entry:select`,
 * `hook:<name>:<kind>`).
 *
 * Pi hands the same dialog function to two objects (the tool UI context and
 * the mode), and for that case the function identity is the signal (H24):
 * the functions we have already wrapped are kept process-wide, so the second
 * object does not wrap the same function again. Two sets are kept because the
 * race and the entry hooks read different things: `tagged` is what the entry
 * hook skips (any function a wrapper touched), `raced` is what the race skips
 * (only race wrappers). Sharing one set would make the race skip the entry
 * wrapper that the same object got earlier in the attach.
 *
 * The tables are process-global, stored on `globalThis` under `Symbol.for`
 * keys: OMP imports extensions with `?mtime=` query strings and `/reload`
 * creates new module instances, and all of them must see the same marks.
 */

type InstallMarks = WeakMap<object, Set<string>>;

type FunctionMarks = {
  /** Functions a race or entry wrapper has touched (the original or the wrapper). */
  tagged: WeakSet<object>;
  /** Functions produced by the race wrapper. */
  raced: WeakSet<object>;
  /** Hook kinds per wrapped function (see `hookMethod`). */
  kinds: WeakMap<object, Set<string>>;
};

const MARKS_KEY = Symbol.for("pi-telegram-plus.install-marks");
const FUNCTION_MARKS_KEY = Symbol.for("pi-telegram-plus.install-marks.functions");

function marks(): InstallMarks {
  const holder = globalThis as unknown as Record<symbol, InstallMarks | undefined>;
  let table = holder[MARKS_KEY];
  if (!table) {
    table = new WeakMap<object, Set<string>>();
    holder[MARKS_KEY] = table;
  }
  return table;
}

function functionMarks(): FunctionMarks {
  const holder = globalThis as unknown as Record<symbol, FunctionMarks | undefined>;
  let table = holder[FUNCTION_MARKS_KEY];
  if (!table) {
    table = { tagged: new WeakSet<object>(), raced: new WeakSet<object>(), kinds: new WeakMap<object, Set<string>>() };
    holder[FUNCTION_MARKS_KEY] = table;
  }
  return table;
}

/** Whether `target` already carries the mark `key`. */
export function isMarked(target: object, key: string): boolean {
  return marks().get(target)?.has(key) ?? false;
}

/** Record that `target` now carries the mark `key`. */
export function mark(target: object, key: string): void {
  const table = marks();
  let keys = table.get(target);
  if (!keys) {
    keys = new Set<string>();
    table.set(target, keys);
  }
  keys.add(key);
}

/** Whether an entry hook or a race wrapper has already touched this function. */
export function isFunctionMarked(fn: object): boolean {
  return functionMarks().tagged.has(fn);
}

/** Record that this function is now touched by an entry hook or a race wrapper. */
export function markFunction(fn: object): void {
  functionMarks().tagged.add(fn);
}

/** Whether this function is a race wrapper, or was already raced. */
export function isFunctionRaced(fn: object): boolean {
  return functionMarks().raced.has(fn);
}

/** Record that this function is a race wrapper. */
export function markFunctionRaced(fn: object): void {
  functionMarks().raced.add(fn);
}

/** Whether this function is already wrapped by a host hook of `kind`. */
export function isFunctionKindMarked(fn: object, kind: string): boolean {
  return functionMarks().kinds.get(fn)?.has(kind) ?? false;
}

/** Record that this function is wrapped by a host hook of `kind`. */
export function markFunctionKind(fn: object, kind: string): void {
  const table = functionMarks().kinds;
  let kinds = table.get(fn);
  if (!kinds) {
    kinds = new Set<string>();
    table.set(fn, kinds);
  }
  kinds.add(kind);
}

/** Copy the hook kinds of `from` onto `to` (a wrapper inherits what it wraps). */
export function inheritFunctionKinds(from: object, to: object): void {
  const table = functionMarks().kinds;
  const inherited = table.get(from);
  if (!inherited) return;
  for (const kind of inherited) markFunctionKind(to, kind);
}
