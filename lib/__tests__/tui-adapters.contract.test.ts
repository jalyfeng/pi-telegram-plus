/**
 * Contract tests against the real host dialog components (§7.1).
 *
 * These build the same classes pi instantiates and assert what happens to the
 * component, not what our code intended: after the injected keys the host must
 * resolve the same value a terminal user would have got. A host upgrade that
 * renames a field, re-points a keybinding, or changes what a render looks like
 * therefore fails here instead of showing a dead button in Telegram.
 *
 * Nothing here mocks a component: every dialog below is a real host component,
 * and the one hand-built fixture is a focus owner nothing can model.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as host from "@earendil-works/pi-coding-agent";
import { pickAdapter } from "../tui/adapters/index.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext, DialogModel, EntryInfo } from "../tui/model.ts";

// pi-tui builds colours while the component is constructed, and its loader reads
// pi-tui's own theme singleton. Both are undefined until the theme is seeded.
beforeAll(() => {
  host.initTheme("dark");
});

type KeyLog = { target: string; data: string }[];

/**
 * Wrap every `handleInput` in the tree, so a test can see which object the keys
 * really reached — the focused wrapper, or the list it delegates to. A wrapper
 * that forwards to its own child (pi's loader does) is one injection, not two,
 * so a nested call is not logged a second time.
 */
function recordKeys(root: unknown): KeyLog {
  const keys: KeyLog = [];
  const seen = new Set<unknown>();
  const skip = new Set(["ui", "tui", "theme", "keybindings", "session", "abortController"]);
  let nested = 0;
  const frontier: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (frontier.length > 0) {
    const { node, depth } = frontier.pop() as { node: object; depth: number };
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const original = record.handleInput;
    if (typeof original === "function") {
      const name = (record.constructor as { name?: string } | undefined)?.name ?? "anonymous";
      record.handleInput = (data: string) => {
        if (nested === 0) keys.push({ target: name, data });
        nested += 1;
        try {
          (original as (input: string) => void).call(record, data);
        } finally {
          nested -= 1;
        }
      };
    }
    if (depth >= 3) continue;
    for (const [field, value] of Object.entries(record)) {
      if (skip.has(field) || typeof value === "function") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object") frontier.push({ node: item, depth: depth + 1 });
      } else if (value && typeof value === "object") {
        frontier.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return keys;
}

/** The same AdapterContext the Broker builds, minus the Telegram half. */
function harness(component: unknown, entry?: EntryInfo, hostName: "pi" | "omp" = "pi") {
  const keys = recordKeys(component);
  const ctx: AdapterContext = {
    host: hostName,
    root: component as object,
    entry,
    sendKey: (name) => sendKeyTo(component, name),
    requestRender: () => {},
  };
  return { ctx, keys, bytes: () => keys.map((entry2) => entry2.data) };
}

function expectSelect(model: DialogModel) {
  if (model.kind !== "select") throw new Error(`expected a select model, got ${model.kind}`);
  return model;
}

describe("selector over a plain options list", () => {
  it("reads the options and marks where the terminal cursor is", () => {
    const component = new host.ExtensionSelectorComponent("Pick env", ["dev", "staging", "prod", "local"], () => {}, () => {});
    const { ctx } = harness(component);

    const model = expectSelect(pickAdapter(component, ctx)!.read(component, ctx));

    expect(model.title).toBe("Pick env");
    expect(model.items.map((item) => item.label)).toEqual(["dev", "staging", "prod", "local"]);
    expect(model.items.map((item) => item.key)).toEqual(["0:dev", "1:staging", "2:prod", "3:local"]);
    expect(model.items.map((item) => item.focused)).toEqual([true, false, false, false]);
  });

  it("choosing an option walks the cursor with arrow keys and submits it", () => {
    const resolved: string[] = [];
    const component = new host.ExtensionSelectorComponent("Pick env", ["dev", "staging", "prod", "local"], (value: string) => resolved.push(value), () => {});
    const { ctx, keys } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    const done = adapter.act(component, { type: "choose", key: "2:prod" }, ctx);

    // Two steps down, then enter: the component moves its own cursor, so the
    // terminal mirror and the host state cannot disagree (§4.1.3).
    expect(done).toBe(true);
    expect(keys.map((entry) => entry.data)).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    expect(resolved).toEqual(["prod"]);
  });

  it("cancels with escape", () => {
    const cancelled: string[] = [];
    const component = new host.ExtensionSelectorComponent("Deploy?", ["Yes", "No"], () => {}, () => cancelled.push("cancelled"));
    const { ctx, bytes } = harness(component);

    expect(pickAdapter(component, ctx)!.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(bytes()).toEqual(["\u001b"]);
    expect(cancelled).toEqual(["cancelled"]);
  });

  it("reports a choice as refused when the host's own handler throws on Enter", () => {
    // The login auth selector's API-key row: the arrow key lands, the Enter that would
    // select it throws inside the host. The adapter must not claim the choice landed.
    const component = new host.ExtensionSelectorComponent(
      "Select authentication method:",
      ["Sign in with an account", "Sign in with an API key", "Sign in with Radius"],
      () => {
        throw new Error("host select failed");
      },
      () => {},
    );
    const { ctx, bytes } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    expect(adapter.act(component, { type: "choose", key: "1:Sign in with an API key" }, ctx)).toBe(false);
    expect(bytes()).toEqual(["\u001b[B", "\r"]);
    // The component's own cursor moved, so the next read shows what the terminal shows.
    expect(expectSelect(adapter.read(component, ctx)).items.map((item) => item.focused)).toEqual([false, true, false]);
  });
});

describe("selector that delegates keys to the list it wraps", () => {
  it("reads ShowImages through its inner SelectList and resolves a boolean", () => {
    const resolved: unknown[] = [];
    const component = new host.ShowImagesSelectorComponent(false, (value: boolean) => resolved.push(value), () => {});
    // The wrapper owns focus but binds no key of its own, so a key sent to the
    // focused component has to be routed into the list it wraps.
    expect((component as unknown as Record<string, unknown>).handleInput).toBeUndefined();
    const { ctx, keys } = harness(component);
    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("ext-select");

    const model = expectSelect(adapter.read(component, ctx));
    expect(model.items.map((item) => item.label)).toEqual(["Yes", "No"]);
    expect(model.items[0].description).toBe("Show images inline in terminal");
    expect(model.items.map((item) => item.focused)).toEqual([false, true]);

    expect(adapter.act(component, { type: "choose", key: "0:Yes" }, ctx)).toBe(true);
    expect(keys.map((entry) => entry.target)).toEqual(["SelectList", "SelectList"]);
    expect(resolved).toEqual([true]);
  });

  it("resolves the theme the button named, not the row it happened to sit on", () => {
    const resolved: string[] = [];
    const component = new host.ThemeSelectorComponent("dark", (name: string) => resolved.push(name), () => {}, () => {});
    const { ctx } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    const model = expectSelect(adapter.read(component, ctx));
    const light = model.items.find((item) => item.label === "light");
    const dark = model.items.find((item) => item.label === "dark");
    expect(light).toBeDefined();
    expect(dark?.description).toBe("(current)");

    expect(adapter.act(component, { type: "choose", key: light!.key }, ctx)).toBe(true);
    expect(resolved).toEqual(["light"]);
  });
});

describe("one-line text input", () => {
  const entry: EntryInfo = { kind: "input", title: "Name", source: "pi", method: "showExtensionInput" };

  it("reports the live value of the input as prefill", () => {
    const component = new host.ExtensionInputComponent("Name", "", () => {}, () => {});
    for (const character of "fish") (component as any).input.handleInput(character);
    const { ctx } = harness(component, entry);

    const model = pickAdapter(component, ctx)!.read(component, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);

    expect(model.title).toBe("Name");
    expect(model.prefill).toBe("fish");
    expect(model.secret).toBe(false);
  });

  it("types a reply into the input and submits it", () => {
    const resolved: string[] = [];
    const component = new host.ExtensionInputComponent("Name", "", (value: string) => resolved.push(value), () => {});
    const { ctx, keys } = harness(component, entry);
    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("ext-input");

    expect(adapter.act(component, { type: "submit", text: "guppy" }, ctx)).toBe(true);

    // ctrl+u clears what the terminal had typed, so a reply replaces it instead
    // of continuing it.
    expect(keys[0].data).toBe("\u0015");
    expect(keys[keys.length - 1].data).toBe("\r");
    expect(resolved).toEqual(["guppy"]);
  });
});

describe("a dialog nothing can model", () => {
  it("names the dialog instead of mirroring the screen, and only ever sends Escape", () => {
    const component = { render: () => ["alpha", "  beta"], handleInput: () => {} };
    const { ctx, bytes } = harness(component);

    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("unsupported");

    const model = adapter.read(component, ctx);
    if (model.kind !== "unsupported") throw new Error(`expected an unsupported model, got ${model.kind}`);
    expect(model.what).toBe("Object");
    // The frame is never read: nothing rendered reaches the model.
    expect(JSON.stringify(model)).not.toContain("alpha");

    expect(adapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(bytes()).toEqual(["\u001b"]);
    expect(adapter.act(component, { type: "key", name: "down" }, ctx)).toBe(false);
    expect(adapter.act(component, { type: "submit", text: "x" }, ctx)).toBe(false);
  });
});

describe("read-only panels", () => {
  it("treats a loading spinner as a read-only panel and leaves escape working", () => {
    const tui = { requestRender: () => {} };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = new host.BorderedLoader(tui as never, theme as never, "Working...");
    try {
      const { ctx, bytes } = harness(component);
      const adapter = pickAdapter(component, ctx)!;
      expect(adapter.id).toBe("info-panel");

      const model = adapter.read(component, ctx);
      if (model.kind !== "progress") throw new Error(`expected a progress model, got ${model.kind}`);

      expect(model.text).toContain("Working...");
      // Colors are stripped, so the mirror survives a theme switch.
      expect(model.text).not.toMatch(/\u001b\[/);
      expect(model.cancellable).toBe(true);

      expect(adapter.act(component, { type: "cancel" }, ctx)).toBe(true);
      expect(bytes()).toEqual(["\u001b"]);
      expect((component as any).loader.aborted).toBe(true);
    } finally {
      component.dispose();
    }
  });
});
