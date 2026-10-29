/**
 * The TSP picker adapter reads OMP components through `describe` and answers
 * through `handleNativeEvent` (§4.11.3): no screen parsing, no keys. What
 * these tests pin is the keypath computation (reconcile.ts rules: keyed child
 * → its key, unkeyed child → its index, component boundary → restart at "")
 * and the props-to-model mapping, since both are the adapter's whole contract
 * with the host.
 * The prefs tests pin the settings-page mapping and the §4.12 race hand-off.
 */
import { describe, expect, it } from "vitest";
import { pickAdapter } from "../tui/adapters/index.ts";
import { describesLoginSheet, describesTextInput, findPicker, tspInputAdapter, tspLoginAdapter, tspPickerAdapter, tspPrefsAdapter } from "../tui/adapters/tsp.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

type Node = { k: string; p?: unknown; c?: unknown[]; key?: string };

function ctxFor(host: "pi" | "omp" = "omp"): AdapterContext {
  return { host, sendKey: () => true, requestRender: () => undefined };
}

function racedCtx(host: "pi" | "omp" = "omp"): AdapterContext {
  return {
    host,
    entry: { kind: "select", source: host, race: { answer: () => true, settled: false } },
    sendKey: () => true,
    requestRender: () => undefined,
  };
}

/** ctx whose requestRender is counted: 3E pins that act asks the terminal to
 * repaint after a native event lands (the host does not tick its UI itself). */
function countingCtx(host: "pi" | "omp" = "omp") {
  let renders = 0;
  const ctx: AdapterContext = { host, sendKey: () => true, requestRender: () => { renders += 1; } };
  return { ctx, renders: () => renders };
}

function makeComponent(tree: unknown, opts: { throws?: boolean } = {}) {
  const events: unknown[] = [];
  return {
    events,
    describe: () => {
      if (opts.throws) throw new Error("describe blew up");
      return tree;
    },
    handleNativeEvent: (event: unknown) => {
      events.push(event);
    },
  };
}

/** `prefsProps` as a fresh object: the adopting host below writes values into
 * the controls it is given, so no two tests may share one. */
const pageProps = () => structuredClone(prefsProps);

/** Write a `change` event onto the row's own control, the way a host that
 * accepts the value does. */
function applyPrefsChange(props: Record<string, unknown>, item: string, value: unknown): void {
  const sections = Array.isArray(props.sections) ? (props.sections as Record<string, unknown>[]) : [];
  for (const section of sections) {
    for (const row of (Array.isArray(section.rows) ? section.rows : []) as Record<string, unknown>[]) {
      if (row.id !== item || typeof row.control !== "object" || row.control === null) continue;
      const control = row.control as Record<string, unknown>;
      if (control.k === "switch" && typeof value === "boolean") control.on = value;
      else if (control.k === "multi" && Array.isArray(value)) control.values = [...value];
      // A secret control is left untouched: a real host may keep it out of the
      // description, and the adapter must trust it rather than compare it.
      else if ((control.k === "choice" || control.k === "number" || control.k === "text") && control.secret !== true) {
        control.value = value;
      }
    }
  }
}

/**
 * A settings page that answers like OMP: it records the events it is sent and
 * applies the ones it accepts, so the next `describe` shows the new value.
 * `adopt: false` is the host that silently drops a change (a number outside
 * the values its own editor offers) - the adapter has to report that as a dead
 * button instead of a successful press.
 */
function makePrefsHost(props: Record<string, unknown>, opts: { adopt?: boolean } = {}) {
  const adopt = opts.adopt !== false;
  const events: unknown[] = [];
  return {
    props,
    events,
    describe: (): { k: string; p?: unknown } => ({ k: "prefs", p: props }),
    handleNativeEvent: (event: unknown) => {
      events.push(event);
      const change = event as { type?: string; item?: unknown; value?: unknown };
      if (!adopt || change.type !== "change" || typeof change.item !== "string") return;
      applyPrefsChange(props, change.item, change.value);
    },
  };
}

const pickerProps = {
  title: "Models",
  items: [
    { id: "a", label: "alpha" },
    { id: "b", label: [{ t: "be" }, { t: "ta" }], detail: "the {t} one" },
  ],
  selected: "b",
  current: ["a"],
};

const prefsProps = {
  title: "Settings",
  pages: [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "keys", label: "Keys", disabled: "Terminal required" },
  ],
  page: "models",
  sections: [
    {
      id: "s1",
      title: "Inference",
      rows: [
        { id: "think", label: "Thinking", control: { k: "switch", on: true } },
        { id: "off", label: "Off item", disabled: "Locked", control: { k: "switch", on: false } },
      ],
    },
    {
      id: "s2",
      title: "Appearance",
      rows: [
        {
          id: "theme",
          label: "Theme",
          control: { k: "choice", value: "dark", options: [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }] },
        },
        { id: "width", label: "Width", control: { k: "number", value: 80 } },
      ],
    },
  ],
};

const asSelect = (model: DialogModel) => (model.kind === "select" ? model : expect.fail(`not a select: ${model.kind}`));

const asSettings = (model: DialogModel) => (model.kind === "settings" ? model : expect.fail(`not settings: ${model.kind}`));

const asInfo = (model: DialogModel) => (model.kind === "info" ? model : expect.fail(`not info: ${model.kind}`));

describe("tsp picker keypath", () => {
  it("uses the empty keypath when the component's root node is the picker", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const found = findPicker(component);
    expect(found?.keypath).toBe("");
    expect(found?.owner).toBe(component);
  });

  it("uses the child's key when the picker sits in a keyed slot", () => {
    const component = makeComponent({ k: "frame", c: [{ k: "text" }, { key: "picker", k: "picker", p: pickerProps }] });
    expect(findPicker(component)?.keypath).toBe("picker");
  });

  it("uses the child's index when the picker slot has no key", () => {
    const component = makeComponent({ k: "frame", c: [{ k: "text" }, { k: "picker", p: pickerProps }] });
    expect(findPicker(component)?.keypath).toBe("1");
  });

  it("restarts the keypath at the child component's root and hands events to it", () => {
    const inner = makeComponent({ k: "layer", c: [{ key: "picker", k: "picker", p: pickerProps }] });
    const outer = makeComponent({ k: "dock", c: [{ k: "text" }, inner] });
    const found = findPicker(outer);
    expect(found?.owner).toBe(inner);
    expect(found?.keypath).toBe("picker");
    expect(tspPickerAdapter.act(outer, { type: "choose", key: "a" }, ctxFor())).toBe(true);
    expect(inner.events).toEqual([{ type: "activate", key: "picker", item: "a" }]);
    expect(outer.events).toEqual([]);
  });

  it("declines when describe throws", () => {
    const component = makeComponent(null, { throws: true });
    expect(tspPickerAdapter.detect(component, ctxFor())).toBe(false);
  });

  it("declines on the pi host even for a describable picker", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.detect(component, ctxFor("pi"))).toBe(false);
  });
});

describe("tsp picker read", () => {
  it("follows order, dropping ids absent from items and group headers", () => {
    const props = {
      items: [
        { id: "a", label: "alpha" },
        { id: "b", label: "beta" },
        { id: "c", label: "gamma" },
      ],
      order: ["c", "gone", { group: "g", label: "Group" }, "a"],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.items.map((item) => item.key)).toEqual(["c", "a"]);
  });

  it("flattens span text and maps selected/current onto the rows", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const model = asSelect(tspPickerAdapter.read(component, ctxFor()));
    expect(model.title).toBe("Models");
    expect(model.total).toBe(2);
    expect(model.items).toEqual([
      { key: "a", label: "alpha", current: true, focused: false },
      { key: "b", label: "beta", description: "the {t} one", note: "the {t} one", current: false, focused: true },
    ]);
  });

  it("skips disabled rows and defaults the title", () => {
    const props = {
      items: [
        { id: "a", label: "alpha", disabled: "needs a key" },
        { id: "b", label: "beta", disabled: true },
        { id: "c", label: "gamma" },
      ],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Select");
    expect(model.items.map((item) => item.key)).toEqual(["c"]);
    expect(model.total).toBe(1);
  });

  it("follows an open action strip instead of the list", () => {
    const props = {
      title: "Models",
      items: [{ id: "m", label: "mock/mock-model" }],
      strip: {
        label: "Purpose mock/mock-model",
        items: [
          { id: "default", label: "default" },
          { id: "small", label: [{ t: "small " }, { t: "model" }], on: true },
          { id: "plan", label: "plan", on: false },
        ],
        selected: "small",
      },
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Purpose mock/mock-model");
    expect(model.total).toBe(3);
    expect(model.items).toEqual([
      { key: "strip:0", label: "default", current: false, focused: false },
      { key: "strip:1", label: "small model", current: true, focused: true },
      { key: "strip:2", label: "plan", current: false, focused: false },
    ]);
  });

  it("defaults the strip title and treats a chip-less or null strip as none", () => {
    const noLabel = { items: [{ id: "a", label: "alpha" }], strip: { items: [{ id: "x", label: "x" }] } };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: noLabel }), ctxFor()));
    expect(model.title).toBe("Choose a role");
    expect(model.items[0]?.focused).toBe(false);
    // The name-entry strip has no chips: the list stays visible.
    const nameStrip = { ...pickerProps, strip: { label: "Name", items: [] } };
    const list = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: nameStrip }), ctxFor()));
    expect(list.title).toBe("Models");
    expect(list.items.map((item) => item.key)).toEqual(["a", "b"]);
    const nulled = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: { ...pickerProps, strip: null } }), ctxFor()));
    expect(nulled.title).toBe("Models");
  });

  it("shows the picker's empty text as a closable info model when no item is visible", () => {
    const component = makeComponent({ k: "picker", p: { title: "Agents", items: [], empty: "No agents are running." } });
    const model = asInfo(tspPickerAdapter.read(component, ctxFor()));
    expect(model).toEqual({ kind: "info", title: "Agents", text: "No agents are running.", closable: true });
    // A list that is only disabled rows is invisible too.
    const disabled = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a", disabled: true }] } }), ctxFor()));
    expect(disabled.text).toBe("Nothing to show");
  });

  it("prefers empty over message, flattens span text, and keeps a non-empty list a select", () => {
    const both = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], empty: "Empty wins", message: "M" } }), ctxFor()));
    expect(both.text).toBe("Empty wins");
    const viaMessage = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], message: [{ t: "No " }, { t: "agents" }] } }), ctxFor()));
    expect(viaMessage.text).toBe("No agents");
    expect(viaMessage.title).toBe("Select");
    const list = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: pickerProps }), ctxFor()));
    expect(list.kind).toBe("select");
  });
});

describe("tsp picker act", () => {
  it("answers choose with an activate event on the picker's keypath", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: pickerProps }] });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "b" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "activate", key: "picker", item: "b" }]);
  });

  it("refuses an id that is no longer in the list", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "zzz" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("answers cancel with a close action", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });

  it("refuses actions the picker protocol has no shape for", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "submit", text: "x" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("re-reads the tree on every action instead of trusting a stale one", () => {
    let tree: unknown = { k: "picker", p: pickerProps };
    const component = makeComponent(null);
    component.describe = () => tree;
    expect(tspPickerAdapter.act(component, { type: "choose", key: "a" }, ctxFor())).toBe(true);
    tree = { k: "text" };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("reports failure when the host rejects the event", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    component.handleNativeEvent = () => {
      throw new Error("not interactive");
    };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("answers a strip choice with a strip action carrying the chip index", () => {
    const props = {
      ...pickerProps,
      strip: { items: [{ id: "default", label: "default" }, { id: "small", label: "small" }] },
    };
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: props }] });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:1" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "picker", act: "strip", value: "1", mods: [] }]);
  });

  it("refuses a strip index the host no longer offers", () => {
    const props = { ...pickerProps, strip: { items: [{ id: "default", label: "default" }] } };
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:1" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("still activates plain ids while a strip is open", () => {
    const props = { ...pickerProps, strip: { items: [{ id: "default", label: "default" }] } };
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "b" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "activate", key: "", item: "b" }]);
  });

  it("asks the host to redraw after a native event lands, never after a refused one", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const ctx = countingCtx();
    expect(tspPickerAdapter.act(component, { type: "choose", key: "zzz" }, ctx.ctx)).toBe(false);
    expect(ctx.renders()).toBe(0);
    expect(tspPickerAdapter.act(component, { type: "choose", key: "a" }, ctx.ctx)).toBe(true);
    expect(ctx.renders()).toBe(1);
  });

  it("still reports success when the redraw request throws", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const ctx: AdapterContext = { host: "omp", sendKey: () => true, requestRender: () => { throw new Error("no renderer"); } };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });
});

describe("tsp picker tabs, scopes and action bar", () => {
  const treeProps = {
    title: "Tree",
    items: [{ id: "m1", label: "msg one" }],
    tabs: [
      { id: "default", label: "Default" },
      { id: "no-tools", label: [{ t: "No " }, { t: "tools" }] },
      { id: "all", label: "All" },
    ],
    tab: "no-tools",
  };

  it("turns tabs into extra actions with the active one marked", () => {
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: treeProps }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Default", key: "tab:0" },
      { label: "● No tools", key: "tab:1" },
      { label: "All", key: "tab:2" },
    ]);
  });

  it("answers a tab key with a tab action carrying the entry's id", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: treeProps }] });
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:1" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "picker", act: "tab", value: "no-tools", mods: [] }]);
  });

  it("refuses a tab index the host no longer offers", () => {
    const component = makeComponent({ k: "picker", p: treeProps });
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:3" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("marks the active scope, skips disabled entries and answers scope keys", () => {
    const scopes = [
      { id: "cur", label: "Current" },
      { id: "sub", label: "Subtree", disabled: "terminal only" },
      { id: "all", label: "All" },
    ];
    const props = { title: "Tree", items: [{ id: "m1", label: "msg one" }], scopes, scope: "all" };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Current", key: "scope:0" },
      { label: "● All", key: "scope:2" },
    ]);
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "key", name: "scope:2" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "scope", value: "all", mods: [] }]);
    // An entry disabled since the draw: the press is refused.
    const turnedOff = makeComponent({
      k: "picker",
      p: { ...props, scopes: [scopes[0], scopes[1], { id: "all", label: "All", disabled: true }] },
    });
    expect(tspPickerAdapter.act(turnedOff, { type: "key", name: "scope:2" }, ctxFor())).toBe(false);
    expect(turnedOff.events).toEqual([]);
  });

  it("turns action-bar entries into keys, hiding close, cancel and disabled", () => {
    const props = {
      title: "Tree",
      items: [{ id: "m1", label: "msg one" }],
      actions: [
        { id: "switch", label: "Switch" },
        { id: "summarize", label: [{ t: "Summarize & " }, { t: "switch" }] },
        { id: "label", label: "Label", disabled: "no label key" },
        { id: "cancel", label: "Cancel" },
        { id: "close", label: "Close" },
      ],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Switch", key: "act:0" },
      { label: "Summarize & switch", key: "act:1" },
    ]);
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:0" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "switch", mods: [] }]);
    // Disabled entries and the hidden close/cancel ids are refused on act too.
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:2" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:3" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:4" }, ctxFor())).toBe(false);
    expect(component.events).toHaveLength(1);
  });
});

describe("tsp picker search", () => {
  /** A picker component whose own input box records every delivered chunk. */
  function typingComponent(props: unknown) {
    const keys: string[] = [];
    return {
      keys,
      describe: () => ({ k: "picker", p: props }),
      handleNativeEvent: () => undefined,
      handleInput: (data: string) => {
        keys.push(data);
      },
    };
  }

  it("advertises the search box and types the query into the picker input", () => {
    const component = typingComponent({ title: "Tree", items: [{ id: "a", label: "a" }], query: "" });
    const model = asSelect(tspPickerAdapter.read(component, ctxFor()));
    expect(model.search).toEqual({ query: "" });
    expect(tspPickerAdapter.act(component, { type: "search", query: "abc" }, ctxFor())).toBe(true);
    expect(component.keys).toEqual(["\x15", "a", "b", "c"]);
  });

  it("keeps search absent without a query, and refuses typing without an input", () => {
    const model = asSelect(
      tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a" }], query: null } }), ctxFor()),
    );
    expect(model.search).toBeUndefined();
    const mute = makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a" }], query: "" } });
    expect(tspPickerAdapter.act(mute, { type: "search", query: "x" }, ctxFor())).toBe(false);
  });
});

describe("tsp picker empty state with controls", () => {
  it("keeps tabs as buttons over an empty list, empty text in the title", () => {
    const props = {
      title: "Tree",
      items: [],
      empty: [{ t: "2 entries " }, { t: "hidden by the filter" }],
      tabs: [{ id: "default", label: "Default" }, { id: "all", label: "All" }],
      tab: "default",
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Tree");
    expect(model.notice).toBe("2 entries hidden by the filter");
    expect(model.items).toEqual([]);
    expect(model.total).toBe(0);
    expect(model.extraActions).toEqual([
      { label: "● Default", key: "tab:0" },
      { label: "All", key: "tab:1" },
    ]);
  });

  it("keeps a search-only empty picker a select with its search box", () => {
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], query: "abc" } }), ctxFor()));
    expect(model.search).toEqual({ query: "abc" });
    expect(model.items).toEqual([]);
  });

  it("stays info when an empty list has no tabs, scopes, actions or search", () => {
    const model = asInfo(
      tspPickerAdapter.read(makeComponent({ k: "picker", p: { title: "Agents", items: [], empty: "No agents." } }), ctxFor()),
    );
    expect(model).toEqual({ kind: "info", title: "Agents", text: "No agents.", closable: true });
  });
});

describe("tsp race hand-off (§4.12)", () => {
  it("declines a picker while the extension dialog race is live", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.detect(component, racedCtx())).toBe(false);
  });

  it("declines a prefs page while the race is live", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.detect(component, racedCtx())).toBe(false);
  });

  it("still detects when the entry carries no race", () => {
    const ctx: AdapterContext = {
      ...ctxFor(),
      entry: { kind: "select", source: "omp" },
    };
    expect(tspPrefsAdapter.detect(makeComponent({ k: "prefs", p: prefsProps }), ctx)).toBe(true);
  });
});

describe("tsp prefs read", () => {
  it("maps pages, switches, choices and read-only controls onto the settings model", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "prefs", k: "prefs", p: prefsProps }] });
    expect(tspPrefsAdapter.detect(component, ctxFor())).toBe(true);
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.title).toBe("Settings");
    // The current page and every disabled page/row is left out.
    expect(model.items).toEqual([
      { key: "page:general", label: "📄 General", hasSubmenu: true, shortcut: true },
      { key: "think", label: "Thinking", value: "On", values: ["On", "Off"], group: "Inference" },
      { key: "theme", label: "Theme", value: "Dark", values: ["Dark", "Light"], group: "Appearance" },
      { key: "width", label: "Width", value: "80", hasSubmenu: true, group: "Appearance" },
    ]);
  });

  it("shows only the matches while a search is active", () => {
    const component = makeComponent({ k: "prefs", p: { ...pageProps(), query: "thinking" } });
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.search).toEqual({ query: "thinking" });
    expect(model.items.some((item) => item.key.startsWith("page:"))).toBe(false);
    expect(model.items.map((item) => item.key)).toEqual(["think", "theme", "width"]);
  });

  it("keeps the page entries while the query is empty or absent", () => {
    const empty = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: { ...pageProps(), query: "" } }), ctxFor()));
    expect(empty.items.map((item) => item.key)).toContain("page:general");
    const absent = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: pageProps() }), ctxFor()));
    expect(absent.items.map((item) => item.key)).toContain("page:general");
    expect(absent.search).toEqual({ query: "" });
  });
});

describe("tsp prefs act", () => {
  it("answers a page submenu with a page action on the prefs keypath", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "body", k: "prefs", p: prefsProps }] });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:general" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "body", act: "page", value: "general", mods: [] }]);
  });

  it("refuses a page that is gone or disabled", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:keys" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:nope" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("answers a switch cycle with the requested boolean change", () => {
    const component = makePrefsHost(pageProps());
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "On" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Off" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([
      { type: "change", key: "", item: "think", value: true },
      { type: "change", key: "", item: "think", value: false },
    ]);
  });

  it("flips a switch when no value is given", () => {
    const component = makePrefsHost(pageProps());
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "think", value: false }]);
  });

  it("maps a choice label back onto its option value", () => {
    const component = makePrefsHost(pageProps());
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme", value: "Light" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "theme", value: "light" }]);
  });

  it("cycles to the next option when no value is given", () => {
    const component = makePrefsHost(pageProps());
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "theme", value: "light" }]);
  });

  it("answers cancel with a close action that carries no value", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });

  it("refuses rows the page does not have and values it cannot map", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "gone" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "width" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Maybe" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme", value: "Purple" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "x" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("re-reads the tree on every action instead of trusting a stale one", () => {
    const component = makePrefsHost(pageProps());
    let tree: { k: string; p?: unknown } = { k: "prefs", p: component.props };
    component.describe = () => tree;
    // The host applied the change, so the read-back confirms it.
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Off" }, ctxFor())).toBe(true);
    tree = { k: "text" };
    expect(tspPrefsAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("asks the host to redraw after a page switch lands", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    const ctx = countingCtx();
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:nope" }, ctx.ctx)).toBe(false);
    expect(ctx.renders()).toBe(0);
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:general" }, ctx.ctx)).toBe(true);
    expect(ctx.renders()).toBe(1);
  });
});

/** A page holding one row of each editable control kind, plus a read-only `keys` row. */
function controlProps() {
  return {
    title: "Settings",
    pages: [],
    page: "general",
    sections: [
      {
        id: "s",
        title: "S",
        rows: [
          { id: "temp", label: "Temperature", control: { k: "number", value: 0.5, min: 0, max: 1, step: 0.25 } },
          { id: "level", label: "Level", control: { k: "number", value: 2, min: 0, max: 10, step: 1, labels: { "0": "off", "2": "low" } } },
          { id: "width", label: "Width", control: { k: "number", value: 80 } },
          { id: "name", label: "Name", control: { k: "text", value: "opus", placeholder: "model name" } },
          { id: "token", label: "Token", control: { k: "text", value: "s3cret", secret: true } },
          {
            id: "langs",
            label: "Languages",
            control: { k: "multi", values: ["ts"], options: [{ value: "ts", label: "TypeScript" }, { value: "py", label: "Python" }] },
          },
          { id: "limits", label: "Provider limits", control: { k: "action", label: "Edit…", act: "edit" } },
          { id: "binds", label: "Binds", control: { k: "keys", keys: [["ctrl-a"]] } },
        ],
      },
    ],
  };
}

const asSubmenuInput = (model: DialogModel) => {
  const sub = model.kind === "settings" ? model.submenu?.model : undefined;
  return sub?.kind === "input" ? sub : expect.fail(`not an input submenu: ${sub?.kind ?? "none"}`);
};

describe("tsp prefs number controls", () => {
  it("enumerates a range that fits as cycle values, with labels and unit honoured", () => {
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: controlProps() }), ctxFor()));
    const temp = model.items.find((item) => item.key === "temp");
    expect(temp).toEqual({
      key: "temp",
      label: "Temperature",
      value: "0.5",
      values: ["0", "0.25", "0.5", "0.75", "1"],
      group: "S",
    });
    const level = model.items.find((item) => item.key === "level");
    expect(level?.value).toBe("low");
    expect(level?.values?.[0]).toBe("off");
  });

  it("opens a plugin-side input for a number without a small range", () => {
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: controlProps() }), ctxFor()));
    expect(model.items.find((item) => item.key === "width")).toEqual({
      key: "width",
      label: "Width",
      value: "80",
      hasSubmenu: true,
      group: "S",
    });
  });

  it("cycles a small range to the wanted step or to the next one", () => {
    const component = makePrefsHost(controlProps());
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "temp", value: "0.75" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "level" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([
      { type: "change", key: "", item: "temp", value: 0.75 },
      { type: "change", key: "", item: "level", value: 3 },
    ]);
  });

  it("refuses a step label the range does not have and a number it cannot enumerate", () => {
    const component = makeComponent({ k: "prefs", p: controlProps() });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "temp", value: "9" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "width" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("submits a typed number as a change and keeps the input open on garbage", () => {
    const component = makePrefsHost(controlProps());
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "width" }, ctxFor())).toBe(true);
    expect(asSubmenuInput(tspPrefsAdapter.read(component, ctxFor())).placeholder).toBe("80");
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "abc" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
    // The input stayed up for a retry.
    expect(asSubmenuInput(tspPrefsAdapter.read(component, ctxFor())).title).toBe("Width");
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "42" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "width", value: 42 }]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });
});

describe("tsp prefs text controls", () => {
  it("shows the current value and opens a plugin-side input", () => {
    const component = makeComponent({ k: "prefs", p: controlProps() });
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.items.find((item) => item.key === "name")).toEqual({
      key: "name",
      label: "Name",
      value: "opus",
      hasSubmenu: true,
      group: "S",
    });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([]);
    expect(tspPrefsAdapter.read(component, ctxFor())).toMatchObject({
      submenu: { itemKey: "name", model: { kind: "input", title: "Name", placeholder: "opus", secret: false } },
    });
  });

  it("submits the typed string and closes the input", () => {
    const component = makePrefsHost(controlProps());
    tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor());
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "sonnet" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "name", value: "sonnet" }]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });

  it("masks a secret value and never echoes it into the input", () => {
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: controlProps() }), ctxFor()));
    expect(model.items.find((item) => item.key === "token")?.value).toBe("•••");
    const component = makeComponent({ k: "prefs", p: controlProps() });
    tspPrefsAdapter.act(component, { type: "submenu", key: "token" }, ctxFor());
    const input = asSubmenuInput(tspPrefsAdapter.read(component, ctxFor()));
    expect(input.secret).toBe(true);
    expect(input.placeholder).toBeUndefined();
  });

  it("closes on cancel without sending anything", () => {
    const component = makeComponent({ k: "prefs", p: controlProps() });
    tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor());
    expect(tspPrefsAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });
});

describe("tsp prefs multi controls", () => {
  /** A page whose multi row applies every change locally, like the host does. */
  function liveMulti() {
    const rows = [
      {
        id: "langs",
        label: "Languages",
        control: { k: "multi", values: ["ts"] as unknown[], options: [{ value: "ts", label: "TypeScript" }, { value: "py", label: "Python" }] },
      },
    ];
    const props = { title: "Settings", pages: [], page: "general", sections: [{ id: "s", title: "S", rows }] };
    const events: unknown[] = [];
    return {
      events,
      describe: () => ({ k: "prefs", p: props }),
      handleNativeEvent: (event: unknown) => {
        events.push(event);
        const change = event as { type?: string; item?: string; value?: unknown };
        if (change.type === "change" && change.item === "langs") rows[0]!.control.values = change.value as unknown[];
      },
    };
  }

  it("shows selected labels and a checked multi-select submenu", () => {
    const model = asSettings(tspPrefsAdapter.read(liveMulti(), ctxFor()));
    expect(model.items[0]).toEqual({ key: "langs", label: "Languages", value: "TypeScript", hasSubmenu: true, group: "S" });
    const component = liveMulti();
    tspPrefsAdapter.act(component, { type: "submenu", key: "langs" }, ctxFor());
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toEqual({
      itemKey: "langs",
      model: {
        kind: "select",
        title: "Languages",
        multi: true,
        total: 2,
        items: [
          { key: "ts", label: "TypeScript", checked: true },
          { key: "py", label: "Python", checked: false },
        ],
      },
    });
  });

  it("applies each toggle on its own and keeps the submenu open", () => {
    const component = liveMulti();
    tspPrefsAdapter.act(component, { type: "submenu", key: "langs" }, ctxFor());
    expect(tspPrefsAdapter.act(component, { type: "toggle", key: "ts" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "toggle", key: "py" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([
      { type: "change", key: "", item: "langs", value: [] },
      { type: "change", key: "", item: "langs", value: ["py"] },
    ]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu?.itemKey).toBe("langs");
  });

  it("closes on Submit without a new event and refuses unknown options", () => {
    const component = liveMulti();
    tspPrefsAdapter.act(component, { type: "submenu", key: "langs" }, ctxFor());
    expect(tspPrefsAdapter.act(component, { type: "toggle", key: "rust" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "submit" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });
});

describe("tsp prefs action controls and search", () => {
  it("fires an action control's own event instead of opening a submenu", () => {
    const component = makeComponent({ k: "prefs", p: controlProps() });
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.items.find((item) => item.key === "limits")).toEqual({
      key: "limits",
      label: "Edit…",
      value: "",
      hasSubmenu: true,
      group: "S",
    });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "limits" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "edit", value: "limits", mods: [] }]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });

  it("leaves key bindings read-only", () => {
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: controlProps() }), ctxFor()));
    expect(model.items.find((item) => item.key === "binds")?.value).toBe("(change it in the terminal)");
  });

  it("advertises the search box and types the query into the page's own input", () => {
    const keys: string[] = [];
    const props = { ...controlProps(), query: "the" };
    const component = {
      keys,
      describe: () => ({ k: "prefs", p: props }),
      handleNativeEvent: () => undefined,
      handleInput: (data: string) => {
        keys.push(data);
      },
    };
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.search).toEqual({ query: "the" });
    expect(tspPrefsAdapter.act(component, { type: "search", query: "abc" }, ctxFor())).toBe(true);
    expect(keys).toEqual(["\x15", "a", "b", "c"]);
  });

  it("hides the search box while a submenu is open", () => {
    const component = makeComponent({ k: "prefs", p: { ...controlProps(), query: "the" } });
    tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor());
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.search).toBeUndefined();
    expect(model.submenu?.itemKey).toBe("name");
  });

  it("drops the submenu once its row is gone from the page", () => {
    const props = controlProps();
    const component = makeComponent({ k: "prefs", p: props });
    tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor());
    props.sections = [];
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "x" }, ctxFor())).toBe(false);
  });
});

describe("tsp prefs read-back, search and stale submenu", () => {
  it("keeps the number input up when the host ignores the value", () => {
    const component = makePrefsHost(controlProps(), { adopt: false });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "width" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "42" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([{ type: "change", key: "", item: "width", value: 42 }]);
    // The row still shows 80: the editor stays up so the user can retry.
    const input = asSubmenuInput(tspPrefsAdapter.read(component, ctxFor()));
    expect(input.title).toBe("Width");
    expect(input.placeholder).toBe("80");
  });

  it("reports a cycle the host dropped as a dead button", () => {
    const component = makePrefsHost(pageProps(), { adopt: false });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([{ type: "change", key: "", item: "think", value: false }]);
  });

  it("trusts a secret row the host keeps out of its description", () => {
    const component = makePrefsHost(controlProps());
    tspPrefsAdapter.act(component, { type: "submenu", key: "token" }, ctxFor());
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "new-token" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "token", value: "new-token" }]);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu).toBeUndefined();
  });

  it("refuses a multi toggle the host did not apply, and stays in the submenu", () => {
    const component = makePrefsHost(controlProps(), { adopt: false });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "langs" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "toggle", key: "py" }, ctxFor())).toBe(false);
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu?.itemKey).toBe("langs");
  });

  it("advertises the search box before the terminal has typed anything", () => {
    const component = makePrefsHost(controlProps());
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).search).toEqual({ query: "" });
  });

  it("reopens the rows, not the submenu the previous session left open", () => {
    const component = makePrefsHost(controlProps());
    expect(tspPrefsAdapter.detect(component, ctxFor())).toBe(true);
    tspPrefsAdapter.act(component, { type: "submenu", key: "name" }, ctxFor());
    expect(asSettings(tspPrefsAdapter.read(component, ctxFor())).submenu?.itemKey).toBe("name");
    // The terminal closed the page behind the plugin's back; the next session on
    // the same component must not resume inside the abandoned input.
    expect(tspPrefsAdapter.detect(component, ctxFor())).toBe(true);
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.submenu).toBeUndefined();
    expect(model.search).toEqual({ query: "" });
  });
});

/**
 * OMP's `LoginDialogComponent`: a prompt line, then a nested input component
 * (`TextFormField`); the root routes keystrokes to the field and takes
 * submit/cancel through its own `handleNativeEvent`.
 */
function makeLoginDialog(opts: { mask?: "self" | "inner" | "none"; label?: string; extra?: Node[] } = {}) {
  const keys: string[] = [];
  const events: unknown[] = [];
  const field: Record<string, unknown> = {
    describe: () => ({ k: "input", p: { text: "", placeholder: "sk-..." } }),
    handleNativeEvent: () => undefined,
    handleInput: (data: string) => { keys.push(data); },
  };
  if (opts.mask === "inner") field.input = { mask: true };
  else if (opts.mask !== "none") field.mask = true;
  return {
    keys,
    events,
    describe: () => ({
      k: "col",
      c: [
        { k: "text", p: { text: opts.label ?? "Paste your API key:" } },
        ...(opts.extra ?? []),
        field,
      ],
    }),
    handleNativeEvent: (event: unknown) => { events.push(event); },
    handleInput: (data: string) => { keys.push(data); },
  };
}

describe("tsp input adapter (OMP built-in text prompts)", () => {
  it("detects the login dialog and titles the field after its prompt line", () => {
    const component = makeLoginDialog();
    expect(tspInputAdapter.detect(component, ctxFor())).toBe(true);
    expect(tspInputAdapter.read(component, ctxFor())).toEqual({
      kind: "input",
      title: "Paste your API key",
      placeholder: "sk-...",
      secret: true,
    });
  });

  it("types the answer through the dialog's own handleInput, then submits", () => {
    const component = makeLoginDialog();
    const { ctx, renders } = countingCtx();
    expect(tspInputAdapter.act(component, { type: "submit", text: "sk-test-123" }, ctx)).toBe(true);
    expect(component.keys).toEqual(["\x15", ..."sk-test-123"]);
    expect(component.events).toEqual([{ type: "action", key: "", act: "submit", mods: [] }]);
    expect(renders()).toBe(1);
  });

  it("cancels with the native cancel action", () => {
    const component = makeLoginDialog();
    expect(tspInputAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "cancel", mods: [] }]);
    expect(component.keys).toEqual([]);
  });

  it("declines a tree that also describes a picker", () => {
    const component = makeLoginDialog({ extra: [{ k: "picker", p: pickerProps }] });
    expect(tspInputAdapter.detect(component, ctxFor())).toBe(false);
  });

  it("declines a raced dialog and the pi host", () => {
    expect(tspInputAdapter.detect(makeLoginDialog(), racedCtx())).toBe(false);
    expect(tspInputAdapter.detect(makeLoginDialog(), ctxFor("pi"))).toBe(false);
  });

  it("reads the mask from the wrapped Input and secrets from the title", () => {
    expect(tspInputAdapter.read(makeLoginDialog({ mask: "inner" }), ctxFor())).toMatchObject({ secret: true });
    const keyword = makeLoginDialog({ mask: "none", label: "Enter your token, then press Enter" });
    expect(tspInputAdapter.read(keyword, ctxFor())).toMatchObject({ title: "Enter your token", secret: true });
    const plain = makeLoginDialog({ mask: "none", label: "Bot name:" });
    expect(tspInputAdapter.read(plain, ctxFor())).toMatchObject({ title: "Bot name", secret: false });
  });

  it("falls back to a plain title when the prompt line is gone", () => {
    expect(tspInputAdapter.read(makeLoginDialog({ label: "" }), ctxFor())).toMatchObject({ title: "Input" });
  });
});

/**
 * OMP's login dialog for a device-code provider (`/login` → deepseek): the
 * explanation, the code, the login link and a local shortcut sit above the
 * prompt line; the field comes last.
 */
function makeOmpLoginSheet(opts: { shortcut?: boolean; withBody?: boolean; wrapped?: boolean } = {}) {
  const body: Node[] = opts.withBody === false ? [] : [
    { k: "text", p: { role: "omp.login.lead", text: "Sign in to DeepSeek in your browser." } },
    { k: "row", p: { role: "omp.login.code" }, c: [{ k: "text", p: { text: [{ t: "Code: " }, { t: "ABCD-1234" }] } }] },
    {
      k: "row",
      p: { role: "omp.login.link" },
      c: [
        {
          k: "text",
          p: {
            role: "omp.login.url",
            title: "https://example.test/device",
            spans: [{ t: "https://example.test/device", s: "mono", href: "https://example.test/device" }],
          },
        },
      ],
    },
    ...(opts.shortcut ? [{ k: "text", p: { role: "omp.login.shortcut", text: "Press o to open in browser" } }] : []),
  ];
  // The real field: a component with its own describe() and no handleNativeEvent.
  const field: Record<string, unknown> = {
    describe: () => ({ k: "input", p: { text: "", placeholder: "paste code" } }),
    handleInput: () => undefined,
  };
  const label = { k: "text", p: { role: "omp.login.label", text: "Waiting for approval, then press Enter" } };
  // `wrapped`: the field sits inside a describe-only container (OMP's FormField),
  // which holds the label too.
  const prompt = opts.wrapped
    ? [{ describe: () => ({ k: "col", c: [label, field] }) }]
    : [label, field];
  return {
    describe: () => ({
      k: "col",
      c: [
        {
          k: "overlay",
          p: { role: "omp.overlay.login", head: "Sign in to DeepSeek" },
          c: [
            {
              k: "col",
              c: [
                ...body,
                { k: "col", p: { role: "omp.login.prompt" }, c: prompt },
              ],
            },
          ],
        },
      ],
    }),
    handleNativeEvent: () => undefined,
  };
}

describe("tsp input adapter shows the OMP login body (detail)", () => {
  it("collects lead, code and URL in document order and keeps the title", () => {
    const model = tspInputAdapter.read(makeOmpLoginSheet(), ctxFor());
    expect(model).toEqual({
      kind: "input",
      title: "Waiting for approval",
      placeholder: "paste code",
      detail: "Sign in to DeepSeek in your browser.\nCode: ABCD-1234\nhttps://example.test/device",
      secret: false,
    });
  });

  it("includes the local shortcut line when OMP shows one", () => {
    const model = tspInputAdapter.read(makeOmpLoginSheet({ shortcut: true }), ctxFor());
    expect(model).toMatchObject({ detail: expect.stringContaining("\nPress o to open in browser") });
  });

  it("sets no detail key when the dialog has no login body", () => {
    const model = tspInputAdapter.read(makeOmpLoginSheet({ withBody: false }), ctxFor());
    expect(model).not.toHaveProperty("detail");
  });
});

/**
 * One OMP login sheet whose tree changes with its phase: the link-only phase
 * (overlay root with its heading, lead, code, link and a status line), then
 * the same sheet once the field has appeared. `phase` is flipped in place, the
 * way OMP's own dialog grows a prompt while the component stays the same.
 */
function makeLoginSheetPhases() {
  const events: unknown[] = [];
  const state = { prompt: false, status: "Waiting for the browser to finish sign-in." };
  // The real field: a component with its own describe() and no handleNativeEvent.
  const field: Record<string, unknown> = {
    describe: () => ({ k: "input", p: { text: "", placeholder: "paste code" } }),
    handleInput: () => undefined,
  };
  return {
    events,
    state,
    handleInput: () => undefined,
    describe: () => ({
      k: "col",
      c: [
        {
          k: "overlay",
          p: { role: "omp.overlay.login", head: "Sign in to DeepSeek" },
          c: [
            {
              k: "col",
              c: [
                { k: "text", p: { role: "omp.login.lead", text: "Sign in to DeepSeek in your browser." } },
                { k: "row", p: { role: "omp.login.code" }, c: [{ k: "text", p: { text: [{ t: "Code: " }, { t: "ABCD-1234" }] } }] },
                {
                  k: "row",
                  p: { role: "omp.login.link" },
                  c: [
                    {
                      k: "text",
                      p: {
                        role: "omp.login.url",
                        title: "https://example.test/device",
                        spans: [{ t: "https://example.test/device", s: "mono", href: "https://example.test/device" }],
                      },
                    },
                  ],
                },
                {
                  k: "col",
                  p: { role: "omp.login.status" },
                  c: [{ k: "row", p: { role: "omp.login.waiting" }, c: [{ k: "spinner", p: { style: "orbit", label: state.status, tone: "muted" } }] }],
                },
                ...(state.prompt
                  ? [{ k: "col", p: { role: "omp.login.prompt" }, c: [{ k: "text", p: { role: "omp.login.label", text: "Paste the code, then press Enter" } }, field] }]
                  : []),
              ],
            },
          ],
        },
      ],
    }),
    handleNativeEvent: (event: unknown) => { events.push(event); },
  };
}

describe("tsp login adapter (OMP login sheet, link phase and field phase)", () => {
  const linkOnly = () => makeLoginSheetPhases();

  it("detects the sheet in both phases and not a plain text prompt", () => {
    const sheet = linkOnly();
    expect(tspLoginAdapter.detect(sheet, ctxFor())).toBe(true);
    sheet.state.prompt = true;
    expect(tspLoginAdapter.detect(sheet, ctxFor())).toBe(true);
    expect(tspLoginAdapter.detect(makeLoginDialog(), ctxFor())).toBe(false);
  });

  it("declines the pi host and a raced dialog", () => {
    expect(tspLoginAdapter.detect(linkOnly(), ctxFor("pi"))).toBe(false);
    expect(tspLoginAdapter.detect(linkOnly(), racedCtx())).toBe(false);
  });

  it("reads the link phase as a cancellable progress view in document order", () => {
    const model = tspLoginAdapter.read(linkOnly(), ctxFor());
    expect(model).toMatchObject({ kind: "progress", cancellable: true });
    const text = (model as { text: string }).text.split("\n");
    expect(text).toEqual([
      "Sign in to DeepSeek",
      "Sign in to DeepSeek in your browser.",
      "Code: ABCD-1234",
      "https://example.test/device",
      "Waiting for the browser to finish sign-in.",
    ]);
  });

  it("falls back to a generic heading when the overlay has none", () => {
    const bare = makeComponent({ k: "col", c: [{ k: "text", p: { role: "omp.login.lead", text: "Open the link." } }] });
    expect(tspLoginAdapter.detect(bare, ctxFor())).toBe(true);
    expect(tspLoginAdapter.read(bare, ctxFor())).toEqual({ kind: "progress", text: "Sign in\nOpen the link.", cancellable: true });
  });

  it("hands the field phase to the input adapter", () => {
    const sheet = linkOnly();
    sheet.state.prompt = true;
    expect(tspLoginAdapter.read(sheet, ctxFor())).toEqual(tspInputAdapter.read(sheet, ctxFor()));
    expect(tspLoginAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "input" });
  });

  it("switches from progress to input when the field appears on the same component", () => {
    const sheet = linkOnly();
    expect(tspLoginAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "progress" });
    sheet.state.prompt = true;
    expect(tspLoginAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "input" });
  });

  it("cancels the link phase with the native cancel action and declines other actions", () => {
    const sheet = linkOnly();
    const { ctx, renders } = countingCtx();
    expect(tspLoginAdapter.act(sheet, { type: "submit", text: "x" }, ctx)).toBe(false);
    expect(sheet.events).toEqual([]);
    expect(tspLoginAdapter.act(sheet, { type: "cancel" }, ctx)).toBe(true);
    expect(sheet.events).toEqual([{ type: "action", key: "", act: "cancel", mods: [] }]);
    expect(renders()).toBe(1);
  });

  it("acts on the field phase exactly like the input adapter", () => {
    const sheet = linkOnly();
    sheet.state.prompt = true;
    const { ctx, renders } = countingCtx();
    expect(tspLoginAdapter.act(sheet, { type: "cancel" }, ctx)).toBe(true);
    expect(sheet.events).toEqual([{ type: "action", key: "", act: "cancel", mods: [] }]);
    expect(tspLoginAdapter.act(sheet, { type: "submit", text: "abc" }, ctx)).toBe(true);
    expect(sheet.events.at(-1)).toEqual({ type: "action", key: "", act: "submit", mods: [] });
    expect(renders()).toBe(2);
  });

  it("picks tsp-login for both phases and tsp-input for a plain text prompt", () => {
    const sheet = linkOnly();
    expect(pickAdapter(sheet, ctxFor())?.id).toBe("tsp-login");
    sheet.state.prompt = true;
    expect(pickAdapter(sheet, ctxFor())?.id).toBe("tsp-login");
    expect(pickAdapter(makeLoginDialog(), ctxFor())?.id).toBe("tsp-input");
  });
});

/**
 * H13: the field inside OMP's login prompt is a real component with only a
 * `describe()` (no `handleNativeEvent`). Reading must still descend into it.
 */
describe("tsp login read descends into describe-only form fields (H13)", () => {
  it("finds the field and reads its prompt line, placeholder and URL detail", () => {
    const sheet = makeOmpLoginSheet();
    expect(tspInputAdapter.read(sheet, ctxFor())).toEqual({
      kind: "input",
      title: "Waiting for approval",
      placeholder: "paste code",
      detail: "Sign in to DeepSeek in your browser.\nCode: ABCD-1234\nhttps://example.test/device",
      secret: false,
    });
    expect(tspLoginAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "input", title: "Waiting for approval" });
  });

  it("finds the field through a describe-only container (FormField-like) under the prompt", () => {
    const sheet = makeOmpLoginSheet({ wrapped: true });
    expect(tspInputAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "input", title: "Waiting for approval", placeholder: "paste code" });
    expect(tspLoginAdapter.read(sheet, ctxFor())).toMatchObject({ kind: "input" });
    expect(tspLoginAdapter.detect(sheet, ctxFor())).toBe(true);
  });

  it("reports the input node for both describe-only shapes", () => {
    expect(describesTextInput(makeOmpLoginSheet())).toBe(true);
    expect(describesTextInput(makeOmpLoginSheet({ wrapped: true }))).toBe(true);
    expect(describesLoginSheet(makeOmpLoginSheet())).toBe(true);
  });

  it("types the answer on the root and submits, though the field has no handleNativeEvent", () => {
    const keys: string[] = [];
    const events: unknown[] = [];
    const sheet = {
      ...makeOmpLoginSheet(),
      handleInput: (data: string) => { keys.push(data); },
      handleNativeEvent: (event: unknown) => { events.push(event); },
    };
    const { ctx, renders } = countingCtx();
    expect(tspLoginAdapter.act(sheet, { type: "submit", text: "sk-test" }, ctx)).toBe(true);
    expect(keys).toEqual(["\x15", ..."sk-test"]);
    expect(events).toEqual([{ type: "action", key: "", act: "submit", mods: [] }]);
    expect(renders()).toBe(1);
  });

  it("still reads the older shape where the field also has handleNativeEvent", () => {
    expect(tspInputAdapter.read(makeLoginDialog(), ctxFor())).toMatchObject({ kind: "input", title: "Paste your API key", placeholder: "sk-..." });
    expect(describesTextInput(makeLoginDialog())).toBe(true);
  });
});

describe("tsp picker pending confirmation (OMP session Delete)", () => {
  const confirmProps = {
    ...pickerProps,
    confirm: { text: "Delete “notes” ? This removes the session file.", act: "delete-confirm", label: "Delete" },
  };

  it("reads an open confirmation as a yes/no dialog instead of the list", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: confirmProps }] });
    const model = tspPickerAdapter.read(component, ctxFor());
    expect(model).toEqual({
      kind: "confirm",
      title: "Delete “notes” ? This removes the session file.",
      confirmLabel: "Delete",
    });
  });

  it("sends the host's confirm action on yes and keeps the picker open on no", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: confirmProps }] });
    expect(tspPickerAdapter.act(component, { type: "confirm", yes: true }, ctxFor())).toBe(true);
    expect(tspPickerAdapter.act(component, { type: "confirm", yes: false }, ctxFor())).toBe(true);
    expect(component.events).toEqual([
      { type: "action", key: "picker", act: "delete-confirm", mods: [] },
      { type: "action", key: "picker", act: "close", mods: [] },
    ]);
  });

  it("answers Cancel with close and refuses list actions while the confirmation is open", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: confirmProps }] });
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(tspPickerAdapter.act(component, { type: "choose", key: "a" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:1" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([{ type: "action", key: "picker", act: "close", mods: [] }]);
  });

  it("reads the list again once the confirmation is null", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: { ...confirmProps, confirm: null } }] });
    expect(asSelect(tspPickerAdapter.read(component, ctxFor())).kind).toBe("select");
  });
});

describe("tsp picker text the host shows (Y-2)", () => {
  it("carries the subtitle, the search hint and each item's detail and badges", () => {
    const props = {
      title: "Models",
      subtitle: "Pick a model",
      query: "",
      placeholder: "Search models…",
      items: [
        {
          id: "a",
          label: "alpha",
          detail: "Not configured",
          badges: [
            { text: "default", title: "Default · thinking high" },
            { text: "vision" },
            { text: "vision", title: "Vision" },
          ],
        },
      ],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.subtitle).toBe("Pick a model");
    expect(model.search).toEqual({ query: "", placeholder: "Search models…" });
    expect(model.items[0]).toMatchObject({
      key: "a",
      note: "Not configured",
      // A tooltip equal to its badge text (ignoring case) adds nothing and is dropped.
      badges: ["default (Default · thinking high)", "vision", "vision"],
    });
  });

  it("moves an empty list's text into the notice and keeps the subtitle", () => {
    const props = {
      title: "Hub",
      subtitle: "No usage reported yet",
      items: [],
      tabs: [{ id: "a", label: "All" }],
      tab: "a",
      empty: "No agent activity recorded yet.",
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Hub");
    expect(model.subtitle).toBe("No usage reported yet");
    expect(model.notice).toBe("No agent activity recorded yet.");
  });

  it("answers a confirmation with the host's own action label", () => {
    const props = { items: [{ id: "a", label: "a" }], confirm: { text: "Delete it?", act: "delete-confirm", label: "Delete" } };
    expect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor())).toEqual({
      kind: "confirm",
      title: "Delete it?",
      confirmLabel: "Delete",
    });
  });
});

describe("tsp settings text the host shows (Y-2)", () => {
  it("shows the page label, the lead, the row hint and a choice's current detail", () => {
    const props = {
      title: "Settings",
      pages: [{ id: "general", label: "General" }, { id: "models", label: "Models" }],
      page: "models",
      lead: "Pick the models pi uses.",
      sections: [
        {
          id: "s1",
          title: "Inference",
          rows: [
            { id: "think", label: "Thinking", hint: "How hard to think", control: { k: "switch", on: true } },
            {
              id: "theme",
              label: "Theme",
              control: {
                k: "choice",
                value: "dark",
                options: [
                  { value: "dark", label: "Dark", detail: "Dark palette" },
                  { value: "light", label: "Light", detail: "Light palette" },
                ],
              },
            },
          ],
        },
      ],
    };
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: props }), ctxFor()));
    expect(model.subtitle).toBe("Models");
    expect(model.notice).toBe("Pick the models pi uses.");
    expect(model.items).toEqual([
      { key: "page:general", label: "📄 General", hasSubmenu: true, shortcut: true },
      { key: "think", label: "Thinking", value: "On", values: ["On", "Off"], note: "How hard to think", group: "Inference" },
      { key: "theme", label: "Theme", value: "Dark", values: ["Dark", "Light"], note: "Dark palette", group: "Inference" },
    ]);
  });

  it("drops the lead while a search is active", () => {
    const props = { title: "Settings", pages: [], page: "general", lead: "Lead", query: "th", sections: [] };
    const model = asSettings(tspPrefsAdapter.read(makeComponent({ k: "prefs", p: props }), ctxFor()));
    expect(model.notice).toBeUndefined();
  });

  it("gives each option of a multi-select submenu its detail", () => {
    const props = {
      title: "Settings",
      pages: [],
      page: "general",
      sections: [
        {
          id: "s",
          title: "S",
          rows: [
            {
              id: "langs",
              label: "Languages",
              control: {
                k: "multi",
                values: ["ts"],
                options: [
                  { value: "ts", label: "TypeScript", detail: "Typed JS" },
                  { value: "py", label: "Python" },
                ],
              },
            },
          ],
        },
      ],
    };
    const component = makeComponent({ k: "prefs", p: props });
    tspPrefsAdapter.act(component, { type: "submenu", key: "langs" }, ctxFor());
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.submenu?.model).toMatchObject({
      kind: "select",
      items: [
        { key: "ts", label: "TypeScript", checked: true, note: "Typed JS" },
        { key: "py", label: "Python", checked: false },
      ],
    });
  });
});

describe("tsp input wizard step (Y-2)", () => {
  const wizard = (title: string, lead: string) => ({
    k: "frame",
    c: [
      {
        k: "row",
        p: { role: "omp.mcpAdd.progress" },
        c: [
          { k: "col", p: { role: "omp.mcpAdd.phase", tone: "accent" }, c: [{ k: "text", p: { text: "Name" } }] },
          { k: "col", p: { role: "omp.mcpAdd.phase", tone: "muted" }, c: [{ k: "text", p: { text: "Transport" } }] },
        ],
      },
      {
        k: "col",
        c: [
          { k: "text", p: { text: title, role: "omp.mcpAdd.title" } },
          { k: "text", p: { text: lead, role: "omp.mcpAdd.lead" } },
        ],
      },
      { k: "input", p: { text: "", placeholder: "github" } },
    ],
  });

  it("reads the step title, the lead as detail and the phase strip with the current step marked", () => {
    const component = makeComponent(wizard("Name the server", "A unique name: it labels the server."));
    expect(tspInputAdapter.read(component, ctxFor())).toEqual({
      kind: "input",
      title: "Name the server",
      detail: "A unique name: it labels the server.",
      placeholder: "github",
      secret: false,
      steps: [
        { label: "Name", current: true },
        { label: "Transport", current: false },
      ],
    });
  });

  it("keeps the label rule for a login prompt without wizard roles", () => {
    const component = makeComponent({ k: "frame", c: [{ k: "text", p: { text: "Paste your API key:" } }, { k: "input", p: { text: "" } }] });
    expect(tspInputAdapter.read(component, ctxFor())).toMatchObject({ kind: "input", title: "Paste your API key" });
    expect(tspInputAdapter.read(component, ctxFor())).not.toHaveProperty("steps");
  });
});

describe("tsp picker row-scoped actions", () => {
  const sessionProps = () => ({
    title: "Resume",
    noun: "sessions",
    items: [
      { id: "s1", label: "charlie" },
      { id: "s2", label: "bravo" },
      { id: "s3", label: "alpha" },
    ],
    selected: "s1",
    current: ["s1"],
    actions: [
      { id: "resume", label: "Resume", primary: true },
      { id: "delete", label: "Delete" },
      { id: "scope", label: "All projects" },
      { id: "close", label: "Close" },
    ],
  });

  /**
   * A session picker that answers like OMP's: `select` moves the highlight,
   * `delete` opens the confirmation for the highlighted row, and the confirm
   * action removes that row. It records every event it receives.
   */
  function makeSessionHost() {
    const props: Record<string, unknown> = sessionProps();
    const events: unknown[] = [];
    const removed: string[] = [];
    const component = {
      events,
      removed,
      props,
      describe: () => ({ k: "picker", p: props }),
      handleNativeEvent: (event: Record<string, unknown>) => {
        events.push(event);
        if (event.type === "select") props.selected = event.item;
        else if (event.type === "action" && event.act === "delete") {
          props.confirm = { text: "Delete it? This removes the session file.", act: "delete-confirm", label: "Delete" };
        } else if (event.type === "action" && event.act === "delete-confirm") {
          removed.push(String(props.selected));
          props.items = (props.items as { id: string }[]).filter((item) => item.id !== props.selected);
          props.confirm = null;
        }
      },
    };
    return component;
  }

  const keyOf = (model: ReturnType<typeof asSelect>, label: string) =>
    model.extraActions?.find((extra) => extra.label === label)?.key ?? expect.fail(`no ${label} action`);

  it("keeps the primary and list-wide actions firing at once", () => {
    const host = makeSessionHost();
    const model = asSelect(tspPickerAdapter.read(host, ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Resume", key: "act:0" },
      { label: "Delete", key: "act:1" },
      { label: "All projects", key: "act:2" },
    ]);
    expect(tspPickerAdapter.act(host, { type: "key", name: "act:2" }, ctxFor())).toBe(true);
    expect(tspPickerAdapter.act(host, { type: "key", name: "act:0" }, ctxFor())).toBe(true);
    expect(host.events).toEqual([
      { type: "action", key: "", act: "scope", mods: [] },
      { type: "action", key: "", act: "resume", mods: [] },
    ]);
  });

  it("answers Delete with a row choice instead of firing at the host's highlight", () => {
    const host = makeSessionHost();
    const { ctx, renders } = countingCtx();
    const press = tspPickerAdapter.act(host, { type: "key", name: keyOf(asSelect(tspPickerAdapter.read(host, ctx)), "Delete") }, ctx);
    expect(press).toBe(true);
    expect(host.events).toEqual([]);
    expect(renders()).toBe(1);
    const model = asSelect(tspPickerAdapter.read(host, ctx));
    expect(model.subtitle).toBe("Delete: choose a session");
    expect(model.items.map((item) => item.key)).toEqual(["s1", "s2", "s3"]);
    // The action bar steps aside; only the way back stays beside the rows.
    expect(model.extraActions).toEqual([{ label: "Back", key: "pick:back" }]);
  });

  it("selects the chosen row, then fires the action at it", () => {
    const host = makeSessionHost();
    const ctx = ctxFor();
    tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctx);
    expect(tspPickerAdapter.act(host, { type: "choose", key: "s2" }, ctx)).toBe(true);
    expect(host.events).toEqual([
      { type: "select", key: "", item: "s2" },
      { type: "action", key: "", act: "delete", mods: [] },
    ]);
    // The host now asks; the mode is spent, so the confirmation shows.
    expect(tspPickerAdapter.read(host, ctx)).toMatchObject({ kind: "confirm" });
  });

  it("deletes exactly the picked session through the confirmation", () => {
    const host = makeSessionHost();
    const ctx = ctxFor();
    tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctx);
    tspPickerAdapter.act(host, { type: "choose", key: "s3" }, ctx);
    expect(tspPickerAdapter.act(host, { type: "confirm", yes: true }, ctx)).toBe(true);
    expect(host.removed).toEqual(["s3"]);
    const model = asSelect(tspPickerAdapter.read(host, ctx));
    expect(model.items.map((item) => item.key)).toEqual(["s1", "s2"]);
    expect(model.subtitle).toBeUndefined();
  });

  it("leaves pick mode with Back without touching the host", () => {
    const host = makeSessionHost();
    const ctx = ctxFor();
    tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctx);
    expect(tspPickerAdapter.act(host, { type: "key", name: "pick:back" }, ctx)).toBe(true);
    expect(host.events).toEqual([]);
    const model = asSelect(tspPickerAdapter.read(host, ctx));
    expect(model.subtitle).toBeUndefined();
    expect(model.extraActions?.map((extra) => extra.label)).toEqual(["Resume", "Delete", "All projects"]);
    // A row tap is a plain activation again.
    expect(tspPickerAdapter.act(host, { type: "choose", key: "s2" }, ctx)).toBe(true);
    expect(host.events).toEqual([{ type: "activate", key: "", item: "s2" }]);
  });

  it("refuses a row the list no longer holds and drops the mode", () => {
    const host = makeSessionHost();
    const ctx = ctxFor();
    tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctx);
    expect(tspPickerAdapter.act(host, { type: "choose", key: "gone" }, ctx)).toBe(false);
    expect(host.events).toEqual([]);
    expect(asSelect(tspPickerAdapter.read(host, ctx)).subtitle).toBeUndefined();
  });

  it("drops the mode when the host stops offering the action", () => {
    const host = makeSessionHost();
    const ctx = ctxFor();
    tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctx);
    host.props.actions = [{ id: "resume", label: "Resume", primary: true }];
    const model = asSelect(tspPickerAdapter.read(host, ctx));
    expect(model.subtitle).toBeUndefined();
    expect(tspPickerAdapter.act(host, { type: "choose", key: "s2" }, ctx)).toBe(true);
    expect(host.events).toEqual([{ type: "activate", key: "", item: "s2" }]);
  });

  it("does not enter pick mode on an empty list", () => {
    const host = makeSessionHost();
    host.props.items = [];
    expect(tspPickerAdapter.act(host, { type: "key", name: "act:1" }, ctxFor())).toBe(false);
    expect(host.events).toEqual([]);
  });

  it("keeps the mode per picker component", () => {
    const first = makeSessionHost();
    const second = makeSessionHost();
    tspPickerAdapter.act(first, { type: "key", name: "act:1" }, ctxFor());
    expect(asSelect(tspPickerAdapter.read(second, ctxFor())).subtitle).toBeUndefined();
    expect(asSelect(tspPickerAdapter.read(first, ctxFor())).subtitle).toBe("Delete: choose a session");
  });
});
