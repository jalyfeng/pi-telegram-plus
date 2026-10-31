/**
 * Host method hooks (v8 §0.2 #19): every (object, method) pair gets at most one
 * plugin wrapper, and every plugin feature that wraps the method is a stage on
 * that wrapper's pipeline.
 *
 * Installs run again on every tick (`focus.ts` re-attaches each second), and
 * the host may hand out a new function on every read (OMP's tool UI context
 * is a Proxy that does this), so identity of the function read through
 * `object[method]` cannot tell whether we already wrapped it. The wrapper is
 * therefore located through the object's own property descriptor, which a
 * Proxy without a `getOwnPropertyDescriptor` trap forwards to the underlying
 * object.
 *
 * The registry lives on `globalThis` under `Symbol.for` keys: OMP imports
 * extensions with `?mtime=` query strings and `/reload` creates new module
 * instances, and all of them must share one wrapper per method.
 */

import { appendFileSync } from "node:fs";
import { log } from "../logger.ts";

/** A pipeline stage: call `next(args)` to continue towards the host method; return its result (or a replacement). */
export type HookStage = (next: (args: unknown[]) => unknown, args: unknown[], self: unknown) => unknown;
export type HookOptions = { priority?: number; owner?: object };

type StageEntry = { stage: HookStage; priority: number; owner?: object };

type Slot = {
  wrapper: (this: unknown, ...args: unknown[]) => unknown;
  /** The host function the stages end in. Never a plugin wrapper. */
  base: (...args: unknown[]) => unknown;
  stages: Map<string, StageEntry>;
  /**
   * Calls through this wrapper that are still on the stack. A call that comes
   * back into the wrapper while one is running (a third-party wrapper captured
   * this one and was then installed as `base`) goes straight to `original`.
   */
  active: number;
  /** The host function this slot was created around; the fallback for re-entry. */
  original: (...args: unknown[]) => unknown;
};

/**
 * Opt-in diagnostics (issue #19 acceptance). When the environment variable
 * `PITG_HOOK_STATS` names a file, every new slot is counted per `<Ctor>.<method>`,
 * and once a minute one JSON line is appended with the cumulative and per-window
 * counts and the deepest plugin-wrapper chain on any live slot. Unset: no timer,
 * no file, no counting.
 */
const STATS_ENV = "PITG_HOOK_STATS";
const STATS_INTERVAL_MS = 60_000;

type StatsTracked = { key: string; method: string; target: WeakRef<object> };
type StatsState = {
  file: string;
  startedAt: number;
  created: number;
  createdByKey: Map<string, number>;
  createdAtLastSample: number;
  tracked: StatsTracked[];
  timer?: ReturnType<typeof setInterval>;
};

type Registry = {
  /** target -> method -> slot. */
  slots: WeakMap<object, Map<string, Slot>>;
  /** Every wrapper this module created. */
  wrappers: WeakSet<object>;
  /** wrapper -> its slot, to walk `base` chains. */
  wrapperSlots: WeakMap<object, Slot>;
  /** owner -> slots that owner put a stage on. */
  owners: WeakMap<object, Set<Slot>>;
  /** Diagnostics state: undefined until first read, null when `PITG_HOOK_STATS` is unset. */
  stats?: StatsState | null;
};

const REGISTRY_KEY = Symbol.for("pi-telegram-plus.hooks");
const hookLog = log.child("tui-hooks");

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let table = holder[REGISTRY_KEY];
  if (!table) {
    table = {
      slots: new WeakMap<object, Map<string, Slot>>(),
      wrappers: new WeakSet<object>(),
      wrapperSlots: new WeakMap<object, Slot>(),
      owners: new WeakMap<object, Set<Slot>>(),
    };
    holder[REGISTRY_KEY] = table;
  }
  return table;
}

/**
 * The object that really holds `name`: `obj` itself when it has the method as
 * an own property, otherwise the first prototype in the chain that does.
 * Undefined when nothing in the chain has it.
 *
 * Reference proxies need this. pi's `mode.ui` is a Proxy over an empty target
 * whose `get`/`set`/`getPrototypeOf` forward to the real TUI and which has no
 * `getOwnPropertyDescriptor` trap, so an own-property check on the proxy never
 * sees a method. Hooking the owning prototype instead puts one wrapper on the
 * shared class method; the wrapper receives the real instance as `self`.
 */
export function methodOwner(obj: object, name: string): object | undefined {
  if (Object.getOwnPropertyDescriptor(obj, name)) return obj;
  let current: object | null = Object.getPrototypeOf(obj) as object | null;
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (Object.getOwnPropertyDescriptor(current, name)) return current;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/** Whether `fn` is a wrapper this module created. */
export function isPluginWrapper(fn: unknown): boolean {
  return typeof fn === "function" && registry().wrappers.has(fn);
}

function statsOf(reg: Registry): StatsState | undefined {
  if (reg.stats === undefined) {
    const file = process.env[STATS_ENV];
    reg.stats = file
      ? { file, startedAt: Date.now(), created: 0, createdByKey: new Map(), createdAtLastSample: 0, tracked: [] }
      : null;
  }
  return reg.stats ?? undefined;
}

function countCreatedSlot(reg: Registry, target: object, method: string): void {
  const stats = statsOf(reg);
  if (!stats) return;
  let ctor = "?";
  try {
    ctor = (Object.getPrototypeOf(target) as { constructor?: { name?: string } } | null)?.constructor?.name || "?";
  } catch {
    // a host proxy may refuse the prototype read; keep the placeholder
  }
  const key = `${ctor}.${method}`;
  stats.created += 1;
  stats.createdByKey.set(key, (stats.createdByKey.get(key) ?? 0) + 1);
  stats.tracked.push({ key, method, target: new WeakRef(target) });
  if (!stats.timer) {
    stats.timer = setInterval(() => sampleStats(reg), STATS_INTERVAL_MS);
    (stats.timer as { unref?: () => void }).unref?.();
  }
}

function sampleStats(reg: Registry): void {
  const stats = reg.stats;
  if (!stats) return;
  let maxDepth = 0;
  const depthByKey: Record<string, number> = {};
  const live: StatsTracked[] = [];
  for (const entry of stats.tracked) {
    const target = entry.target.deref();
    if (!target) continue;
    live.push(entry);
    const depth = pluginWrapperDepth(target, entry.method);
    maxDepth = Math.max(maxDepth, depth);
    depthByKey[entry.key] = Math.max(depthByKey[entry.key] ?? 0, depth);
  }
  stats.tracked = live;
  const line = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - stats.startedAt,
    created: stats.created,
    createdInWindow: stats.created - stats.createdAtLastSample,
    liveSlots: live.length,
    maxDepth,
    depthByKey,
    createdByKey: Object.fromEntries(stats.createdByKey),
  };
  stats.createdAtLastSample = stats.created;
  try {
    appendFileSync(stats.file, `${JSON.stringify(line)}\n`);
  } catch (err) {
    hookLog.debug("hook stats write failed", { err });
  }
}

function findSlot(target: object, method: string): Slot | undefined {
  return registry().slots.get(target)?.get(method);
}

/** Run the stages of `slot` in priority order (highest outermost), then the host method. */
function runPipeline(slot: Slot, self: unknown, args: unknown[]): unknown {
  const ordered = [...slot.stages.values()].sort((a, b) => b.priority - a.priority);
  const dispatch = (index: number, current: unknown[]): unknown => {
    if (index >= ordered.length) return slot.base.apply(self, current);
    const entry = ordered[index];
    return entry.stage((next) => dispatch(index + 1, next), current, self);
  };
  return dispatch(0, args);
}

function createSlot(base: (...args: unknown[]) => unknown): Slot {
  const slot: Slot = {
    base,
    stages: new Map<string, StageEntry>(),
    active: 0,
    original: base,
    wrapper: function ptpHook(this: unknown, ...args: unknown[]): unknown {
      // Re-entry (see `Slot.active`): the stages already ran for this call, so
      // only the original host function runs. Stages run once per outer call.
      if (slot.active > 0) return slot.original.apply(this, args);
      slot.active += 1;
      try {
        return runPipeline(slot, this, args);
      } finally {
        slot.active -= 1;
      }
    },
  };
  return slot;
}

/** Write `wrapper` to `target[method]`. Returns false when the write did not take effect (frozen or sealed objects). */
function writeWrapper(target: object, method: string, wrapper: Slot["wrapper"]): boolean {
  try {
    (target as Record<string, unknown>)[method] = wrapper;
  } catch (err) {
    hookLog.debug("hook write failed", { method, err });
    return false;
  }
  const own = Object.getOwnPropertyDescriptor(target, method);
  if (own?.value !== wrapper) {
    hookLog.debug("hook write did not take effect", { method });
    return false;
  }
  return true;
}

/** Put `stage` under `kind` on target[method]. Returns false when the method is missing or the object is frozen. */
export function installHook(target: object, method: string, kind: string, stage: HookStage, options?: HookOptions): boolean {
  const reg = registry();
  const entry: StageEntry = { stage, priority: options?.priority ?? 0, owner: options?.owner };
  let slot = findSlot(target, method);

  if (!slot) {
    let base: unknown;
    try {
      base = (target as Record<string, unknown>)[method];
    } catch {
      return false;
    }
    if (typeof base !== "function") return false;
    if (isPluginWrapper(base)) {
      hookLog.debug("host method is already a plugin wrapper; not wrapping it again", { method, kind });
      return false;
    }
    const created = createSlot(base as (...args: unknown[]) => unknown);
    if (!writeWrapper(target, method, created.wrapper)) return false;
    countCreatedSlot(reg, target, method);
    created.stages.set(kind, entry);
    reg.wrappers.add(created.wrapper);
    reg.wrapperSlots.set(created.wrapper, created);
    let byMethod = reg.slots.get(target);
    if (!byMethod) {
      byMethod = new Map<string, Slot>();
      reg.slots.set(target, byMethod);
    }
    byMethod.set(method, created);
    slot = created;
  } else {
    const own = Object.getOwnPropertyDescriptor(target, method);
    const value = own?.value;
    if (value === slot.wrapper) {
      // Still ours: nothing to re-write.
    } else if (typeof value === "function" && !isPluginWrapper(value)) {
      // The host really replaced the method: its new function is the base.
      hookLog.debug("host replaced hooked method; new function becomes the base", { method, kind });
      slot.base = value as (...args: unknown[]) => unknown;
      if (!writeWrapper(target, method, slot.wrapper)) return false;
    } else if (isPluginWrapper(value)) {
      // Another plugin wrapper sits on the object now: leave it alone.
      hookLog.debug("another plugin wrapper is on the hooked method; not re-writing", { method, kind });
      return false;
    } else {
      // The own property is gone (the method lives on the prototype): write ours back.
      if (!writeWrapper(target, method, slot.wrapper)) return false;
    }
    slot.stages.set(kind, entry);
  }

  if (options?.owner) {
    let owned = reg.owners.get(options.owner);
    if (!owned) {
      owned = new Set<Slot>();
      reg.owners.set(options.owner, owned);
    }
    owned.add(slot);
  }
  return true;
}

/** Remove `kind` from target[method] (only when `owner` matches, if given). The wrapper stays; with no stages it just calls the base. */
export function removeHook(target: object, method: string, kind: string, owner?: object): void {
  const slot = findSlot(target, method);
  if (!slot) return;
  const entry = slot.stages.get(kind);
  if (!entry) return;
  if (owner !== undefined && entry.owner !== owner) return;
  slot.stages.delete(kind);
}

/** Remove every stage `owner` installed (a disposed FocusTracker / runtime). */
export function removeOwnerHooks(owner: object): void {
  const reg = registry();
  const owned = reg.owners.get(owner);
  if (!owned) return;
  for (const slot of owned) {
    for (const [kind, entry] of slot.stages) {
      if (entry.owner === owner) slot.stages.delete(kind);
    }
  }
  reg.owners.delete(owner);
}

/** Test/diagnostic helper: how many plugin wrappers sit between target[method] and the host function (must be 0 or 1). */
export function pluginWrapperDepth(target: object, method: string): number {
  const reg = registry();
  let current: unknown = Object.getOwnPropertyDescriptor(target, method)?.value;
  let depth = 0;
  while (isPluginWrapper(current) && depth < 1000) {
    depth += 1;
    const slot = reg.wrapperSlots.get(current as object);
    if (!slot) break;
    current = slot.base;
  }
  return depth;
}
