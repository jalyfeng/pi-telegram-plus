/**
 * Host method hooks on the real entry, race and host-hook code (v8 §0.2 #19, H-2).
 *
 * Every (object, method) gets one plugin wrapper (`tui/hooks.ts`); the entry
 * hooks, the race and the host hooks are stages on it. The fake hosts here hand
 * out a fresh function on every read (OMP's tool UI context is a Proxy that
 * does this), so identity of the function cannot be what tells us a method is
 * already wrapped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookMethod } from "../tui/host.ts";
import { installRace, takePendingRace, type RaceHandle } from "../tui/race.ts";
import { hookEntryMethods, PI_ENTRY_SPECS, UI_CONTEXT_SPECS, type EntrySink } from "../tui/entry.ts";
import { isPluginWrapper, pluginWrapperDepth, removeOwnerHooks } from "../tui/hooks.ts";

type Host = Record<string, unknown>;
type Dialog = (...args: unknown[]) => Promise<unknown>;

/** Dialog methods of the UI context, as OMP's tool UI context exposes them. */
const DIALOG_METHODS = ["askDialog", "select", "confirm", "input", "inputSecret", "editor", "approve", "custom"] as const;
/** Methods the per-tick attach races on OMP (the set the focus tracker hands to `installRace`). */
const RACED_METHODS = ["askDialog", "approve", "select", "confirm", "input", "editor"] as const;
const PI_TICK_METHODS = ["select", "confirm", "input"] as const;

const QUESTIONS = [{ id: "q", question: "?", options: [{ label: "a" }] }];
const PI_ARGS = (): unknown[] => ["Pick", ["alpha"], { signal: new AbortController().signal }];
const INPUT_ARGS = (): unknown[] => ["Bot name", "unique label"];

/** Wrap an object so every function read hands out a fresh forwarding function. */
function freshReads(raw: Host): Host {
  return new Proxy(raw, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value !== "function") return value;
      const real = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => real.apply(object, args);
    },
  });
}

/** A host object that re-creates its function properties on every read. */
function hostLike(): Host {
  return freshReads({
    select: () => new Promise(() => undefined),
    confirm: () => new Promise(() => undefined),
    input: () => new Promise(() => undefined),
    label: "tool-ui",
  });
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

/** An OMP tool UI context whose dialogs all resolve to `answer` unless raced; `askDialog` keeps the race handle it was given. */
function ompHost(): { target: Host; answer: object; handles: Array<RaceHandle | undefined> } {
  const answer = { answered: "a" };
  const handles: Array<RaceHandle | undefined> = [];
  const raw: Host = { label: "tool-ui" };
  for (const name of DIALOG_METHODS) raw[name] = async () => answer;
  raw.askDialog = () => {
    handles.push(takePendingRace());
    return new Promise(() => undefined);
  };
  return { target: freshReads(raw), answer, handles };
}

/** One per-tick OMP attach, as `FocusTracker.attachEntryHooks` does it. */
function attachOnce(target: Host, sink: EntrySink, scope?: object): void {
  hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp", scope);
  for (const method of RACED_METHODS) installRace(target, method, scope);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one plugin wrapper per host method", () => {
  it("wraps a per-read host method once across ten ticks", () => {
    const target = hostLike();
    const { sink, pushes } = countingSink();
    const any = vi.spyOn(AbortSignal, "any");

    for (let i = 0; i < 10; i += 1) attachOnce(target, sink);
    expect(pluginWrapperDepth(target, "select")).toBe(1);

    void (target.select as Dialog)(...PI_ARGS());
    // One entry stage pushed one entry, and one race stage ran (the only place
    // that combines the caller's signal with its own).
    expect(pushes()).toBe(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("keeps the single wrapper across module instances (vi.resetModules)", async () => {
    const target = hostLike();
    const { sink, pushes } = countingSink();

    attachOnce(target, sink);
    vi.resetModules();
    const fresh = {
      hookEntryMethods: (await import("../tui/entry.ts")).hookEntryMethods,
      installRace: (await import("../tui/race.ts")).installRace,
    };
    for (let i = 0; i < 5; i += 1) {
      fresh.hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp");
      for (const method of ["select", "confirm", "input"] as const) fresh.installRace(target, method);
    }

    expect(pluginWrapperDepth(target, "select")).toBe(1);
    const any = vi.spyOn(AbortSignal, "any");
    void (target.select as Dialog)(...PI_ARGS());
    expect(pushes()).toBe(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("a frozen object returns false from both hooks and does not throw", () => {
    const frozen = Object.freeze({ select: () => "host" }) as unknown as Host;
    expect(() => installRace(frozen, "select")).not.toThrow();
    expect(installRace(frozen, "select")).toBe(false);
    expect(() => hookMethod(frozen, "select", "frozen-kind", () => undefined)).not.toThrow();
    expect(hookMethod(frozen, "select", "frozen-kind", () => undefined)).toBe(false);
    expect((frozen.select as () => unknown)()).toBe("host");
  });

  it("a method installed again with the same kind does not stack a layer", () => {
    const target = hostLike();
    let before = 0;
    const hook = (): void => { before += 1; };

    for (let i = 0; i < 10; i += 1) hookMethod(target, "select", "test-kind", hook);
    expect(pluginWrapperDepth(target, "select")).toBe(1);

    void (target.select as Dialog)("Pick", []);
    expect(before).toBe(1);
  });

  it("answers askDialog and pushes one entry after 12000 attaches", async () => {
    const { target, answer, handles } = ompHost();
    const { sink, pushes } = countingSink();

    for (let i = 0; i < 12000; i += 1) attachOnce(target, sink);

    const pending = (target.askDialog as Dialog)(QUESTIONS, {});
    expect(handles[0]).toBeDefined();
    expect(handles[0]?.answer(answer)).toBe(true);
    await expect(pending).resolves.toBe(answer);
    expect(pushes()).toBe(1);
    expect(pluginWrapperDepth(target, "askDialog")).toBe(1);
  });

  it("a host hook installed for a scope is replaced by the next scope's hook", () => {
    const ui: Host = { setFocus: () => undefined };
    let beforeA = 0;
    let beforeB = 0;
    const scopeA = {};
    const scopeB = {};

    hookMethod(ui, "setFocus", "focus-tracker", () => { beforeA += 1; }, undefined, scopeA);
    hookMethod(ui, "setFocus", "focus-tracker", () => { beforeB += 1; }, undefined, scopeB);
    expect(pluginWrapperDepth(ui, "setFocus")).toBe(1);

    (ui.setFocus as (...args: unknown[]) => unknown)({});
    expect(beforeA).toBe(0);
    expect(beforeB).toBe(1);
  });

  it("keeps one layer per host hook when the host hands out a fresh function on every read", () => {
    const target = hostLike();
    let before = 0;
    const scope = {};
    const hook = (): void => { before += 1; };

    for (let i = 0; i < 12000; i += 1) hookMethod(target, "select", "focus-tracker", hook, undefined, scope);
    expect(pluginWrapperDepth(target, "select")).toBe(1);

    void (target.select as Dialog)("Pick", []);
    expect(before).toBe(1);
  });
});

describe("pi-style host shares one dialog function between two objects", () => {
  it("each object wraps itself, and every call pushes exactly one entry", async () => {
    const answer = { answered: "a" };
    let calls = 0;
    const shared = async () => {
      calls += 1;
      return answer;
    };
    const toolUi: Host = { select: shared };
    const mode: Host = { select: shared };
    const { sink, pushes } = countingSink();
    for (const target of [toolUi, mode]) {
      hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "pi");
      installRace(target, "select");
    }

    await expect((toolUi.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    await expect((mode.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    expect(calls).toBe(2);
    expect(pushes()).toBe(2);
  });

  it("still races a dialog whose object already carries our entry wrapper", () => {
    const toolUi: Host = { select: async () => "host" };
    const { sink } = countingSink();
    hookEntryMethods(toolUi, UI_CONTEXT_SPECS, sink, "pi");

    expect(installRace(toolUi, "select")).toBe(true);
    expect(isPluginWrapper(toolUi.select)).toBe(true);
    expect(pluginWrapperDepth(toolUi, "select")).toBe(1);
  });
});

describe("pi per-tick attach with one scope does not stack wrappers (H27)", () => {
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

    for (let tick = 0; tick < 100; tick += 1) {
      hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, "pi", scope);
      for (const method of PI_TICK_METHODS) installRace(ui, method, scope);
    }
    for (const method of PI_TICK_METHODS) expect(pluginWrapperDepth(ui, method)).toBe(1);

    await expect((ui.select as Dialog)(...PI_ARGS())).resolves.toBe("host");
    expect(pushes()).toBe(1);
  });

  it("keeps one layer and one entry per call without a scope either", async () => {
    const ui = stableUi();
    const { sink, pushes } = countingSink();

    for (let tick = 0; tick < 100; tick += 1) {
      hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, "pi");
      for (const method of PI_TICK_METHODS) installRace(ui, method);
    }
    expect(pluginWrapperDepth(ui, "select")).toBe(1);

    await expect((ui.select as Dialog)(...PI_ARGS())).resolves.toBe("host");
    expect(pushes()).toBe(1);
  });
});

/**
 * H26: pi rebuilds its runtime on `/new` and `/reload`. The new FocusTracker
 * (a new scope) hooks the same mode object again and takes over the entry
 * stage, so its own sink gets the entries and the old one gets none.
 */
describe("entry hooks follow the FocusTracker that attached last", () => {
  function piMode(): { mode: Host; calls: () => number } {
    let calls = 0;
    const proto = { showExtensionInput: async () => { calls += 1; return "x"; } };
    return { mode: Object.create(proto) as Host, calls: () => calls };
  }

  it("reports to the new tracker's sink after a runtime rebuild (pi)", async () => {
    const { mode, calls } = piMode();
    const sinkA = countingSink();
    const sinkB = countingSink();

    hookEntryMethods(mode, PI_ENTRY_SPECS, sinkA.sink, "pi", {});
    hookEntryMethods(mode, PI_ENTRY_SPECS, sinkB.sink, "pi", {});
    expect(pluginWrapperDepth(mode, "showExtensionInput")).toBe(1);

    await (mode.showExtensionInput as Dialog)(...INPUT_ARGS());
    expect(calls()).toBe(1);
    expect(sinkA.pushes()).toBe(0);
    expect(sinkB.pushes()).toBe(1);
  });

  it("does not stack wrappers when one scope attaches again (pi)", async () => {
    const { mode } = piMode();
    const sinkB = countingSink();
    const scopeB = {};

    for (let i = 0; i < 11; i += 1) hookEntryMethods(mode, PI_ENTRY_SPECS, sinkB.sink, "pi", scopeB);
    expect(pluginWrapperDepth(mode, "showExtensionInput")).toBe(1);

    await (mode.showExtensionInput as Dialog)(...INPUT_ARGS());
    expect(sinkB.pushes()).toBe(1);
  });
});

describe("removing an owner's hooks", () => {
  it("passes calls straight to the host once its owner's entry and race stages are removed", async () => {
    const answer = { answered: "host" };
    const handles: Array<RaceHandle | undefined> = [];
    const raw: Host = {
      select: async () => {
        handles.push(takePendingRace());
        return answer;
      },
    };
    const target = freshReads(raw);
    const { sink, pushes } = countingSink();
    const owner = {};

    hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp", owner);
    installRace(target, "select", owner);

    await expect((target.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    expect(pushes()).toBe(1);
    expect(handles[0]).toBeDefined();

    removeOwnerHooks(owner);

    await expect((target.select as Dialog)(...PI_ARGS())).resolves.toBe(answer);
    expect(pushes()).toBe(1);
    expect(handles[1]).toBeUndefined();
  });
});

describe("OMP-shaped host after 1000 full attaches", () => {
  it("keeps one plugin layer per method, and askDialog is answered by the race with one entry", async () => {
    const { target, answer, handles } = ompHost();
    const { sink, pushes } = countingSink();

    for (let i = 0; i < 1000; i += 1) {
      hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp");
      for (const method of RACED_METHODS) installRace(target, method);
    }

    for (const method of DIALOG_METHODS) expect(pluginWrapperDepth(target, method)).toBe(1);

    const pending = (target.askDialog as Dialog)(QUESTIONS, {});
    handles[0]?.answer(answer);
    await expect(pending).resolves.toBe(answer);
    expect(pushes()).toBe(1);
  });
});
