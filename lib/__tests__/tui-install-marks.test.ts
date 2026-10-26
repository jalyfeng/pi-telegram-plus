/**
 * Install marks (H6): the per-tick attach must wrap a host dialog method once,
 * even when the host hands out a new wrapper function on every read.
 *
 * The fake host is a Proxy whose `get` trap returns a fresh arrow function for
 * every function property, the way OMP's tool UI context does, so identity of
 * the function can never tell whether we already wrapped it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookMethod } from "../tui/host.ts";
import { installRace } from "../tui/race.ts";
import { hookEntryMethods, PI_ENTRY_SPECS, UI_CONTEXT_SPECS } from "../tui/entry.ts";
import { hasStickyMark, isMarked, mark } from "../tui/install-marks.ts";
import type { EntrySink } from "../tui/entry.ts";

type Host = Record<string, unknown>;

/** A host object that re-creates its function properties on every read. */
function hostLike(): { target: Host; raw: Host } {
  const raw: Host = {
    select: () => new Promise(() => undefined),
    confirm: () => new Promise(() => undefined),
    input: () => new Promise(() => undefined),
    label: "tool-ui",
  };
  const target = new Proxy(raw, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== "function") return value;
      const real = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => real.apply(object, args);
    },
  });
  return { target, raw };
}

function countingSink(): { sink: EntrySink; pushes: () => number } {
  let count = 0;
  const sink: EntrySink = {
    push: () => { count += 1; return {} as never; },
    pop: () => undefined,
    bind: () => undefined,
  };
  return { sink, pushes: () => count };
}

/** Run the attach the way `FocusTracker.attachEntryHooks` does on every tick. */
function tick(target: Host, sink: EntrySink, modules: { hookEntryMethods: typeof hookEntryMethods; installRace: typeof installRace }): void {
  modules.hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp");
  for (const method of ["select", "confirm", "input"] as const) modules.installRace(target, method);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("install marks are keyed by object and method", () => {
  it("records and reports a mark per object and key", () => {
    const first = {};
    const second = {};
    expect(isMarked(first, "race:select")).toBe(false);
    mark(first, "race:select");
    expect(isMarked(first, "race:select")).toBe(true);
    expect(isMarked(first, "race:confirm")).toBe(false);
    expect(isMarked(second, "race:select")).toBe(false);
  });

  it("wraps a per-read host method once across ten ticks", () => {
    const { target } = hostLike();
    const { sink, pushes } = countingSink();
    const any = vi.spyOn(AbortSignal, "any");

    for (let i = 0; i < 10; i += 1) tick(target, sink, { hookEntryMethods, installRace });

    void (target.select as (...args: unknown[]) => unknown)("Pick", ["alpha"], { signal: new AbortController().signal });
    // One entry wrapper pushed one entry, and one race wrapper ran (it is the
    // only place that combines the caller's signal with its own).
    expect(pushes()).toBe(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("keeps the mark across module instances (vi.resetModules)", async () => {
    const { target } = hostLike();
    const { sink, pushes } = countingSink();

    tick(target, sink, { hookEntryMethods, installRace });
    vi.resetModules();
    const fresh = {
      hookEntryMethods: (await import("../tui/entry.ts")).hookEntryMethods,
      installRace: (await import("../tui/race.ts")).installRace,
    };
    for (let i = 0; i < 5; i += 1) tick(target, sink, fresh);

    const any = vi.spyOn(AbortSignal, "any");
    void (target.select as (...args: unknown[]) => unknown)("Pick", ["alpha"], { signal: new AbortController().signal });
    expect(pushes()).toBe(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("does not wrap a host method twice through hookMethod either", () => {
    const { target } = hostLike();
    let before = 0;
    const hook = (): void => { before += 1; };
    expect(hookMethod(target, "select", "test-kind", hook)).toBe(true);
    for (let i = 0; i < 9; i += 1) expect(hookMethod(target, "select", "test-kind", hook)).toBe(false);

    void (target.select as (...args: unknown[]) => unknown)("Pick", []);
    expect(before).toBe(1);
  });

  it("leaves a frozen object alone and wraps a later unfrozen one", () => {
    const frozen = Object.freeze({ select: () => "host" }) as unknown as Host;
    expect(installRace(frozen, "select")).toBe(false);
    expect(isMarked(frozen, "race:select")).toBe(false);

    const open: Host = { select: () => "host" };
    expect(installRace(open, "select")).toBe(true);
    expect(isMarked(open, "race:select")).toBe(true);
    expect((open.select as () => unknown).name).toBe("ptp-race:select");
  });
});

/** Dialog methods of the UI context, all async, as OMP's tool UI context exposes them. */
const DIALOG_METHODS = ["askDialog", "select", "confirm", "input", "inputSecret", "editor", "approve", "custom"] as const;
/** Methods the per-tick attach races (the same set the focus tracker hands to `installRace`). */
const RACED_METHODS = ["askDialog", "approve", "select", "confirm", "input", "editor"] as const;

type Dialog = (...args: unknown[]) => Promise<unknown>;

/** A host whose reads hand out a fresh wrapper per function property, and whose dialogs all resolve to `answer`. */
function asyncProxiedHost(): { target: Host; answer: object } {
  const answer = { answered: "a" };
  const raw: Host = { label: "tool-ui" };
  for (const name of DIALOG_METHODS) raw[name] = async () => answer;
  const target = new Proxy(raw, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== "function") return value;
      const real = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => real.apply(object, args);
    },
  });
  return { target, answer };
}

/** One per-tick attach, as `FocusTracker.attachEntryHooks` does it. */
function attachOnce(target: Host, sink: EntrySink, scope?: object): void {
  hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp", scope);
  for (const method of RACED_METHODS) installRace(target, method);
}

const QUESTIONS = [{ id: "q", question: "?", options: [{ label: "a" }] }];

describe("long-running sessions", () => {
  it("answers askDialog after 12000 attaches without overflowing the stack", async () => {
    const { target, answer } = asyncProxiedHost();
    const { sink } = countingSink();

    for (let i = 0; i < 12000; i += 1) attachOnce(target, sink);

    const ask = target.askDialog as Dialog;
    await expect(ask(QUESTIONS, {})).resolves.toBe(answer);
  });

  it("pushes exactly one entry for askDialog after 12000 attaches", async () => {
    const { target } = asyncProxiedHost();
    const { sink, pushes } = countingSink();

    for (let i = 0; i < 12000; i += 1) attachOnce(target, sink);

    await (target.askDialog as Dialog)(QUESTIONS, {});
    expect(pushes()).toBe(1);
  });
});

/**
 * Pi hands one dialog function to two objects: the tool UI context and the
 * mode. Both expose `select` as the same function, so the second object must
 * not wrap it again (H24).
 */
function piHost(): { toolUi: Host; mode: Host; answer: object; calls: () => number } {
  const answer = { answered: "a" };
  let calls = 0;
  const shared = async () => {
    calls += 1;
    return answer;
  };
  return { toolUi: { select: shared }, mode: { select: shared }, answer, calls: () => calls };
}

const PI_ARGS = (): unknown[] => ["Pick", ["alpha"], { signal: new AbortController().signal }];

describe("pi-style host shares one dialog function between two objects", () => {
  it("wraps the shared function once, so both objects push one entry", async () => {
    const { toolUi, mode, answer, calls } = piHost();
    const { sink, pushes } = countingSink();
    for (const target of [toolUi, mode]) {
      hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "pi");
      installRace(target, "select");
    }

    await expect((toolUi.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    await expect((mode.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    expect(calls()).toBe(2);
    expect(pushes()).toBe(1);
  });

  it("still races a dialog whose object already carries our entry wrapper", () => {
    const { toolUi } = piHost();
    const { sink } = countingSink();
    hookEntryMethods(toolUi, UI_CONTEXT_SPECS, sink, "pi");

    expect(installRace(toolUi, "select")).toBe(true);
    expect((toolUi.select as { name: string }).name).toBe("ptp-race:select");
  });
});

describe("sticky marks: a mark is trusted only while the host reads the method unstably", () => {
  it("is false without a mark", () => {
    const target: Host = { select: () => "host" };
    expect(hasStickyMark(target, "select", "race:select")).toBe(false);
  });

  it("is false for a stable read, even with a mark", () => {
    const target: Host = { select: () => "host" };
    mark(target, "race:select");
    expect(hasStickyMark(target, "select", "race:select")).toBe(false);
  });

  it("is true for an unstable read (a fresh function per read) with a mark", () => {
    const { target } = hostLike();
    mark(target, "race:select");
    expect(hasStickyMark(target, "select", "race:select")).toBe(true);
  });

  it("is false when reading the property throws", () => {
    const target: Host = {};
    Object.defineProperty(target, "select", {
      get() {
        throw new Error("no read");
      },
    });
    mark(target, "race:select");
    expect(hasStickyMark(target, "select", "race:select")).toBe(false);
  });

  it("re-wraps after pi swaps the dialog out and back on the same object (stable reads)", () => {
    const ui: Host = { select: async () => "f" };
    const { sink, pushes } = countingSink();

    const attach = (): void => {
      hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, "pi");
      installRace(ui, "select");
    };
    const callPushes = (): number => {
      const before = pushes();
      void (ui.select as Dialog)(...PI_ARGS());
      return pushes() - before;
    };

    // Phase 1: the original dialog function gets our wrappers.
    attach();
    const ours = ui.select;
    expect(callPushes()).toBe(1);

    // Phase 2: the routed UI puts its own, not yet wrapped, function on the same object.
    const routed = async () => "g";
    ui.select = routed;
    attach();
    expect((ui.select as { name: string }).name).toBe("ptp-race:select");
    expect(callPushes()).toBe(1);

    // Phase 3: the routed function is put back out and our wrapper back in; no second layer.
    ui.select = ours;
    attach();
    expect((ui.select as { name: string }).name).toBe("ptp-race:select");
    expect(callPushes()).toBe(1);
  });
});

/**
 * Pi rebuilds its runtime on `/new` and `/reload`: a new FocusTracker (a new
 * scope) hooks the same mode object again. The new scope must push into its
 * own sink, and repeated attaches within one scope must not stack (H26).
 */
describe("entry hooks are scoped to one FocusTracker instance", () => {
  function piMode(): { mode: Host; calls: () => number } {
    let calls = 0;
    const proto = { showExtensionInput: async () => { calls += 1; return "x"; } };
    return { mode: Object.create(proto) as Host, calls: () => calls };
  }
  const INPUT_ARGS = (): unknown[] => ["Bot name", "unique label"];

  it("reports to the new scope's sink after a runtime rebuild (pi)", async () => {
    const { mode } = piMode();
    const sinkA = countingSink();
    const sinkB = countingSink();
    const scopeA = {};
    const scopeB = {};

    hookEntryMethods(mode, PI_ENTRY_SPECS, sinkA.sink, "pi", scopeA);
    hookEntryMethods(mode, PI_ENTRY_SPECS, sinkB.sink, "pi", scopeB);

    await (mode.showExtensionInput as Dialog)(...INPUT_ARGS());
    expect(sinkA.pushes()).toBe(1);
    expect(sinkB.pushes()).toBe(1);
  });

  it("does not stack wrappers when one scope attaches again (pi)", async () => {
    const { mode } = piMode();
    const sinkB = countingSink();
    const scopeB = {};

    hookEntryMethods(mode, PI_ENTRY_SPECS, sinkB.sink, "pi", scopeB);
    for (let i = 0; i < 10; i += 1) hookEntryMethods(mode, PI_ENTRY_SPECS, sinkB.sink, "pi", scopeB);

    await (mode.showExtensionInput as Dialog)(...INPUT_ARGS());
    expect(sinkB.pushes()).toBe(1);
  });

  it("answers askDialog after 12000 attaches in one scope (omp)", async () => {
    const { target, answer } = asyncProxiedHost();
    const { sink, pushes } = countingSink();
    const scope = {};

    for (let i = 0; i < 12000; i += 1) attachOnce(target, sink, scope);

    await expect((target.askDialog as Dialog)(QUESTIONS, {})).resolves.toBe(answer);
    expect(pushes()).toBe(1);
  });
});

/**
 * H27: pi's per-tick flow (entry hooks, then the race on the same object) must
 * not stack a new entry wrapper and a new race wrapper on every tick. The
 * race has to be scoped to the same FocusTracker as the entry hooks, or the
 * entry hook never sees the race wrapper as its own and wraps again.
 */
describe("pi per-tick attach with one scope does not stack wrappers (H27)", () => {
  const PI_TICK_METHODS = ["select", "confirm", "input"] as const;

  function stableUi(): Host {
    return {
      select: async () => "host",
      confirm: async () => "host",
      input: async () => "host",
    };
  }

  it("keeps one entry layer and one race layer after 100 ticks in one scope", async () => {
    const ui = stableUi();
    const { sink, pushes } = countingSink();
    const scope = {};
    const hookedPerTick: string[][] = [];
    const racedPerTick: boolean[][] = [];

    for (let tick = 0; tick < 100; tick += 1) {
      hookedPerTick.push(hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, "pi", scope));
      racedPerTick.push(PI_TICK_METHODS.map((method) => installRace(ui, method, scope)));
    }

    // Only the first tick wraps anything.
    for (const hooked of hookedPerTick.slice(1)) expect(hooked).toEqual([]);
    for (const raced of racedPerTick.slice(1)) expect(raced.every((installed) => !installed)).toBe(true);

    await expect((ui.select as Dialog)(...PI_ARGS())).resolves.toBe("host");
    expect(pushes()).toBe(1);
  });

  it("still resolves the host answer without a scope (old behavior, not changed)", async () => {
    const ui = stableUi();
    const { sink } = countingSink();

    for (let tick = 0; tick < 100; tick += 1) {
      hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, "pi");
      for (const method of PI_TICK_METHODS) installRace(ui, method);
    }

    await expect((ui.select as Dialog)(...PI_ARGS())).resolves.toBe("host");
  });
});

/**
 * H28: `hookMethod` marks are kept per scope (one FocusTracker). A runtime
 * rebuild creates a new tracker that must install its own event hooks on the
 * same host object; the old tracker's marks must not make it skip them.
 */
describe("hookMethod marks are scoped to one owner (H28)", () => {
  /** A host whose method reads are stable, the way pi's `setFocus` is. */
  function stableHost(): { ui: Host } {
    return { ui: { setFocus: () => undefined } };
  }

  it("lets two scopes each install their own hook on the same method", () => {
    const { ui } = stableHost();
    let beforeA = 0;
    let beforeB = 0;
    const scopeA = {};
    const scopeB = {};

    expect(hookMethod(ui, "setFocus", "focus-tracker", () => { beforeA += 1; }, undefined, scopeA)).toBe(true);
    expect(hookMethod(ui, "setFocus", "focus-tracker", () => { beforeB += 1; }, undefined, scopeB)).toBe(true);

    (ui.setFocus as (...args: unknown[]) => unknown)({});
    expect(beforeA).toBe(1);
    expect(beforeB).toBe(1);
  });

  it("does not stack a hook when one scope installs again", () => {
    const { ui } = stableHost();
    let beforeB = 0;
    const scopeB = {};
    const hook = (): void => { beforeB += 1; };

    hookMethod(ui, "setFocus", "focus-tracker", hook, undefined, scopeB);
    for (let i = 0; i < 50; i += 1) expect(hookMethod(ui, "setFocus", "focus-tracker", hook, undefined, scopeB)).toBe(false);

    (ui.setFocus as (...args: unknown[]) => unknown)({});
    expect(beforeB).toBe(1);
  });

  it("keeps one layer per scope when the host hands out a fresh function on every read", () => {
    const { target } = hostLike();
    let before = 0;
    const scope = {};
    const hook = (): void => { before += 1; };

    for (let i = 0; i < 12000; i += 1) hookMethod(target, "select", "focus-tracker", hook, undefined, scope);

    void (target.select as (...args: unknown[]) => unknown)("Pick", []);
    expect(before).toBe(1);
  });
});
