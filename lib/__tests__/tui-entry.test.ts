/**
 * Entry-hook association tests (§4.1.2).
 *
 * An entry call has to leave its meaning attached to the component the host just
 * built. The pending entry is popped the moment the call returns - pi's `show*`
 * methods return a promise that settles only when the user answers - so a dialog
 * whose focus the tracker notices on a later tick would otherwise reach the
 * adapters with no entry at all and report as an unsupported dialog.
 *
 * The dialog here is pi's real component; only the mode that builds it is faked.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as host from "@earendil-works/pi-coding-agent";
import { pickAdapter } from "../tui/adapters/index.ts";
import { extensionInputAdapter } from "../tui/adapters/extension.ts";
import { entryFromCall, hookEntryMethods, OMP_ENTRY_SPECS, PI_ENTRY_SPECS } from "../tui/entry.ts";
import { FocusTracker, type FocusKind } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

beforeAll(() => {
  host.initTheme("dark");
});

/** The sink `FocusTracker.attachEntryHooks` installs, rebuilt to drive one seam. */
function trackerSink(tracker: FocusTracker) {
  return {
    push: (info: EntryInfo, nested: boolean) => tracker.pushEntry(info, nested),
    pop: (token: object | undefined) => tracker.popEntry(token),
    bind: (component: object, info: EntryInfo) => tracker.bindEntry(component, info),
  };
}

/** A host mode that builds its input the way pi 1.4.0 does: push it onto the
 *  dialog stack with its blocked status, resolve when the user answers. */
class FakeMode {
  readonly pushed: Array<{ component: unknown; blocked?: unknown }> = [];

  showExtensionInput(title: string, placeholder?: string): Promise<string | undefined> {
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    const component = new host.ExtensionInputComponent(
      title,
      placeholder ?? "",
      (value: string) => resolve(value),
      () => resolve(undefined),
    );
    this.pushExtensionDialog(component, { kind: "question", message: title });
    return promise;
  }

  pushExtensionDialog(component: unknown, blocked?: unknown): void {
    this.pushed.push({ component, blocked });
  }
}

function context(entry?: EntryInfo): AdapterContext {
  return { host: "pi", entry, sendKey: () => true, requestRender: () => {} };
}

describe("entry hooks record the dialog on the component (§4.1.2)", () => {
  it("binds the pending entry through pi's pushExtensionDialog", () => {
    const tracker = new FocusTracker();
    const mode = new FakeMode();
    hookEntryMethods(
      mode as unknown as Record<string, unknown>,
      PI_ENTRY_SPECS,
      trackerSink(tracker),
      "pi");
    tracker.hookPiDialogStack(mode as unknown as Record<string, unknown>);

    // The promise stays pending: this is exactly the window a mirrored dialog lives in.
    void mode.showExtensionInput("Bot name", "unique label");
    const push = mode.pushed[0];
    const component = push?.component as Record<string, unknown>;

    expect(component).toBeInstanceOf(host.ExtensionInputComponent);
    // pi hands the blocked status to the stack; the hook logs it as reported.
    expect(push?.blocked).toEqual({ kind: "question", message: "Bot name" });
    expect(tracker.entryFor(component)).toMatchObject({ kind: "input", title: "Bot name", method: "showExtensionInput" });
    expect(pickAdapter(component, context(tracker.entryFor(component)))?.id).toBe("ext-input");
  });

  it("does not let a custom dialog's async push steal an open dialog's entry", () => {
    const tracker = new FocusTracker();
    const mode = new FakeMode();
    hookEntryMethods(
      mode as unknown as Record<string, unknown>,
      PI_ENTRY_SPECS,
      trackerSink(tracker),
      "pi");
    tracker.hookPiDialogStack(mode as unknown as Record<string, unknown>);

    // An input dialog is open and has claimed its entry.
    void mode.showExtensionInput("Bot name");
    const inputComponent = mode.pushed[0]?.component as Record<string, unknown>;
    expect(tracker.entryFor(inputComponent)).toMatchObject({ kind: "input" });

    // A custom dialog built while the input stays open: its factory wrapper
    // already bound the entry, then pi pushes it outside any entry call.
    const custom = { render: () => "", handleInput: () => {} };
    tracker.bindEntry(custom, { kind: "custom", title: "Picker", source: "pi", method: "custom" } as EntryInfo);
    mode.pushExtensionDialog(custom);

    expect(tracker.entryFor(custom)).toMatchObject({ kind: "custom", title: "Picker" });
  });
});

describe("an entry lives as long as the host's dialog (§4.1.2)", () => {
  it("stays readable after the call returns and is retired when the dialog resolves", async () => {
    const tracker = new FocusTracker();
    let resolve!: (value: string) => void;
    const mode: Record<string, unknown> = {
      // OMP's shape: the call returns at once, focus lands on a later tick.
      showExtensionInput: () => new Promise<string>((done) => { resolve = done; }),
    };
    hookEntryMethods(
      mode,
      PI_ENTRY_SPECS.filter((spec) => spec.method === "showExtensionInput"),
      trackerSink(tracker),
      "pi");

    const dialog = mode.showExtensionInput as () => Promise<string>;
    const resolving = dialog();
    const focusedLater = { render: () => "", handleInput: () => {} };

    expect(tracker.entryFor(focusedLater)).toMatchObject({ kind: "input" });

    resolve("done");
    await resolving;

    expect(tracker.entryFor({ render: () => "", handleInput: () => {} })).toBeUndefined();
  });
});

describe("the overlay wrapper holding the dialog answers for it (§4.1.2)", () => {
  const entry = { kind: "select", title: "Pick env", options: ["dev", "prod"], source: "omp", method: "select" } as EntryInfo;

  it("passes the entry down to a wrapper that takes focus next", () => {
    const tracker = new FocusTracker();
    const record = tracker.pushEntry(entry, false);
    const dialog = { render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(dialog)).toMatchObject({ kind: "select" });

    // OMP hands focus to the overlay wrapper a beat after the dialog inside it has
    // claimed the entry, and the wrapper is what receives the keys from then on.
    const wrapper = { children: [dialog], render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(wrapper)).toMatchObject({ kind: "select" });

    // Something else that takes focus meanwhile - a loader beside the dialog - is not
    // the thing being asked about, and must not be able to claim it.
    const loader = { children: [{}, {}], signal: {}, render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(loader)).toBeUndefined();

    tracker.popEntry(record);
  });
});

describe("input adapter reads the entry as the authority", () => {
  const entry = { kind: "input", title: "Retry count (0-10)", source: "pi" } as EntryInfo;

  it("claims an input dialog whose field is not built yet", () => {
    expect(extensionInputAdapter.detect({}, context(entry))).toBe(true);
    expect(extensionInputAdapter.read({}, context(entry))).toMatchObject({ kind: "input", title: "Retry count (0-10)" });
  });

  it("leaves dialogs of another kind to their own adapters", () => {
    const select = { kind: "select", title: "Pick env", options: ["dev"], source: "pi" } as EntryInfo;
    expect(extensionInputAdapter.detect({}, context(select))).toBe(false);
    expect(extensionInputAdapter.detect({}, context(undefined))).toBe(false);
  });
});

describe("OMP read-only panels are recorded as panel entries (§4.6.5 #12)", () => {
  const panelEntry = (method: string, args: unknown[]): EntryInfo | undefined => {
    const spec = OMP_ENTRY_SPECS.find((candidate) => candidate.method === method);
    expect(spec).toBeDefined();
    return entryFromCall(spec!, args, "omp");
  };

  it("no longer records showCommandReport as a panel entry (S19)", () => {
    expect(OMP_ENTRY_SPECS.some((spec) => spec.method === "showCommandReport")).toBe(false);
  });

  it("names the panels that take no title argument", () => {
    expect(panelEntry("showUsageDashboard", [[]])).toMatchObject({ kind: "panel", title: "Usage" });
    expect(panelEntry("showDebugSelector", [])).toMatchObject({ kind: "panel", title: "Debug" });
    expect(panelEntry("showExtensionsDashboard", [])).toMatchObject({ kind: "panel", title: "Extensions" });
    expect(panelEntry("showAgentsDashboard", [])).toMatchObject({ kind: "panel", title: "Agents" });
  });
});

describe("a dashboard that takes focus after its entry returns inherits the panel entry (T3.1)", () => {
  const panelEntry = { kind: "panel", title: "Agents", source: "omp", method: "showAgentsDashboard" } as EntryInfo;

  /** A host UI the test drives directly, starting on the editor. */
  function fakeHost() {
    const editor = { render: () => "", handleInput: () => undefined };
    const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
      focused: undefined,
      setFocus(component) { ui.focused = component; },
    };
    const tracker = new FocusTracker();
    // `attach` is private; drive it directly like the gateway tests do.
    const attached = tracker as unknown as { attach(state: unknown): void };
    attached.attach({ host: "omp", ui, editor, mode: {} });
    const kinds: FocusKind[] = [];
    tracker.onChange((info) => kinds.push(info.kind));
    return { tracker, ui, editor, kinds };
  }

  /** OMP's agents dashboard: keys, a render, a cancellation signal, no shape. */
  const dashboard = () => ({ signal: {}, render: () => "", handleInput: () => undefined });

  it("binds the dashboard that takes focus right after the entry call returns", () => {
    const { tracker, ui, kinds } = fakeHost();
    const record = tracker.pushEntry(panelEntry, false);
    // showAgentsDashboard is synchronous: the entry is retired before focus moves.
    tracker.popEntry(record);
    const panel = dashboard();

    ui.setFocus(panel);

    expect(kinds.at(-1)).toBe("dialog");
    expect(tracker.entryFor(panel)).toMatchObject({ kind: "panel", title: "Agents" });
  });

  it("lets the editor take focus meanwhile without consuming the entry", () => {
    const { tracker, ui, editor, kinds } = fakeHost();
    const record = tracker.pushEntry(panelEntry, false);
    tracker.popEntry(record);
    const panel = dashboard();

    ui.setFocus(editor);
    ui.setFocus(panel);

    expect(kinds.at(-1)).toBe("dialog");
    expect(tracker.entryFor(panel)?.kind).toBe("panel");
  });

  it("leaves a component that takes focus after the handoff window alone", () => {
    const { tracker, ui, kinds } = fakeHost();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const record = tracker.pushEntry(panelEntry, false);
      tracker.popEntry(record);
      now.mockReturnValue(1_000_000 + 1_001);
      const panel = dashboard();

      ui.setFocus(panel);

      expect(kinds.at(-1)).toBe("progress");
      expect(tracker.entryFor(panel)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it("keeps retiring a non-panel entry exactly as before", () => {
    const { tracker, ui, kinds } = fakeHost();
    const record = tracker.pushEntry({ kind: "select", title: "Pick env", options: ["dev"], source: "omp" } as EntryInfo, false);
    tracker.popEntry(record);
    const widget = dashboard();

    ui.setFocus(widget);

    expect(kinds.at(-1)).toBe("progress");
    expect(tracker.entryFor(widget)).toBeUndefined();
  });
});

describe("a report focused inside showCommandReport is never bound as a panel (S19)", () => {
  it("leaves the report unbound so only OutputCapture sends it", () => {
    const editor = { render: () => "", handleInput: () => undefined };
    const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
      focused: undefined,
      setFocus(component) { ui.focused = component; },
    };
    const report = { render: () => "", handleInput: () => undefined };
    // OMP's showCommandReport focuses the report inside its own call.
    const mode = { showCommandReport() { ui.setFocus(report); } };
    const tracker = new FocusTracker();
    // `attach` is private; drive it directly like the gateway tests do.
    const attached = tracker as unknown as { attach(state: unknown): void };
    attached.attach({ host: "omp", ui, editor, mode });

    mode.showCommandReport();

    expect(tracker.entryFor(report)).toBeUndefined();
  });
});
