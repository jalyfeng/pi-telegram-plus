/**
 * Install marks: "this object already has our wrapper for this key" (H6).
 *
 * The host hands out a fresh wrapper function on every read of a dialog
 * method, so identity of the function cannot tell whether we already wrapped
 * the object. The object itself is stable for the whole session, so the mark
 * is kept per object and per key (for example `race:select`, `entry:select`,
 * `hook:<name>:<kind>`).
 *
 * The table is process-global, stored on `globalThis` under a `Symbol.for`
 * key: OMP imports extensions with `?mtime=` query strings and `/reload`
 * creates new module instances, and all of them must see the same marks.
 */

type InstallMarks = WeakMap<object, Set<string>>;

const MARKS_KEY = Symbol.for("pi-telegram-plus.install-marks");

function marks(): InstallMarks {
  const holder = globalThis as unknown as Record<symbol, InstallMarks | undefined>;
  let table = holder[MARKS_KEY];
  if (!table) {
    table = new WeakMap<object, Set<string>>();
    holder[MARKS_KEY] = table;
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
