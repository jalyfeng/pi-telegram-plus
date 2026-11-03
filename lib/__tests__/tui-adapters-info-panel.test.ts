/**
 * `infoPanelAdapter` reads read-only panels from structured sources only:
 * a loader's message, an OMP describe tree, or a container's text children.
 * `render()` is never called, and a panel with nothing readable is unsupported
 * (plan v8 §0.0 item 4).
 */
import { describe, expect, it, vi } from "vitest";
import { infoPanelAdapter } from "../tui/adapters/index.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

function ctxFor(entry?: EntryInfo, host: "pi" | "omp" = "pi") {
  const keys: string[] = [];
  const ctx: AdapterContext = {
    host,
    entry,
    sendKey: (name) => {
      keys.push(name);
      return true;
    },
    requestRender: () => {},
  };
  return { ctx, keys };
}

const panelEntry: EntryInfo = { kind: "panel", source: "pi", title: "Status" };

describe("infoPanelAdapter read", () => {
  it("reads a pi Loader's message and never calls render", () => {
    const render = vi.fn(() => ["screen"]);
    const component = { message: "Compacting…", handleInput: () => {}, render };
    const { ctx } = ctxFor(panelEntry);

    const model = infoPanelAdapter.read(component, ctx);
    expect(model).toMatchObject({ kind: "info", text: "Compacting…" });
    expect(render).not.toHaveBeenCalled();
  });

  it("reads a cancellable loader's message as progress", () => {
    const render = vi.fn(() => ["screen"]);
    const component = { message: "Compacting…", cancel: vi.fn(), handleInput: () => {}, render };
    const { ctx } = ctxFor(panelEntry);

    expect(infoPanelAdapter.read(component, ctx)).toEqual({ kind: "progress", text: "Compacting…", cancellable: true });
    expect(render).not.toHaveBeenCalled();
  });

  it("reads a BorderedLoader's inner loader message as cancellable progress", () => {
    const render = vi.fn(() => ["screen"]);
    const component = {
      loader: { message: "Sharing…" },
      cancellable: true,
      signal: new AbortController().signal,
      handleInput: () => {},
      render,
    };
    const { ctx } = ctxFor(panelEntry);

    expect(infoPanelAdapter.read(component, ctx)).toEqual({ kind: "progress", text: "Sharing…", cancellable: true });
    expect(render).not.toHaveBeenCalled();
  });

  it("reads an OMP spinner label from its describe tree", () => {
    const render = vi.fn(() => ["screen"]);
    const tree = {
      k: "col",
      c: [{ k: "spinner", p: { label: "Indexing repo" } }],
    };
    const component = {
      describe: () => tree,
      cancel: vi.fn(),
      handleInput: () => {},
      render,
    };
    const { ctx } = ctxFor(panelEntry, "omp");

    expect(infoPanelAdapter.read(component, ctx)).toEqual({ kind: "progress", text: "Indexing repo", cancellable: true });
    expect(render).not.toHaveBeenCalled();
  });

  it("reads inert container children through their text fields", () => {
    const render = vi.fn(() => ["screen"]);
    const component = { children: [{ text: "first line" }, { text: "second line" }], handleInput: () => {}, render };
    const { ctx } = ctxFor(panelEntry);

    const model = infoPanelAdapter.read(component, ctx);
    expect(model.kind).toBe("info");
    if (model.kind !== "info") throw new Error("expected info");
    expect(model.text).toContain("first line");
    expect(model.text).toContain("second line");
    expect(render).not.toHaveBeenCalled();
  });

  it("answers unsupported when nothing structured is readable", () => {
    const render = vi.fn(() => ["Some screen text"]);
    const component = { handleInput: () => {}, render };
    const { ctx, keys } = ctxFor(panelEntry);

    const model = infoPanelAdapter.read(component, ctx);
    expect(model).toEqual({ kind: "unsupported", title: "Status", what: "unknown dialog" });
    expect(JSON.stringify(model)).not.toContain("Some screen text");
    expect(render).not.toHaveBeenCalled();

    // Escape is still the only key that goes in.
    expect(infoPanelAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(keys).toEqual(["esc"]);
  });
});

/**
 * OMP's BorderedLoader (oh-my-pi@v18.14.1 packages/tui/src/overlays/bordered-loader.ts) as the shipped binary
 * has it: the class name is minified (here "Zq"), there is no `cancellable` flag and no stop method, only the
 * `signal` getter that Escape aborts through, and a describe tree with the loader's spinner and a hints row.
 */
class Zq {
  render(): string[] {
    return [];
  }
  handleInput(): void {}
  get signal(): AbortSignal {
    return new AbortController().signal;
  }
  describe() {
    return {
      k: "card",
      p: { role: "omp.hook.loader" },
      c: [
        { k: "spinner", p: { style: "starburst", label: [{ t: "Sharing session..." }] } },
        {
          k: "row",
          p: { role: "omp.overlay.hints", gap: "md", wrap: true },
          c: [{ k: "row", p: { gap: "xs" }, c: [{ k: "kbd", p: { key: "escape" } }, { k: "text", p: { text: [{ t: "cancel" }] } }] }],
        },
      ],
    };
  }
}

describe("infoPanelAdapter: OMP's minified BorderedLoader is a cancellable progress wait", () => {
  it("reads its spinner label as progress, not the hints row, and Cancel sends Escape", () => {
    const component = new Zq();
    const { ctx, keys } = ctxFor(undefined, "omp");
    const model = infoPanelAdapter.read(component, ctx);
    expect(model).toEqual({ kind: "progress", text: "Sharing session...", cancellable: true });
    expect(infoPanelAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(keys).toEqual(["esc"]);
  });
  it("does not call a loader-role card without an AbortSignal a cancellable wait", () => {
    class Yk {
      render(): string[] {
        return [];
      }
      handleInput(): void {}
      describe() {
        return { k: "card", p: { role: "omp.hook.loader" }, c: [{ k: "spinner", p: { label: [{ t: "Sharing session..." }] } }] };
      }
    }
    const { ctx } = ctxFor(undefined, "omp");
    expect(infoPanelAdapter.read(new Yk(), ctx).kind).not.toBe("progress");
  });
});

describe("infoPanelAdapter title", () => {
  it("takes the host's own title for a text panel the entry leaves untitled", () => {
    const component = { title: "Recent Changes", children: [{ text: "1.2.0 fixed the thing" }], handleInput: () => {}, render: () => ["screen"] };
    const { ctx } = ctxFor({ kind: "panel", source: "pi" });

    expect(infoPanelAdapter.read(component, ctx)).toMatchObject({ kind: "info", title: "Recent Changes" });
  });
});
