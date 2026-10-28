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

/** Whether `fn` is a wrapper this module created. */
export function isPluginWrapper(fn: unknown): boolean {
  return typeof fn === "function" && registry().wrappers.has(fn);
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
    wrapper: function ptpHook(this: unknown, ...args: unknown[]): unknown {
      return runPipeline(slot, this, args);
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
