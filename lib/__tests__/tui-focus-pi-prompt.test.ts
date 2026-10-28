/**
 * pi's login sheet (`LoginDialogComponent`) carries a `signal`, like a loader does, and
 * mounts its key prompt after the sign-in step has already been focused. Before the
 * signal rule looked for a field, the sheet was filed under "progress" for good, so the
 * broker never drew the prompt (§4.1.3: progress means no list or input field at all).
 */
import { describe, expect, it } from "vitest";
import { FocusTracker, type FocusKind } from "../tui/focus.ts";

/** Pi's login sheet: a `signal`, a title and a content area that gains an input later. */
function loginSheet() {
  const contentContainer: { children: unknown[] } = { children: [{ render: () => "", text: "Open the sign-in link" }] };
  const sheet: Record<string, unknown> = {
    signal: new AbortController().signal,
    render: () => "",
    handleInput: () => undefined,
    contentContainer,
  };
  const input = {
    render: () => "",
    handleInput: () => undefined,
    getValue: () => "",
    setValue: () => undefined,
  };
  return { sheet, contentContainer, input };
}

function fakeHost() {
  const editor = { render: () => "", handleInput: () => undefined };
  const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
    focused: undefined,
    setFocus(component) { ui.focused = component; },
  };
  const tracker = new FocusTracker();
  const attached = tracker as unknown as { attach(state: unknown): void; verify(): void };
  attached.attach({ host: "pi", ui, editor, mode: {} });
  const kinds: FocusKind[] = [];
  tracker.onChange((info) => kinds.push(info.kind));
  return { tracker, ui, kinds, tick: () => attached.verify() };
}

describe("a pi login sheet that carries a signal", () => {
  it("is a dialog once it holds an input field", () => {
    const { ui, kinds } = fakeHost();
    const { sheet, contentContainer, input } = loginSheet();
    contentContainer.children.push(input);
    ui.setFocus(sheet);
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("stays progress while it shows only its sign-in text", () => {
    const { ui, kinds } = fakeHost();
    const { sheet } = loginSheet();
    ui.setFocus(sheet);
    expect(kinds.at(-1)).toBe("progress");
  });

  it("is re-classified on the next tick once its key prompt is mounted", () => {
    const { ui, kinds, tick } = fakeHost();
    const { sheet, contentContainer, input } = loginSheet();
    ui.setFocus(sheet);
    expect(kinds.at(-1)).toBe("progress");

    contentContainer.children.push(input);
    tick();
    expect(kinds.at(-1)).toBe("dialog");
  });
});
