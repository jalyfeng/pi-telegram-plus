/**
 * OMP dialogs that describe themselves through TSP must classify as dialogs
 * (§4.11.3). OMP's model picker and settings page carry `signal` /
 * `abortController` exactly like a loader does, so the loader rule in
 * `FocusTracker.classify` used to file them under "progress" - and the broker
 * opens no session for "progress", so `/model` and `/settings` reached Telegram
 * as nothing but a command receipt.
 */
import { describe, expect, it } from "vitest";
import { describesDialog, describesLoginSheet } from "../tui/adapters/tsp.ts";
import { FocusTracker, type FocusKind } from "../tui/focus.ts";

/** OMP's model picker: keys, a render, a cancellation signal, a TSP description. */
function pickerLike(described: unknown) {
  return {
    abortController: new AbortController(),
    render: () => "",
    handleInput: () => undefined,
    describe: () => described,
    handleNativeEvent: () => undefined,
  };
}

const PICKER_TREE = { k: "picker", p: { title: "Model", items: [{ id: "a", label: "alpha" }] } };
const PREFS_TREE = { k: "prefs", p: { title: "Settings", sections: [{ id: "s", title: "General" }] } };
const OTHER_TREE = { k: "text", p: { t: "working" }, c: [{ k: "text", p: { t: "..." } }] };

/** OMP's login dialog: a `signal` like a loader's, a text field via TSP. */
function loginLike(described: unknown, opts: { handleNativeEvent?: boolean } = {}) {
  const component: Record<string, unknown> = {
    signal: new AbortController().signal,
    render: () => "",
    handleInput: () => undefined,
    describe: () => described,
  };
  if (opts.handleNativeEvent !== false) component.handleNativeEvent = () => undefined;
  return component;
}

const INPUT_TREE = { k: "box", p: {}, c: [{ k: "label", p: { t: "Paste your API key" } }, { k: "input", p: { placeholder: "sk-..." } }] };

/** A host UI the test drives directly, on the named host. */
function fakeHost(host: "pi" | "omp") {
  const editor = { render: () => "", handleInput: () => undefined };
  const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
    focused: undefined,
    setFocus(component) { ui.focused = component; },
  };
  const tracker = new FocusTracker();
  // `attach` is private; drive it directly like the gateway tests do.
  const attached = tracker as unknown as { attach(state: unknown): void };
  attached.attach({ host, ui, editor, mode: {} });
  const kinds: FocusKind[] = [];
  tracker.onChange((info) => kinds.push(info.kind));
  return { tracker, ui, kinds };
}

describe("an OMP component that describes a picker or prefs page is a dialog", () => {
  it("classifies the picker that carries an abortController as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(PICKER_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("classifies the settings page that carries an abortController as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(PREFS_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("keeps a component whose description holds neither kind on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(OTHER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("on the pi host an abortController still means progress, described picker or not", () => {
    const { ui, kinds } = fakeHost("pi");
    ui.setFocus(pickerLike(PICKER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });
});

describe("an OMP component that describes a text field is a dialog", () => {
  it("classifies the login dialog that carries a signal as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(INPUT_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("keeps a signal-carrying component with no input node on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(OTHER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("keeps an input description without handleNativeEvent on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(INPUT_TREE, { handleNativeEvent: false }));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("on the pi host a described input still means progress", () => {
    const { ui, kinds } = fakeHost("pi");
    ui.setFocus(loginLike(INPUT_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });
});

describe("describesDialog", () => {
  it("finds the kind in a nested component's own description", () => {
    const inner = pickerLike(PREFS_TREE);
    expect(describesDialog({ describe: () => ({ k: "box", p: {}, c: [inner] }), handleNativeEvent: () => undefined })).toBe(true);
  });

  it("accepts a described text field whose root routes events", () => {
    expect(describesDialog(loginLike(INPUT_TREE))).toBe(true);
  });

  it("is false for a describe that throws or a component that has none", () => {
    expect(describesDialog({ describe: () => { throw new Error("no tree"); }, handleNativeEvent: () => undefined })).toBe(false);
    expect(describesDialog({ render: () => "", handleInput: () => undefined })).toBe(false);
  });
});

/** OMP's login sheet as a class: a `signal` getter like the real dialog, keys and a TSP description. */
class OmpLoginSheetLike {
  get signal() { return new AbortController().signal; }
  render() { return ""; }
  handleInput() { return undefined; }
  handleNativeEvent() { return undefined; }
  constructor(private readonly tree: unknown) {}
  describe() { return this.tree; }
}

/** A loader-named class with a `signal` getter and no login roles in its description. */
class SpinnerLoader {
  get signal() { return new AbortController().signal; }
  render() { return ""; }
  handleInput() { return undefined; }
  describe() { return OTHER_TREE; }
}

const LOGIN_LINK_TREE = {
  k: "col",
  p: { role: "omp.overlay.login" },
  c: [
    { k: "text", p: { role: "omp.login.lead", text: "Sign in to DeepSeek in your browser." } },
    {
      k: "row",
      p: { role: "omp.login.link" },
      c: [{ k: "text", p: { role: "omp.login.url", text: [{ t: "https://example.test/device" }] } }],
    },
  ],
};

const LOGIN_INPUT_TREE = {
  k: "col",
  p: { role: "omp.overlay.login" },
  c: [
    { k: "text", p: { role: "omp.login.lead", text: "Sign in to DeepSeek in your browser." } },
    { k: "text", p: { role: "omp.login.url", text: [{ t: "https://example.test/device" }] } },
    { k: "col", p: { role: "omp.login.prompt" }, c: [{ k: "label", p: { t: "Paste your API key" } }, { k: "input", p: { placeholder: "paste code" } }] },
  ],
};

describe("an OMP login sheet is a dialog, whether it waits for an answer or for the browser", () => {
  it("classifies a login sheet with an input as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(new OmpLoginSheetLike(LOGIN_INPUT_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("classifies a link-only login sheet (no input node) as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(new OmpLoginSheetLike(LOGIN_LINK_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("keeps a loader-named signal component with no login roles on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(new SpinnerLoader());
    expect(kinds.at(-1)).toBe("progress");
  });

  it("on the pi host a login-shaped description still means progress", () => {
    const { ui, kinds } = fakeHost("pi");
    ui.setFocus(new OmpLoginSheetLike(LOGIN_LINK_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });
});

describe("describesLoginSheet", () => {
  it("finds a login role in a nested component's own description", () => {
    const inner = new OmpLoginSheetLike(LOGIN_LINK_TREE);
    expect(describesLoginSheet({ describe: () => ({ k: "box", p: {}, c: [inner] }) })).toBe(true);
  });

  it("is false for a description with no login role", () => {
    expect(describesLoginSheet(new OmpLoginSheetLike(OTHER_TREE))).toBe(false);
  });

  it("is false for a describe that throws or a component that has none", () => {
    expect(describesLoginSheet({ describe: () => { throw new Error("no tree"); } })).toBe(false);
    expect(describesLoginSheet({ render: () => "", handleInput: () => undefined })).toBe(false);
  });
});
