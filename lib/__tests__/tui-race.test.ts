/**
 * UI race tests (§4.12, decision 53).
 *
 * The race wrapper turns an extension's `ui.select` into a two-way contest:
 * the Telegram handle's `answer()` versus the host dialog's own promise.
 * These drive the wrapper against a fake host method that records the signal
 * it was handed and resolves only when the test says so - the point is which
 * side wins, whether the loser's signal aborts, and that the entry layer
 * still sees the call (`pushEntry` takes the handle before the host runs).
 */
import { describe, expect, it, vi } from "vitest";
import { installRace, takePendingRace, type RaceHandle } from "../tui/race.ts";
import { isPluginWrapper, pluginWrapperDepth } from "../tui/hooks.ts";
import { extensionEditorAdapter, extensionInputAdapter, extensionSelectAdapter } from "../tui/adapters/extension.ts";
import { approvalAdapter } from "../tui/adapters/approval.ts";
import { hookEntryMethods, UI_CONTEXT_SPECS } from "../tui/entry.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

type FakeHost = {
  target: Record<string, unknown>;
  /** What the fake host method saw on each call. */
  seen: { signals: AbortSignal[]; handles: (RaceHandle | undefined)[]; opts: unknown[]; editorOptions: unknown[] };
  /** Settle the n-th dialog the way the terminal user would. */
  settle: Array<(value: unknown) => void>;
  reject: Array<(error: unknown) => void>;
};

function fakeHost(options?: { confirmViaSelector?: boolean }): FakeHost {
  const seen = { signals: [] as AbortSignal[], handles: [] as (RaceHandle | undefined)[], opts: [] as unknown[], editorOptions: [] as unknown[] };
  const settle: Array<(value: unknown) => void> = [];
  const reject: Array<(error: unknown) => void> = [];
  /** Every dialog method has the same shape: the third argument carries `signal`. */
  const open = (opts?: { signal?: AbortSignal }): unknown => {
    seen.signals.push((opts?.signal ?? null) as AbortSignal);
    seen.handles.push(takePendingRace());
    seen.opts.push(opts);
    const { promise, resolve, reject: fail } = Promise.withResolvers<unknown>();
    settle.push(resolve);
    reject.push(fail);
    return promise;
  };
  const target: Record<string, unknown> = {
    select(_title: string, _options: string[], opts?: { signal?: AbortSignal }) {
      return open(opts);
    },
    confirm(title: string, _message: string, opts?: { signal?: AbortSignal }) {
      if (options?.confirmViaSelector) return (target.select as (...a: unknown[]) => unknown)(title, ["Yes", "No"], opts);
      return open(opts);
    },
    input(_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) {
      return open(opts);
    },
    /** OMP's editor: options at index 2, `editorOptions` survives at index 3. */
    editor(_title: string, _prefill?: string, opts?: { signal?: AbortSignal }, editorOptions?: unknown) {
      seen.editorOptions.push(editorOptions);
      return open(opts);
    },
    /** OMP's approve: the prompt is the only positional, options sit at index 1. */
    approve(_prompt: unknown, opts?: { signal?: AbortSignal }) {
      return open(opts ?? {});
    },
    /** OMP's ask tool: `askDialog(questions, dialogOptions?)`, options second. */
    askDialog(_questions: unknown, opts?: { signal?: AbortSignal }) {
      return open(opts ?? {});
    },
  };
  return { target, seen, settle, reject };
}

/** Calls the wrapped `select` on a fake target with a usable signature. */
function callSelect(target: Record<string, unknown>) {
  return (title: string, options: string[], opts?: Record<string, unknown>): Promise<unknown> =>
    (target.select as (title: string, options: string[], opts?: Record<string, unknown>) => Promise<unknown>)(title, options, opts);
}

/** Calls the wrapped `confirm` on a fake target with a usable signature. */
function callConfirm(target: Record<string, unknown>) {
  return (title: string, message: string, opts?: Record<string, unknown>): Promise<unknown> =>
    (target.confirm as (title: string, message: string, opts?: Record<string, unknown>) => Promise<unknown>)(title, message, opts);
}

/** Calls the wrapped `input` on a fake target with a usable signature. */
function callInput(target: Record<string, unknown>) {
  return (title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<unknown> =>
    (target.input as (title: string, placeholder?: string, opts?: Record<string, unknown>) => Promise<unknown>)(title, placeholder, opts);
}

/** Calls the wrapped `editor` on a fake target with OMP's full 4-argument signature. */
function callEditor(target: Record<string, unknown>) {
  return (title: string, prefill?: string, opts?: Record<string, unknown>, editorOptions?: unknown): Promise<unknown> =>
    (target.editor as (title: string, prefill?: string, opts?: Record<string, unknown>, editorOptions?: unknown) => Promise<unknown>)(title, prefill, opts, editorOptions);
}

/** Calls the wrapped `approve` on a fake target: OMP built-ins pass no dialogOptions. */
function callApprove(target: Record<string, unknown>) {
  return (prompt: unknown, opts?: Record<string, unknown>): Promise<unknown> =>
    (target.approve as (prompt: unknown, opts?: Record<string, unknown>) => Promise<unknown>)(prompt, opts);
}

describe("race wrapper (installRace)", () => {
  it("a plugin answer wins, aborts the host signal, and drops the host's late undefined", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "select")).toBe(true);
    const dialog = callSelect(target)("Pick", ["alpha", "beta"], {});
    const handle = seen.handles[0];
    expect(handle).toBeDefined();
    expect(handle?.settled).toBe(false);
    expect(handle?.answer("beta")).toBe(true);
    await expect(dialog).resolves.toBe("beta");
    expect(seen.signals[0]?.aborted).toBe(true);
    // The host dialog closes ~2 ms later with `undefined`; that must not move the answer.
    settle[0]?.(undefined);
    await Promise.resolve();
    await expect(dialog).resolves.toBe("beta");
    expect(handle?.settled).toBe(true);
    expect(handle?.answer("alpha")).toBe(false);
  });

  it("a host answer wins first and later answers return false", async () => {
    const { target, seen, settle } = fakeHost();
    installRace(target, "select");
    const dialog = callSelect(target)("Pick", ["alpha", "beta"], {});
    const handle = seen.handles[0];
    settle[0]?.("alpha");
    await expect(dialog).resolves.toBe("alpha");
    expect(handle?.settled).toBe(true);
    expect(handle?.answer("beta")).toBe(false);
    expect(seen.signals[0]?.aborted).toBe(false);
  });

  it("a host rejection still reaches the extension", async () => {
    const { target, seen, reject } = fakeHost();
    installRace(target, "select");
    const dialog = callSelect(target)("Pick", ["alpha"], {});
    reject[0]?.(new Error("host died"));
    await expect(dialog).rejects.toThrow("host died");
    expect(seen.handles[0]?.settled).toBe(true);
  });

  it("confirm: a plugin answer wins, a host answer wins when it is first", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "confirm")).toBe(true);
    const pluginWins = callConfirm(target)("Sure?", "Delete it", {});
    expect(seen.handles[0]?.settled).toBe(false);
    expect(seen.handles[0]?.answer(true)).toBe(true);
    await expect(pluginWins).resolves.toBe(true);
    expect(seen.signals[0]?.aborted).toBe(true);
    // The terminal user answering first still wins: pi cancels with `false`.
    const hostWins = callConfirm(target)("Sure?", "Delete it", {});
    settle[1]?.(false);
    await expect(hostWins).resolves.toBe(false);
    expect(seen.handles[1]?.settled).toBe(true);
    expect(seen.handles[1]?.answer(true)).toBe(false);
    expect(seen.signals[1]?.aborted).toBe(false);
  });

  it("input: a plugin answer wins, a host answer wins when it is first", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "input")).toBe(true);
    const pluginWins = callInput(target)("Name", "your name", {});
    expect(seen.handles[0]?.answer("hello")).toBe(true);
    await expect(pluginWins).resolves.toBe("hello");
    expect(seen.signals[0]?.aborted).toBe(true);
    // Cancelling an input is `undefined`, what the host would have returned.
    const hostWins = callInput(target)("Name", "your name", {});
    settle[1]?.(undefined);
    await expect(hostWins).resolves.toBeUndefined();
    expect(seen.handles[1]?.settled).toBe(true);
    expect(seen.handles[1]?.answer("late")).toBe(false);
  });

  it("the caller's own signal still aborts the signal the host receives", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select");
    const caller = new AbortController();
    callSelect(target)("Pick", ["alpha"], { signal: caller.signal });
    expect(seen.signals[0]?.aborted).toBe(false);
    caller.abort();
    expect(seen.signals[0]?.aborted).toBe(true);
  });

  it("keeps the other option fields the caller passed", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select");
    callSelect(target)("Pick", ["alpha"], { placeholder: "keep me" });
    const opts = seen.opts[0] as Record<string, unknown>;
    expect(opts?.placeholder).toBe("keep me");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("registers the handle for the host call's synchronous run only", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select");
    callSelect(target)("Pick", ["alpha"], {});
    expect(seen.handles[0]).toBeInstanceOf(Object);
    expect(takePendingRace()).toBeUndefined();
  });

  it("installs one layer per method and stays identifiable as a plugin wrapper", () => {
    const { target, seen } = fakeHost();
    for (const method of ["select", "confirm", "input"] as const) {
      expect(installRace(target, method)).toBe(true);
      expect(installRace(target, method)).toBe(true);
      expect(pluginWrapperDepth(target, method)).toBe(1);
      expect(isPluginWrapper(target[method])).toBe(true);
    }
    callSelect(target)("Pick", ["alpha"], {});
    expect(seen.handles[0]).toBeDefined();
  });

  it("editor: the options go in at index 2 and editorOptions survives at index 3", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "editor")).toBe(true);
    const editorOptions = { multiLine: true };
    const dialog = callEditor(target)("Compose", "draft", { placeholder: "keep me" }, editorOptions);
    const opts = seen.opts[0] as Record<string, unknown>;
    expect(opts?.placeholder).toBe("keep me");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(seen.editorOptions[0]).toBe(editorOptions);
    expect(seen.editorOptions[0]).not.toHaveProperty("signal");
    const handle = seen.handles[0];
    expect(handle?.answer("typed")).toBe(true);
    await expect(dialog).resolves.toBe("typed");
    expect(seen.signals[0]?.aborted).toBe(true);
    // The terminal user answering first still wins.
    const hostWins = callEditor(target)("Compose", "draft", undefined, editorOptions);
    settle[1]?.("from editor");
    await expect(hostWins).resolves.toBe("from editor");
    expect(seen.handles[1]?.settled).toBe(true);
  });

  it("approve: the wrapped call supplies the options object at index 1", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "approve")).toBe(true);
    // OMP's built-in tool approval passes no dialogOptions at all.
    const dialog = callApprove(target)({ full: "Run `git push`?", compact: "git push?", session: "all session" });
    const opts = seen.opts[0] as Record<string, unknown>;
    expect(opts).toBeDefined();
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(seen.handles[0]?.answer("session")).toBe(true);
    await expect(dialog).resolves.toBe("session");
    expect(seen.signals[0]?.aborted).toBe(true);
    const hostWins = callApprove(target)({ full: "Run `git push`?", compact: "git push?" });
    settle[1]?.("deny");
    await expect(hostWins).resolves.toBe("deny");
    // A caller-supplied signal still composes with the abort.
    const caller = new AbortController();
    callApprove(target)({ full: "x?" }, { signal: caller.signal, other: 1 });
    const merged = seen.opts[2] as Record<string, unknown>;
    expect(merged?.other).toBe(1);
    caller.abort();
    expect((seen.signals[2] as AbortSignal).aborted).toBe(true);
  });
});

describe("extensionSelectAdapter with a race handle", () => {
  function raceCtx(race: RaceHandle | undefined, kind: EntryInfo["kind"] = "select") {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind, source: "pi", title: "Pick", options: ["alpha", "beta"], race };
    const ctx = { host: "pi", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    return { ctx, sendKey };
  }

  const live = (): { handle: RaceHandle; answer: (value: unknown) => boolean } => {
    const answer = vi.fn(() => true);
    return { handle: { answer, settled: false }, answer };
  };

  it("choose answers the extension call with the row's label, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "choose", key: "1:beta" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("beta");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with undefined, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("confirm yes answers the extension call with true, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "confirm", yes: true }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(true);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("confirm no answers with false", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "confirm", yes: false }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(false);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("confirm cancel answers with false, the value pi's own cancel returns", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(false);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled confirm handle never answers", () => {
    const answer = vi.fn(() => false);
    const { ctx } = raceCtx({ answer, settled: true }, "confirm");
    extensionSelectAdapter.act({}, { type: "confirm", yes: true }, ctx);
    expect(answer).not.toHaveBeenCalled();
  });

  it("an unknown row key answers nothing", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "choose", key: "9:gone" }, ctx)).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled handle falls back to the keystroke path", () => {
    const answer = vi.fn(() => false);
    const { ctx, sendKey } = raceCtx({ answer, settled: true });
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledWith("esc");
  });
});

describe("extensionInputAdapter with a race handle", () => {
  function inputCtx(race: RaceHandle | undefined) {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind: "input", source: "pi", title: "Name", placeholder: "your name", race };
    const ctx = { host: "pi", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    // A component the fallback *could* type into, so a stray keystroke path shows up.
    const handleInput = vi.fn();
    return { ctx, sendKey, handleInput, component: { getValue: () => "", handleInput } };
  }

  it("submit answers the extension call with the text, without typing", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "submit", text: "hello" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("hello");
    expect(handleInput).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an empty submit answers with the empty string", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with undefined, without keys", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
    expect(handleInput).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled handle types into the field and presses Enter as before", () => {
    const answer = vi.fn(() => false);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: true });
    expect(extensionInputAdapter.act(component, { type: "submit", text: "hi" }, ctx)).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(handleInput).toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledWith("enter");
  });
});

describe("FocusTracker takes the pending race into the entry", () => {
  function wired(options?: { confirmViaSelector?: boolean }) {
    const tracker = new FocusTracker();
    const fake = fakeHost(options);
    // The entry wrapper first, then the race wrapper on the outside - exactly
    // the order `attachEntryHooks` installs on the tool UI context.
    hookEntryMethods(fake.target, UI_CONTEXT_SPECS, {
      push: (info, nested) => tracker.pushEntry(info, nested),
      pop: (token) => tracker.popEntry(token),
      bind: (component, info) => tracker.bindEntry(component, info),
    }, "pi");
    for (const method of ["select", "confirm", "input"] as const) {
      expect(installRace(fake.target, method)).toBe(true);
    }
    return { tracker, fake };
  }

  it("a top-level select entry carries the handle the host method never saw", () => {
    const { tracker, fake } = wired();
    callSelect(fake.target)("Pick", ["alpha", "beta"], {});
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("select");
    expect(info?.options).toEqual(["alpha", "beta"]);
    expect(info?.race).toBeDefined();
    // pushEntry took the handle before the host method ran, so the host's own
    // takePendingRace finds nothing, and a later one does too.
    expect(fake.seen.handles[0]).toBeUndefined();
    expect(takePendingRace()).toBeUndefined();
    // The outermost wrapper is the race: entry hooks must not re-wrap it.
    expect(isPluginWrapper(fake.target.select)).toBe(true);
    expect(info?.race?.answer("beta")).toBe(true);
  });

  it("pi's nested selector merges into the confirm entry that holds the handle", () => {
    const { tracker, fake } = wired({ confirmViaSelector: true });
    callConfirm(fake.target)("Sure?", "Delete it", {});
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("confirm");
    // The inner selector enriched the outer entry instead of becoming its own.
    expect(info?.options).toEqual(["Yes", "No"]);
    // The handle on the entry is the outer confirm's: the inner select call has
    // one of its own, but a nested push never takes it, so it is dropped.
    expect(info?.race).toBeDefined();
    expect(info?.race).not.toBe(fake.seen.handles[1]);
    expect(info?.race?.answer(true)).toBe(true);
    expect(isPluginWrapper(fake.target.confirm)).toBe(true);
    expect(takePendingRace()).toBeUndefined();
  });
});

describe("extensionEditorAdapter with a race handle", () => {
  function editorCtx(race: RaceHandle | undefined) {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind: "editor", source: "omp", title: "Compose", prefill: "draft", race };
    const ctx = { host: "omp", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    // A real editor shape: the fallback path *could* setText + Enter.
    const setText = vi.fn();
    return { ctx, sendKey, setText, component: { getText: () => "draft", setText, handleInput: vi.fn() } };
  }

  it("submit answers the extension call with the text, without keys", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, setText, component } = editorCtx({ answer, settled: false });
    expect(extensionEditorAdapter.act(component, { type: "submit", text: "a\nb" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("a\nb");
    expect(setText).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an empty submit answers with the empty string", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, component } = editorCtx({ answer, settled: false });
    expect(extensionEditorAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with undefined, without keys", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, setText, component } = editorCtx({ answer, settled: false });
    expect(extensionEditorAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
    expect(setText).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled handle writes the field and presses Enter as before", () => {
    const answer = vi.fn(() => false);
    const { ctx, sendKey, setText, component } = editorCtx({ answer, settled: true });
    expect(extensionEditorAdapter.act(component, { type: "submit", text: "hi" }, ctx)).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(setText).toHaveBeenCalledWith("hi");
    expect(sendKey).toHaveBeenCalledWith("enter");
  });
});

describe("approvalAdapter with a race handle", () => {
  function approvalCtx(race: RaceHandle | undefined, session?: string) {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = {
      kind: "approval",
      source: "omp",
      title: "Tool approval",
      approval: { full: "Run `git push`?", compact: "git push?", session },
      race,
    };
    const ctx = { host: "omp", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    // A component with nothing readable: only the race path can claim it.
    return { ctx, sendKey, component: {} };
  }

  const live = () => {
    const answer = vi.fn(() => true);
    return { handle: { answer, settled: false } as RaceHandle, answer };
  };

  it("detect claims an unreadable dialog on the handle alone", () => {
    const { ctx, component } = approvalCtx(live().handle);
    expect(approvalAdapter.detect(component, ctx)).toBe(true);
  });

  it("read offers the fixed once/deny answers, without the screen", () => {
    const { ctx, component } = approvalCtx(live().handle);
    const model = approvalAdapter.read(component, ctx);
    expect(model.kind).toBe("approval");
    if (model.kind !== "approval") return;
    expect(model.options).toEqual([
      { key: "once", label: "Allow once" },
      { key: "deny", label: "Deny" },
    ]);
    expect(model.title).toBe("Tool approval");
    expect(model.detail).toContain("git push?");
  });

  it("read adds the session option only when the prompt carries one", () => {
    const { ctx, component } = approvalCtx(live().handle, "Allow `git push` all session");
    const model = approvalAdapter.read(component, ctx);
    if (model.kind !== "approval") throw new Error("expected an approval model");
    expect(model.options.map((option) => option.key)).toEqual(["once", "session", "deny"]);
    expect(model.options[1]?.label).toBe("Allow `git push` all session");
  });

  it("approve answers the extension call with the key, without keys", () => {
    for (const key of ["once", "session", "deny"] as const) {
      const { handle, answer } = live();
      const { ctx, sendKey, component } = approvalCtx(handle);
      expect(approvalAdapter.act(component, { type: "approve", key }, ctx)).toBe(true);
      expect(answer).toHaveBeenCalledWith(key);
      expect(sendKey).not.toHaveBeenCalled();
    }
  });

  it("cancel answers with deny, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey, component } = approvalCtx(handle);
    expect(approvalAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("deny");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an unknown key answers nothing", () => {
    const { handle, answer } = live();
    const { ctx, component } = approvalCtx(handle);
    expect(approvalAdapter.act(component, { type: "approve", key: "always" }, ctx)).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  });

  it("without a handle it neither claims the dialog nor sends keys", () => {
    const { ctx, sendKey, component } = approvalCtx(undefined);
    // The legend is no longer read off the frame, so nothing says which keys this
    // dialog answers to: the snapshot adapter has to take it instead.
    expect(approvalAdapter.detect(component, ctx)).toBe(false);
    expect(approvalAdapter.act(component, { type: "approve", key: "once" }, ctx)).toBe(false);
    expect(approvalAdapter.act(component, { type: "cancel" }, ctx)).toBe(false);
    expect(sendKey).not.toHaveBeenCalled();
  });
});

describe("FocusTracker host gating of the raced methods", () => {
  function attachTracker(hostName: "pi" | "omp") {
    const fake = fakeHost();
    const tracker = new FocusTracker();
    const attached = tracker as unknown as { attach(state: unknown): void };
    attached.attach({
      host: hostName,
      ui: { setFocus: () => undefined },
      mode: {},
      session: { extensionRunner: { getUIContext: () => fake.target } },
    });
    return { fake, tracker };
  }

  it("pi gets no editor race: its editor takes no options, so nothing could abort it", () => {
    const { fake } = attachTracker("pi");
    expect(isPluginWrapper(fake.target.select)).toBe(true);
    // Not raced: the host editor sees no abort signal and no race handle.
    (fake.target.editor as (...args: unknown[]) => unknown)("Compose", "draft", {});
    expect(fake.seen.signals.at(-1)).toBeNull();
    expect(fake.seen.handles.at(-1)).toBeUndefined();
    // pi has no `approve` to race: a target without the method installs nothing.
    expect(installRace({ notify: () => undefined }, "approve")).toBe(false);
    // pi has no `askDialog` on its tool context either.
  });

  it("omp races editor and approve as well", () => {
    const { fake, tracker } = attachTracker("omp");
    expect(pluginWrapperDepth(fake.target, "editor")).toBe(1);
    expect(pluginWrapperDepth(fake.target, "approve")).toBe(1);
    expect(pluginWrapperDepth(fake.target, "askDialog")).toBe(1);
    callEditor(fake.target)("Compose", "draft", {});
    // The entry above took the handle, exactly like select/confirm/input.
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("editor");
    expect(info?.race?.answer("typed")).toBe(true);
  });
});
