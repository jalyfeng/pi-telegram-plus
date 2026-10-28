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
    expect(model).toEqual({ kind: "unsupported", title: "Status", what: "Object" });
    expect(JSON.stringify(model)).not.toContain("Some screen text");
    expect(render).not.toHaveBeenCalled();

    // Escape is still the only key that goes in.
    expect(infoPanelAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(keys).toEqual(["esc"]);
  });
});
