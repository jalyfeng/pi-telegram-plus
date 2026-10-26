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
import { hookEntryMethods, UI_CONTEXT_SPECS } from "../tui/entry.ts";
import { isMarked, mark } from "../tui/install-marks.ts";
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
function attachOnce(target: Host, sink: EntrySink): void {
  hookEntryMethods(target, UI_CONTEXT_SPECS, sink, "omp");
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
