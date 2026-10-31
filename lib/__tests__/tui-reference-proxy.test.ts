/**
 * pi's `mode.ui` is a reference Proxy over an empty target: `get` returns a fresh
 * forwarding closure for each function, `set` forwards to the real TUI, and
 * `getPrototypeOf` returns the real TUI's prototype. It has no
 * `getOwnPropertyDescriptor` trap, so the focus hooks must go on the prototype
 * that owns each method; an install on the proxy never takes effect.
 */
import { describe, expect, it } from "vitest";
import { FocusTracker, type FocusInfo } from "../tui/focus.ts";
import { hookOwnedMethod } from "../tui/host.ts";
import { methodOwner, pluginWrapperDepth } from "../tui/hooks.ts";
import { runInCommand } from "../tui/command-context.ts";
import type { CommandScope } from "../tui/origin.ts";

/** Stand-in for pi-tui's `TUI` class: the focus methods live on its prototype. */
class FakeTui {
  focused: unknown = undefined;
  overlays = 0;
  setFocus(component: unknown): void { this.focused = component; }
  setFocusInternal(component: unknown): void { this.focused = component; }
  showOverlay(): void { this.overlays += 1; }
  hideOverlay(): void { this.overlays -= 1; }
}

/** Subclass like pi's `TuiMainScreen`, which inherits the methods from `TUI`. */
class FakeMainScreen extends FakeTui {}

/** Build pi's reference proxy around `tui`, with the same traps pi uses. */
function referenceProxy(tui: object): object {
  return new Proxy({} as object, {
    get(_target, property) {
      const value = Reflect.get(tui, property, tui);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Reflect.apply(value as (...a: unknown[]) => unknown, tui, args);
    },
    set(_target, property, value) {
      return Reflect.set(tui, property, value, tui);
    },
    has(_target, property) {
      return Reflect.has(tui, property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(tui);
    },
  });
}

/** A pi-shaped host: the reference proxy as `ui`, the real screen behind it. */
function piHost() {
  const screen = new FakeMainScreen();
  const ui = referenceProxy(screen) as FakeTui;
  const editor = { render: () => "", handleInput: () => undefined };
  const tracker = new FocusTracker();
  const internal = tracker as unknown as { attach(state: unknown): void; verify(): void };
  const infos: FocusInfo[] = [];
  tracker.onChange((info) => infos.push(info));
  internal.attach({ host: "pi", ui, editor, mode: {} });
  return { screen, ui, tracker, infos, attach: (state: unknown) => internal.attach(state) };
}

function fakeDialog(): Record<string, unknown> {
  return { signal: new AbortController().signal, render: () => "", handleInput: () => undefined };
}

describe("methodOwner", () => {
  it("returns the object itself when it holds the method as an own property", () => {
    const plain = { method() { return 1; } };
    expect(methodOwner(plain, "method")).toBe(plain);
  });

  it("returns the owning prototype for a method inherited from a class", () => {
    const screen = new FakeMainScreen();
    expect(methodOwner(screen, "setFocus")).toBe(FakeTui.prototype);
  });

  it("finds the owner through the reference proxy's getPrototypeOf", () => {
    const screen = new FakeMainScreen();
    const ui = referenceProxy(screen);
    expect(Object.getOwnPropertyDescriptor(ui, "setFocus")).toBeUndefined();
    expect(methodOwner(ui, "setFocus")).toBe(FakeTui.prototype);
  });

  it("returns undefined when no object in the chain has the method", () => {
    expect(methodOwner(new FakeMainScreen(), "noSuchMethod")).toBeUndefined();
  });
});

describe("focus hooks on pi's reference proxy", () => {
  it("fires on ui.setFocus and reports the component as an event", () => {
    const { ui, infos } = piHost();
    const dialog = fakeDialog();
    ui.setFocus(dialog);
    const last = infos.at(-1);
    expect(last?.component).toBe(dialog);
    expect(last?.source).toBe("event");
  });

  it("captures the command scope the host's setFocus call runs in", () => {
    const { ui, infos } = piHost();
    const scope = { id: "scope-under-test" } as unknown as CommandScope;
    runInCommand(scope, () => ui.setFocus(fakeDialog()));
    expect(infos.at(-1)?.commandScope).toBe(scope);
  });

  it("puts a single wrapper on the owning prototype after 1000 attaches", () => {
    const { attach, ui } = piHost();
    const state = { host: "pi", ui, editor: { render: () => "", handleInput: () => undefined }, mode: {} };
    for (let i = 0; i < 1000; i += 1) attach(state);
    expect(pluginWrapperDepth(FakeTui.prototype, "setFocus")).toBe(1);
    expect(pluginWrapperDepth(FakeTui.prototype, "setFocusInternal")).toBe(1);
    expect(pluginWrapperDepth(FakeTui.prototype, "showOverlay")).toBe(1);
    expect(pluginWrapperDepth(FakeTui.prototype, "hideOverlay")).toBe(1);
  });

  it("keeps one wrapper per method when a new tracker takes over (runtime rebuild)", () => {
    const screen = new FakeMainScreen();
    const ui = referenceProxy(screen) as FakeTui;
    const editor = { render: () => "", handleInput: () => undefined };
    for (let i = 0; i < 50; i += 1) {
      const tracker = new FocusTracker();
      (tracker as unknown as { attach(state: unknown): void }).attach({ host: "pi", ui, editor, mode: {} });
    }
    expect(pluginWrapperDepth(FakeTui.prototype, "setFocus")).toBe(1);
  });

  it("passes the real screen as self to the hook body", () => {
    const screen = new FakeMainScreen();
    const ui = referenceProxy(screen) as FakeTui;
    let seen: unknown;
    hookOwnedMethod(ui, "setFocus", "test-self", (_args, self) => { seen = self; });
    ui.setFocus(fakeDialog());
    expect(seen).toBe(screen);
  });

  it("refuses an install on a target with no owner for the method", () => {
    expect(hookOwnedMethod(referenceProxy(new FakeMainScreen()), "noSuchMethod", "test-missing", () => undefined)).toBe(false);
  });
});

describe("focus hooks on an OMP-shaped plain instance", () => {
  it("still fires on setFocus when the method is inherited from the class", () => {
    const screen = new FakeMainScreen();
    const editor = { render: () => "", handleInput: () => undefined };
    const tracker = new FocusTracker();
    const infos: FocusInfo[] = [];
    tracker.onChange((info) => infos.push(info));
    (tracker as unknown as { attach(state: unknown): void }).attach({ host: "omp", ui: screen, editor, mode: {} });
    const dialog = fakeDialog();
    screen.setFocus(dialog);
    expect(infos.at(-1)?.component).toBe(dialog);
    expect(pluginWrapperDepth(FakeTui.prototype, "setFocus")).toBe(1);
  });
});
