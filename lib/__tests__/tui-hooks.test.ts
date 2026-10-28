/**
 * Host method hooks (v8 §0.2 #19): one plugin wrapper per (object, method),
 * however often the attach runs and however the host or the tracker changes.
 */
import { describe, expect, it, vi } from "vitest";
import { installHook, pluginWrapperDepth, removeHook, removeOwnerHooks, isPluginWrapper } from "../tui/hooks.ts";
import type { HookStage } from "../tui/hooks.ts";

type Fn = (...args: unknown[]) => unknown;

function callMethod(target: object, method: string, ...args: unknown[]): unknown {
  return (target as Record<string, Fn>)[method](...args);
}

/** A host method that counts its calls and echoes `args[0] * 100`. */
function hostMethod(): { fn: Fn; calls: () => number } {
  let count = 0;
  const fn: Fn = (...args) => {
    count += 1;
    return (args[0] as number) * 100;
  };
  return { fn, calls: () => count };
}

/** A stage that counts its calls and continues. */
function countingStage(): { stage: HookStage; calls: () => number } {
  let count = 0;
  const stage: HookStage = (next, args) => {
    count += 1;
    return next(args);
  };
  return { stage, calls: () => count };
}

/** An OMP-style tool UI context: `get` hands out a fresh forwarding function for every function value, like `trackUserWaits`. */
function trackLike(raw: Record<string, unknown>): Record<string, unknown> {
  const cache = new Map<PropertyKey, { value: Fn; method: Fn }>();
  return new Proxy(raw, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cached = cache.get(property);
      if (cached?.value === value) return cached.method;
      const method: Fn = (...args) => (value as Fn).apply(target, args);
      cache.set(property, { value: value as Fn, method });
      return method;
    },
  });
}

describe("installHook keeps one wrapper per object and method", () => {
  it("installing the same kind 1000 times leaves one wrapper that runs the stage once", () => {
    const target: Record<string, unknown> = {};
    const host = hostMethod();
    target.m = host.fn;
    const { stage, calls } = countingStage();

    for (let i = 0; i < 1000; i += 1) installHook(target, "m", "entry", stage);

    expect(pluginWrapperDepth(target, "m")).toBe(1);
    expect(callMethod(target, "m", 2)).toBe(200);
    expect(calls()).toBe(1);
    expect(host.calls()).toBe(1);
  });

  it("OMP shape: a Proxy that hands out a new forwarder per read still gets one wrapper", () => {
    const raw: Record<string, unknown> = {};
    const host = hostMethod();
    raw.m = host.fn;
    const proxy = trackLike(raw);
    const first = countingStage();

    // One install per tick, like focus.ts's verify() once a second.
    for (let i = 0; i < 1000; i += 1) installHook(proxy, "m", "entry", first.stage);

    expect(pluginWrapperDepth(proxy, "m")).toBe(1);
    expect(callMethod(proxy, "m", 1)).toBe(100);
    expect(first.calls()).toBe(1);
    expect(host.calls()).toBe(1);

    // A new stage under the same kind replaces the old one at once.
    const second = countingStage();
    installHook(proxy, "m", "entry", second.stage);
    expect(callMethod(proxy, "m", 1)).toBe(100);
    expect(second.calls()).toBe(1);
    expect(first.calls()).toBe(1);
    expect(pluginWrapperDepth(proxy, "m")).toBe(1);
  });

  it("tracker rebuild: a second owner under the same kind replaces the first, and dispose removes only its own", () => {
    const target: Record<string, unknown> = {};
    const host = hostMethod();
    target.m = host.fn;
    const ownerA = {};
    const ownerB = {};
    const stageA = countingStage();
    const stageB = countingStage();

    installHook(target, "m", "entry", stageA.stage, { owner: ownerA });
    installHook(target, "m", "entry", stageB.stage, { owner: ownerB });
    expect(pluginWrapperDepth(target, "m")).toBe(1);
    callMethod(target, "m", 1);
    expect(stageA.calls()).toBe(0);
    expect(stageB.calls()).toBe(1);

    removeOwnerHooks(ownerA);
    callMethod(target, "m", 1);
    expect(stageB.calls()).toBe(2);

    removeOwnerHooks(ownerB);
    expect(callMethod(target, "m", 3)).toBe(300);
    expect(stageB.calls()).toBe(2);
    expect(host.calls()).toBe(3);
    expect(pluginWrapperDepth(target, "m")).toBe(1);
  });

  it("removeHook with an owner only removes a stage that owner installed", () => {
    const target: Record<string, unknown> = {};
    target.m = hostMethod().fn;
    const owner = {};
    const { stage, calls } = countingStage();
    installHook(target, "m", "entry", stage, { owner });

    removeHook(target, "m", "entry", {});
    callMethod(target, "m", 1);
    expect(calls()).toBe(1);

    removeHook(target, "m", "entry", owner);
    callMethod(target, "m", 1);
    expect(calls()).toBe(1);
    expect(pluginWrapperDepth(target, "m")).toBe(1);
  });

  it("runs stages in priority order, highest outermost, and lets stages change args and result", () => {
    const target: Record<string, unknown> = {};
    target.m = hostMethod().fn;
    const order: string[] = [];
    installHook(target, "m", "inner", (next, args) => {
      order.push("inner");
      return (next(args) as number) + 1;
    }, { priority: 1 });
    installHook(target, "m", "outer", (next, args) => {
      order.push("outer-in");
      const result = next([(args[0] as number) + 1]) as number;
      order.push("outer-out");
      return result * 10;
    }, { priority: 10 });

    // outer: args 1 -> 2; inner: host(2) = 200, +1 = 201; outer: 2010.
    expect(callMethod(target, "m", 1)).toBe(2010);
    expect(order).toEqual(["outer-in", "inner", "outer-out"]);
  });

  it("host replacing the method: the new function becomes the base, and switching back works too", () => {
    const target: Record<string, unknown> = {};
    const oldHost = hostMethod();
    target.m = oldHost.fn;
    const { stage, calls } = countingStage();
    installHook(target, "m", "entry", stage);

    const newHost = hostMethod();
    target.m = newHost.fn;
    installHook(target, "m", "entry", stage);
    expect(pluginWrapperDepth(target, "m")).toBe(1);
    expect(callMethod(target, "m", 1)).toBe(100);
    expect(newHost.calls()).toBe(1);
    expect(oldHost.calls()).toBe(0);
    expect(calls()).toBe(1);

    target.m = oldHost.fn;
    installHook(target, "m", "entry", stage);
    expect(pluginWrapperDepth(target, "m")).toBe(1);
    expect(callMethod(target, "m", 1)).toBe(100);
    expect(oldHost.calls()).toBe(1);
    expect(calls()).toBe(2);
  });

  it("a plugin wrapper copied to another object is not wrapped again", () => {
    const target: Record<string, unknown> = {};
    const host = hostMethod();
    target.m = host.fn;
    const { stage, calls } = countingStage();
    installHook(target, "m", "entry", stage);

    const other: Record<string, unknown> = {};
    other.m = target.m;
    expect(installHook(other, "m", "entry", stage)).toBe(false);
    expect(isPluginWrapper(other.m)).toBe(true);
    expect(callMethod(other, "m", 1)).toBe(100);
    expect(calls()).toBe(1);
    expect(host.calls()).toBe(1);
  });

  it("a frozen object returns false and does not throw", () => {
    const frozen = Object.freeze({ m: (): number => 1 }) as unknown as Record<string, Fn>;
    const { stage, calls } = countingStage();
    expect(() => installHook(frozen, "m", "entry", stage)).not.toThrow();
    expect(installHook(frozen, "m", "entry", stage)).toBe(false);
    expect(frozen.m()).toBe(1);
    expect(calls()).toBe(0);
  });

  it("a missing method returns false", () => {
    const { stage } = countingStage();
    expect(installHook({}, "m", "entry", stage)).toBe(false);
  });

  it("the registry is shared across module instances (vi.resetModules)", async () => {
    const target: Record<string, unknown> = {};
    const host = hostMethod();
    target.m = host.fn;
    const { stage, calls } = countingStage();
    installHook(target, "m", "entry", stage);

    vi.resetModules();
    const fresh = await import("../tui/hooks.ts");
    const again = countingStage();
    for (let i = 0; i < 5; i += 1) fresh.installHook(target, "m", "entry", again.stage);

    expect(fresh.pluginWrapperDepth(target, "m")).toBe(1);
    expect(callMethod(target, "m", 1)).toBe(100);
    expect(again.calls()).toBe(1);
    expect(calls()).toBe(0);
    expect(host.calls()).toBe(1);
  });

  it("a prototype method: the instance gets the wrapper, the prototype is untouched, and a deleted own property is re-wrapped", () => {
    class C {
      m(): number {
        return 7;
      }
    }
    const protoMethod = C.prototype.m;
    const instance = new C();
    const { stage, calls } = countingStage();

    // The stage continues to the prototype method, which ignores its args.
    expect(installHook(instance, "m", "entry", stage)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(instance, "m")).toBe(true);
    expect(isPluginWrapper(Object.getOwnPropertyDescriptor(instance, "m")?.value)).toBe(true);
    expect(C.prototype.m).toBe(protoMethod);
    expect(instance.m()).toBe(7);
    expect(calls()).toBe(1);

    delete (instance as unknown as Record<string, unknown>).m;
    expect(Object.prototype.hasOwnProperty.call(instance, "m")).toBe(false);
    installHook(instance, "m", "entry", stage);
    expect(pluginWrapperDepth(instance, "m")).toBe(1);
    expect(instance.m()).toBe(7);
    expect(calls()).toBe(2);
  });
});
