/**
 * Adapter P2: pi's `/settings` (`SettingsList`, §4.6.4 #5).
 *
 * The whole file drives the real pi-tui 1.4.0 `SettingsList` (plus real
 * `SelectList` submenus) through `read`/`act` with keys delivered to the
 * component's own `handleInput`, like the Broker: a host upgrade that renames
 * a field or re-points a key fails here, and `onChange` proves the value
 * actually landed.
 */
import { describe, expect, it } from "vitest";
import { SelectList } from "../../node_modules/@earendil-works/pi-tui/dist/components/select-list.js";
import { SettingsList } from "../../node_modules/@earendil-works/pi-tui/dist/components/settings-list.js";
import { SteppedSubmenu } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/settings-submenu.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { piSettingsAdapter } from "../tui/adapters/pi-settings.ts";
import { extensionSelectAdapter } from "../tui/adapters/extension.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

/** pi's theme is a module singleton; SteppedSubmenu draws through it. */
initTheme();

/** Submenus only render on demand; nothing here draws, so an empty theme works. */
const theme = {} as never;

type Change = { id: string; value: string };
type Item = {
  id: string;
  label: string;
  currentValue: string;
  values?: string[];
  submenu?: (current: string, done: (value?: string) => void) => object;
};

/** pi's `private` is compile-time only; tests reach the runtime fields. */
const fields = (component: object): Record<string, unknown> => component as unknown as Record<string, unknown>;

function settingsHarness() {
  const changes: Change[] = [];
  const items: Item[] = [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "notifications", label: "Notifications", currentValue: "off", values: ["on", "off", "quiet"] },
    {
      id: "tools",
      label: "Tool visibility",
      currentValue: "visible",
      submenu: (current, done) => {
        const list = new SelectList(
          [
            { value: "visible", label: "Visible" },
            { value: "hidden", label: "Hidden" },
            { value: "collapsed", label: "Collapsed" },
          ],
          5,
          theme,
        );
        list.onSelect = (picked: { value: string }) => done(picked.value);
        list.onCancel = () => done();
        list.setFilter("");
        void current;
        return list;
      },
    },
  ];
  const list = new SettingsList(items as never, 10, theme, (id: string, value: string) => changes.push({ id, value }), () => {});
  const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(list, name), requestRender: () => {} };
  return { list, ctx, items, changes };
}

function expectSettings(model: DialogModel) {
  if (model.kind !== "settings") throw new Error(`expected a settings model, got ${model.kind}`);
  return model;
}

function expectSubmenu(model: DialogModel) {
  const settings = expectSettings(model);
  if (settings.submenu === undefined) throw new Error("expected an open submenu");
  return settings.submenu;
}

describe("piSettingsAdapter detect", () => {
  it("claims SettingsList on the pi host only", () => {
    const { list, ctx } = settingsHarness();
    expect(piSettingsAdapter.detect(list, ctx)).toBe(true);
    expect(piSettingsAdapter.detect(list, { ...ctx, host: "omp" })).toBe(false);
    expect(piSettingsAdapter.detect({ items: [] }, ctx)).toBe(false);
  });

  it("is picked before the generic filteredRows adapter", () => {
    const { list, ctx } = settingsHarness();
    expect(pickAdapter(list, ctx)).toBe(piSettingsAdapter);
    // The generic adapter would still match; ours must simply come first.
    expect(extensionSelectAdapter.detect(list, ctx)).toBe(true);
  });
});

describe("read: main list", () => {
  it("reports title, current values, value lists, submenu flags and cursor", () => {
    const { list, ctx } = settingsHarness();
    fields(list).selectedIndex = 2;
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.title).toBe("Settings");
    expect(model.items.map((item) => item.label)).toEqual(["Theme", "Notifications", "Tool visibility"]);
    expect(model.items.map((item) => item.value)).toEqual(["dark", "off", "visible"]);
    expect(model.items.map((item) => item.values)).toEqual([["dark", "light"], ["on", "off", "quiet"], undefined]);
    expect(model.items.map((item) => item.hasSubmenu)).toEqual([false, false, true]);
    expect(model.items.map((item) => item.focused)).toEqual([false, false, true]);
    expect(model.items.map((item) => item.key)).toEqual(["0:Theme", "1:Notifications", "2:Tool visibility"]);
    expect(model.submenu).toBeUndefined();
  });

  it("shows the filtered list while search is on", () => {
    const changes: Change[] = [];
    const items: Item[] = [
      { id: "a", label: "Alpha", currentValue: "x", values: ["x", "y"] },
      { id: "b", label: "Beta", currentValue: "on", values: ["on", "off"] },
    ];
    const list = new SettingsList(items as never, 10, theme, (id: string, value: string) => changes.push({ id, value }), () => {}, { enableSearch: true });
    (fields(list).applyFilter as (query: string) => void)("bet");
    const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(list, name), requestRender: () => {} };
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.items.map((item) => item.label)).toEqual(["Beta"]);
    expect(model.items[0].focused).toBe(true);
  });
});

describe("act: cycle", () => {
  it("reaches a named value by pressing Enter the right number of times", () => {
    const { list, ctx, items, changes } = settingsHarness();
    // off -> quiet -> on: two Enters from cursor 0 to row 1.
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "1:Notifications", value: "on" }, ctx)).toBe(true);
    expect(items[1].currentValue).toBe("on");
    expect(changes).toEqual([{ id: "notifications", value: "quiet" }, { id: "notifications", value: "on" }]);
  });

  it("presses nothing when the row already holds the target value", () => {
    const { list, ctx, changes } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "0:Theme", value: "dark" }, ctx)).toBe(true);
    expect(changes).toEqual([]);
  });

  it("refuses a value outside the row's list or a stale current value", () => {
    const { list, ctx, items, changes } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "0:Theme", value: "sepia" }, ctx)).toBe(false);
    items[0].currentValue = "sepia";
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "0:Theme", value: "light" }, ctx)).toBe(false);
    expect(changes).toEqual([]);
  });

  it("cycles once without a value, walking the cursor first", () => {
    const { list, ctx, items, changes } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "1:Notifications" }, ctx)).toBe(true);
    expect(items[1].currentValue).toBe("quiet");
    expect(changes).toEqual([{ id: "notifications", value: "quiet" }]);
  });

  it("refuses a row that is gone", () => {
    const { list, ctx } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "9:Gone" }, ctx)).toBe(false);
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "0:Renamed", value: "light" }, ctx)).toBe(false);
  });
});

describe("act: submenu", () => {
  it("opens it, reads it as a nested select, and choose lands the value", () => {
    const { list, ctx, items, changes } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "2:Tool visibility" }, ctx)).toBe(true);
    const submenu = expectSubmenu(piSettingsAdapter.read(list, ctx));
    expect(submenu.itemKey).toBe("2:Tool visibility");
    if (submenu.model.kind !== "select") throw new Error(`expected a select submenu, got ${submenu.model.kind}`);
    expect(submenu.model.title).toBe("Tool visibility");
    expect(submenu.model.total).toBe(3);
    expect(submenu.model.items.map((item) => item.label)).toEqual(["Visible", "Hidden", "Collapsed"]);
    expect(submenu.model.items.map((item) => item.current)).toEqual([true, false, false]);
    expect(submenu.model.items.map((item) => item.focused)).toEqual([true, false, false]);
    // Choose "Collapsed": down x2 + enter, all forwarded to the submenu.
    expect(piSettingsAdapter.act(list, { type: "choose", key: "2:Collapsed" }, ctx)).toBe(true);
    expect(fields(list).submenuComponent).toBeNull();
    expect(items[2].currentValue).toBe("collapsed");
    expect(changes).toEqual([{ id: "tools", value: "collapsed" }]);
    // Closed again: the next read shows the main list.
    expect(expectSettings(piSettingsAdapter.read(list, ctx)).submenu).toBeUndefined();
  });

  it("submenu cancel returns to the main list without a change", () => {
    const { list, ctx, changes } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "2:Tool visibility" }, ctx)).toBe(true);
    expect(piSettingsAdapter.act(list, { type: "cancel" }, ctx)).toBe(true);
    expect(fields(list).submenuComponent).toBeNull();
    expect(changes).toEqual([]);
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.items[2].focused).toBe(true); // selection restored to the opener
  });

  it("refuses non-row actions while a submenu is open", () => {
    const { list, ctx } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "2:Tool visibility" }, ctx)).toBe(true);
    expect(piSettingsAdapter.act(list, { type: "cycle", key: "0:Theme", value: "light" }, ctx)).toBe(false);
    expect(piSettingsAdapter.act(list, { type: "choose", key: "9:Gone" }, ctx)).toBe(false);
  });

  it("models a non-SelectList submenu as unsupported", () => {
    class ThemePreview {
      handleInput() {}
    }
    const items: Item[] = [{
      id: "skin",
      label: "Skin",
      currentValue: "classic",
      submenu: () => new ThemePreview(),
    }];
    const list = new SettingsList(items as never, 10, theme, () => {}, () => {});
    const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(list, name), requestRender: () => {} };
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "0:Skin" }, ctx)).toBe(true);
    const submenu = expectSubmenu(piSettingsAdapter.read(list, ctx));
    expect(submenu.model.kind).toBe("unsupported");
    if (submenu.model.kind === "unsupported") {
      expect(submenu.model.title).toBe("Skin");
      expect(submenu.model.what).toBe("settings submenu: ThemePreview");
    }
  });
});

describe("act: cancel and unmapped actions", () => {
  it("closes the dialog with esc", () => {
    const { list, ctx } = settingsHarness();
    expect(piSettingsAdapter.act(list, { type: "cancel" }, ctx)).toBe(true);
    expect(piSettingsAdapter.act(list, { type: "choose", key: "0:Theme" }, ctx)).toBe(false);
    expect(piSettingsAdapter.act(list, { type: "toggle", key: "0:Theme" }, ctx)).toBe(false);
    expect(piSettingsAdapter.act(list, { type: "submit" }, ctx)).toBe(false);
  });
});

/** The same dialog with pi 1.4.0's `/settings` search box enabled. */
function searchHarness() {
  const changes: Change[] = [];
  const items: Item[] = [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "notifications", label: "Notifications", currentValue: "off", values: ["on", "off"] },
    {
      id: "tools",
      label: "Tool visibility",
      currentValue: "visible",
      submenu: (current, done) => {
        const list = new SelectList(
          [
            { value: "visible", label: "Visible" },
            { value: "hidden", label: "Hidden" },
          ],
          5,
          theme,
        );
        list.onSelect = (picked: { value: string }) => done(picked.value);
        list.onCancel = () => done();
        list.setFilter("");
        void current;
        return list;
      },
    },
  ];
  const list = new SettingsList(items as never, 10, theme, (id: string, value: string) => changes.push({ id, value }), () => {}, { enableSearch: true });
  const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(list, name), requestRender: () => {} };
  return { list, ctx, changes };
}

describe("search", () => {
  it("exposes the search box and its current query on the main list", () => {
    const { list, ctx } = searchHarness();
    expect(expectSettings(piSettingsAdapter.read(list, ctx)).search).toEqual({ query: "" });
    expect(piSettingsAdapter.act(list, { type: "search", query: "the" }, ctx)).toBe(true);
    expect(expectSettings(piSettingsAdapter.read(list, ctx)).search).toEqual({ query: "the" });
  });

  it("act search filters the list down to the matching rows", () => {
    const { list, ctx } = searchHarness();
    expect(piSettingsAdapter.act(list, { type: "search", query: "theme" }, ctx)).toBe(true);
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.items.map((item) => item.label)).toEqual(["Theme"]);
    expect(model.items[0]?.focused).toBe(true);
  });

  it("strips a leading space instead of activating the row", () => {
    // While the filter is empty SettingsList treats space as Enter, so an
    // untrimmed leading space would cycle Theme's value right here.
    const { list, ctx, changes } = searchHarness();
    expect(piSettingsAdapter.act(list, { type: "search", query: " theme" }, ctx)).toBe(true);
    expect(changes).toEqual([]);
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.search).toEqual({ query: "theme" });
    expect(model.items.map((item) => item.label)).toEqual(["Theme"]);
  });

  it("an empty query clears the filter", () => {
    const { list, ctx } = searchHarness();
    expect(piSettingsAdapter.act(list, { type: "search", query: "theme" }, ctx)).toBe(true);
    expect(piSettingsAdapter.act(list, { type: "search", query: "" }, ctx)).toBe(true);
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.search).toEqual({ query: "" });
    expect(model.items.map((item) => item.label)).toEqual(["Theme", "Notifications", "Tool visibility"]);
  });

  it("a submenu owns the keys: no search field, search refused", () => {
    const { list, ctx } = searchHarness();
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "2:Tool visibility" }, ctx)).toBe(true);
    const model = expectSettings(piSettingsAdapter.read(list, ctx));
    expect(model.submenu).toBeDefined();
    expect(model.search).toBeUndefined();
    expect(piSettingsAdapter.act(list, { type: "search", query: "vis" }, ctx)).toBe(false);
  });

  it("no search field when the host did not enable search", () => {
    const { list, ctx } = settingsHarness();
    expect(expectSettings(piSettingsAdapter.read(list, ctx)).search).toBeUndefined();
    expect(piSettingsAdapter.act(list, { type: "search", query: "theme" }, ctx)).toBe(false);
  });
});

describe("submenu subtitle: pi's own step description", () => {
  /** pi's `/settings` "Default thinking level per model": a two-step SteppedSubmenu. */
  function thinkingHarness() {
    const items = [
      {
        id: "model-thinking",
        label: "Default thinking level per model",
        currentValue: "none",
        submenu: () => new SteppedSubmenu(
          [
            {
              key: "model",
              title: "Per-Model Thinking Level",
              description: "Select a model to configure",
              options: () => [{ value: "a", label: "Model A", description: "off" }],
              preselect: () => "a",
            },
            {
              key: "level",
              title: "Thinking Level for Model A",
              description: "Select default thinking level for this model",
              options: () => [{ value: "off", label: "off" }, { value: "high", label: "high" }],
              preselect: () => "off",
            },
          ],
          () => {},
          () => {},
        ),
      },
    ];
    const list = new SettingsList(items as never, 10, theme, () => {}, () => {});
    const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(list, name), requestRender: () => {} };
    return { list, ctx };
  }

  it("shows the current step's description as the select subtitle, step by step", () => {
    const { list, ctx } = thinkingHarness();
    expect(piSettingsAdapter.act(list, { type: "submenu", key: "0:Default thinking level per model" }, ctx)).toBe(true);
    const first = expectSubmenu(piSettingsAdapter.read(list, ctx));
    if (first.model.kind !== "select") throw new Error(`expected a select submenu, got ${first.model.kind}`);
    // The title is the row that opened the submenu; the step title is pi's own.
    expect(first.model.title).toBe("Default thinking level per model");
    expect(first.model.subtitle).toBe("Step 1/2 · Select a model to configure");
    // Each row carries its current value: pi's option description (the override) is the row's value.
    expect(first.model.items).toEqual([expect.objectContaining({ label: "Model A", value: "off" })]);
    // Choosing the model advances pi to step 2, which carries its own line.
    expect(piSettingsAdapter.act(list, { type: "choose", key: "0:Model A" }, ctx)).toBe(true);
    const second = expectSubmenu(piSettingsAdapter.read(list, ctx));
    if (second.model.kind !== "select") throw new Error(`expected a select submenu, got ${second.model.kind}`);
    expect(second.model.subtitle).toBe("Step 2/2 · Select default thinking level for this model");
  });
});
