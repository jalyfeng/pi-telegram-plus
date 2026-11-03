/**
 * A read-only view is recognised by structure, never by class name (OMP ships minified classes). A focused
 * component with no key binding anywhere near it is a read-only panel; one that holds an input is not, and
 * the editor keeps its own classification.
 */
import { describe, expect, it } from "vitest";
import { pickAdapter } from "../tui/adapters/index.ts";
import { FocusTracker, type FocusKind } from "../tui/focus.ts";
import type { AdapterContext } from "../tui/model.ts";

/** A minified read-only view: render only, no key binding, a describe tree of text. */
class Qk {
  render(): string[] {
    return ["Debug report"];
  }
  describe() {
    return { k: "text", p: { t: "Debug report" } };
  }
}

/** A minified wrapper around a live input: a render with an input one level down. */
class Qm {
  input = { render: () => [""], handleInput: () => undefined };
  render(): string[] {
    return [""];
  }
}

function fakeHost(host: "pi" | "omp") {
  const editor = { render: () => "", handleInput: () => undefined };
  const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
    focused: undefined,
    setFocus(component) {
      ui.focused = component;
    },
  };
  const tracker = new FocusTracker();
  const attached = tracker as unknown as { attach(state: unknown): void };
  attached.attach({ host, ui, editor, mode: {} });
  const kinds: FocusKind[] = [];
  tracker.onChange((info) => kinds.push(info.kind));
  return { ui, kinds, editor };
}

const ctxFor = (host: "pi" | "omp"): AdapterContext => ({ host, sendKey: () => true, requestRender: () => {} });

describe("a focused component with no key binding is a read-only view", () => {
  it("classifies a minified read-only view as progress, not inert", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(new Qk());
    expect(kinds.at(-1)).toBe("progress");
  });

  it("gives that view to the panel adapter, not to unsupported", () => {
    expect(pickAdapter(new Qk(), ctxFor("omp"))?.id).toBe("info-panel");
  });

  it("does not take a wrapper around a live input as a read-only view", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(new Qm());
    expect(kinds.at(-1)).not.toBe("progress");
    expect(pickAdapter(new Qm(), ctxFor("omp"))?.id).not.toBe("info-panel");
  });

  it("keeps the editor an editor when it has focus", () => {
    const { ui, kinds, editor } = fakeHost("omp");
    ui.setFocus(new Qk());
    ui.setFocus(editor);
    expect(kinds.at(-1)).toBe("editor");
  });
});
