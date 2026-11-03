/**
 * `describedPanelAdapter`: an OMP text panel is read from its `describe()` tree
 * and answered through the owner's `handleNativeEvent` (plan v8 §0.2). The
 * component's `render()` must never be called: the screen is not data.
 */
import { describe, expect, it, vi } from "vitest";
import { pickAdapter, describedPanelAdapter } from "../tui/adapters/index.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

// The broker takes its host from the global host state; pin it to OMP for the
// broker case below. The adapter tests pass their own context and never read it.
vi.mock("../tui/host.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tui/host.ts")>();
  return { ...actual, currentHostState: () => ({ host: "omp" }) as ReturnType<typeof actual.currentHostState> };
});

type N = Record<string, unknown>;

const text = (value: string): N => ({ k: "text", p: { text: value } });
const button = (label: string, act: string): N => ({
  k: "row",
  p: { role: "omp.btn", actions: { click: act } },
  c: [text(label), { k: "kbd", p: { keys: ["escape"] } }],
});

/** A report-shaped OMP panel: content, then its own Close button at keypath "1/0". */
function reportTree(): N {
  return {
    k: "col",
    c: [
      { k: "col", key: "body", c: [{ k: "md", p: { text: "**Hotkeys**: Ctrl+C quits" } }] },
      { k: "row", p: { role: "omp.actions" }, c: [button("Close", "close")] },
    ],
  };
}

function panel(tree: N) {
  const events: unknown[] = [];
  const render = vi.fn(() => ["screen"]);
  const component = {
    describe: vi.fn(() => tree),
    handleNativeEvent: vi.fn((event: unknown) => {
      events.push(event);
    }),
    render,
  };
  return { component, events, render };
}

function ctxFor(host: "pi" | "omp" = "omp", entry?: EntryInfo) {
  const keys: string[] = [];
  let renders = 0;
  const ctx: AdapterContext = {
    host,
    entry,
    sendKey: (name) => {
      keys.push(name);
      return true;
    },
    requestRender: () => {
      renders += 1;
    },
  };
  return { ctx, keys, renders: () => renders };
}

describe("describedPanelAdapter detect", () => {
  it("claims a pure text panel on OMP", () => {
    const { component } = panel(reportTree());
    const { ctx } = ctxFor();
    expect(describedPanelAdapter.detect(component, ctx)).toBe(true);
    expect(pickAdapter(component, ctx)?.id).toBe("described-panel");
  });

  it("leaves a tree with a picker to the tsp picker adapter", () => {
    const { component } = panel({ k: "col", c: [{ k: "picker", p: { items: [], title: "Models" } }] });
    const { ctx } = ctxFor();
    expect(describedPanelAdapter.detect(component, ctx)).toBe(false);
    expect(pickAdapter(component, ctx)?.id).toBe("tsp-picker");
  });

  it("declines on pi and for a raced extension dialog", () => {
    const { component } = panel(reportTree());
    expect(describedPanelAdapter.detect(component, ctxFor("pi").ctx)).toBe(false);
    const raced = ctxFor("omp", { kind: "panel", source: "omp", race: { answer: () => true, settled: false } });
    expect(describedPanelAdapter.detect(component, raced.ctx)).toBe(false);
  });

  it("declines a cancellable progress component", () => {
    const { component } = panel(reportTree());
    Object.assign(component, { cancel: () => undefined });
    expect(describedPanelAdapter.detect(component, ctxFor().ctx)).toBe(false);
  });
});

describe("describedPanelAdapter read", () => {
  it("returns the panel as html info with its own Close button and no extra close", () => {
    const { component, render } = panel(reportTree());
    const { ctx } = ctxFor();
    const model = describedPanelAdapter.read(component, ctx);

    expect(model).toEqual({
      kind: "info",
      title: undefined,
      text: "<b>Hotkeys</b>: Ctrl+C quits",
      html: true,
      closable: false,
      actions: [{ label: "Close", key: "close" }],
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("keeps the renderer's Close when the panel has no close button", () => {
    const { component } = panel({ k: "text", p: { text: "usage" } });
    const model = describedPanelAdapter.read(component, ctxFor().ctx);

    expect(model).toMatchObject({ kind: "info", closable: true, actions: [] });
  });
});

describe("describedPanelAdapter act", () => {
  it("sends a chosen button as an action event with its keypath and act", () => {
    const { component, events, render } = panel(reportTree());
    const { ctx, renders } = ctxFor();

    expect(describedPanelAdapter.act(component, { type: "choose", key: "close" }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "action", key: "1/0", act: "close", mods: [] }]);
    expect(renders()).toBe(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("maps cancel onto the panel's close action", () => {
    const { component, events } = panel(reportTree());
    const { ctx, keys } = ctxFor();

    expect(describedPanelAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "action", key: "1/0", act: "close", mods: [] }]);
    expect(keys).toEqual([]);
  });

  it("falls back to Escape on cancel when there is no close action", () => {
    const { component, events } = panel({ k: "text", p: { text: "usage" } });
    const { ctx, keys } = ctxFor();

    expect(describedPanelAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(keys).toEqual(["esc"]);
    expect(events).toEqual([]);
  });

  it("refuses a choose whose key names no button in the live tree", () => {
    const { component, events } = panel(reportTree());
    expect(describedPanelAdapter.act(component, { type: "choose", key: "5" }, ctxFor().ctx)).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps a key on its button when the tree changes between read and press", () => {
    const tree = reportTree();
    const { component, events } = panel(tree);
    const { ctx } = ctxFor();
    const model = describedPanelAdapter.read(component, ctx);
    const closeKey = (model as { actions: { key: string }[] }).actions[0]!.key;

    // The panel gains a page row above the close button: Close moves to keypath "2/0".
    tree.c = [
      { k: "row", p: { role: "omp.actions" }, c: [button("Prev", "page")] },
      ...(tree.c as unknown[]),
    ];
    expect(describedPanelAdapter.act(component, { type: "choose", key: closeKey }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "action", key: "2/0", act: "close", mods: [] }]);
  });

  it("refuses a stale key rather than firing a different button", () => {
    const tree: N = {
      k: "col",
      c: [button("Prev", "page"), button("Close", "close")],
    };
    const { component, events } = panel(tree);
    const { ctx } = ctxFor();
    const keys = (describedPanelAdapter.read(component, ctx) as { actions: { key: string }[] }).actions.map((action) => action.key);
    expect(keys).toEqual(["page", "close"]);

    // Close is gone; the page button is still there. A press on the old Close key must not fire Prev.
    tree.c = [button("Prev", "page")];
    expect(describedPanelAdapter.act(component, { type: "choose", key: "close" }, ctx)).toBe(false);
    expect(events).toEqual([]);
  });

  it("keys two buttons with the same act by their keypath", () => {
    const tree: N = { k: "col", c: [button("Prev", "page"), button("Next", "page")] };
    const { component, events } = panel(tree);
    const { ctx } = ctxFor();
    const model = describedPanelAdapter.read(component, ctx) as { actions: { key: string }[] };
    expect(model.actions.map((action) => action.key)).toEqual(["0|page", "1|page"]);

    expect(describedPanelAdapter.act(component, { type: "choose", key: "1|page" }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "action", key: "1", act: "page", mods: [] }]);
  });

  it("replays a button of a nested component through the nested owner", () => {
    const inner = {
      describe: () => ({ k: "col", c: [button("Done", "close")] }),
      handleNativeEvent: vi.fn(),
    };
    const outer = {
      describe: () => ({ k: "col", c: [text("hi"), inner] }),
      handleNativeEvent: vi.fn(),
      render: vi.fn(),
    };
    const { ctx } = ctxFor();

    expect(describedPanelAdapter.act(outer, { type: "choose", key: "close" }, ctx)).toBe(true);
    expect(inner.handleNativeEvent).toHaveBeenCalledWith({ type: "action", key: "0", act: "close", mods: [] });
    expect(outer.handleNativeEvent).not.toHaveBeenCalled();
    expect(outer.render).not.toHaveBeenCalled();
  });
});

describe("a Telegram press on a described panel", () => {
  it("reaches the owner's handleNativeEvent through the broker callback", async () => {
    const { DialogBroker } = await import("../tui/broker.ts");
    const { component, events } = panel(reportTree());
    const transport = {
      sendButtons: vi.fn(async () => ({ message_id: 101 })),
      editButtons: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [{ message_id: 301 }]),
      removeInlineKeyboard: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
    const listeners = new Set<(info: unknown) => void>();
    const focusInfo = { kind: "dialog", component, source: "event" };
    const focus = {
      current: () => focusInfo,
      validate: () => undefined,
      entryFor: (): EntryInfo => ({ kind: "panel", source: "omp", title: "Hotkeys", method: "showReport" }),
      onChange: (listener: (info: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const broker = new DialogBroker({
      transport: transport as never,
      focus: focus as never,
      origin: { active: () => undefined } as never,
      activeChatId: () => 42,
      activeTurns: () => [{ chatId: 42, sourceMessageId: 7, queuedAttachments: [] }],
      writeText: () => true,
      enabled: () => true,
    } as never);
    broker.start();
    for (const listener of listeners) listener(focusInfo);
    for (let step = 0; step < 8; step += 1) await Promise.resolve();

    const session = broker.current();
    expect(session).toBeDefined();
    const [, , rows] = transport.sendButtons.mock.calls[0] as unknown as [number, string, { text: string }[][]];
    expect(rows.flat().map((entry) => entry.text)).toContain("Close");

    const result = broker.handleCallback(42, undefined, {
      sessionId: session!.id,
      generation: session!.generation,
      op: "c",
      arg: "close",
    });
    for (let step = 0; step < 8; step += 1) await Promise.resolve();

    expect(result.handled).toBe(true);
    expect(events).toEqual([{ type: "action", key: "1/0", act: "close", mods: [] }]);
  });
});

describe("describedPanelAdapter redaction", () => {
  it("masks a registered secret with & and < in the text it reads", () => {
    const secret = "a&b<c";
    const { component } = panel({ k: "col", c: [{ k: "md", p: { text: `key is ${secret} ok` } }] });
    const { ctx } = ctxFor();
    ctx.redact = (value: string) => value.split(secret).join("***");

    const model = describedPanelAdapter.read(component, ctx) as { text: string };
    expect(model.text).toContain("key is *** ok");
    expect(model.text).not.toContain("&amp;b");
  });
});

describe("long described panels", () => {
  const long = (): N => ({
    k: "col",
    c: [{ k: "md", p: { text: Array.from({ length: 200 }, (_, index) => `Paragraph ${index}: ${"lorem ipsum dolor sit amet ".repeat(2)}`).join("\n\n") } }],
  });

  it("splits a 10k-character report into pages, each within the budget, with the actions on every page", async () => {
    const { renderDialog } = await import("../tui/render-telegram.ts");
    const { component } = panel({ k: "col", c: [(long().c as unknown[])[0], button("Close", "close")] });
    const model = describedPanelAdapter.read(component, ctxFor().ctx) as Parameters<typeof renderDialog>[0];
    expect(model.kind).toBe("info");
    if (model.kind !== "info") return;
    expect(model.text.length).toBeGreaterThan(9000);

    const first = renderDialog(model, { sessionId: "s1", generation: 1, page: 0 });
    expect(first.pages).toBeGreaterThan(2);
    const last = renderDialog(model, { sessionId: "s1", generation: 1, page: first.pages - 1 });
    for (const shown of [first, last]) {
      expect(Buffer.byteLength(shown.text, "utf8")).toBeLessThanOrEqual(4096);
      expect(shown.rows.flat().map((entry) => entry.text)).toContain("Close");
    }
    expect(first.rows.flat().map((entry) => entry.text)).toContain("Next ▶");
    expect(first.text).toContain(`Page 1/${first.pages}`);
  });

  it("turns pages in place through the broker's page callback", async () => {
    const { DialogBroker } = await import("../tui/broker.ts");
    const { component } = panel({ k: "col", c: [(long().c as unknown[])[0], button("Close", "close")] });
    const transport = {
      sendButtons: vi.fn(async () => ({ message_id: 101 })),
      editButtons: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [{ message_id: 301 }]),
      removeInlineKeyboard: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
    const listeners = new Set<(info: unknown) => void>();
    const focusInfo = { kind: "dialog", component, source: "event" };
    const focus = {
      current: () => focusInfo,
      validate: () => undefined,
      entryFor: (): EntryInfo => ({ kind: "panel", source: "omp", title: "Hotkeys", method: "showReport" }),
      onChange: (listener: (info: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const broker = new DialogBroker({
      transport: transport as never,
      focus: focus as never,
      origin: { active: () => undefined } as never,
      activeChatId: () => 42,
      activeTurns: () => [{ chatId: 42, sourceMessageId: 7, queuedAttachments: [] }],
      writeText: () => true,
      enabled: () => true,
    } as never);
    broker.start();
    for (const listener of listeners) listener(focusInfo);
    for (let step = 0; step < 8; step += 1) await Promise.resolve();

    const session = broker.current()!;
    const result = broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "p", arg: "1" });
    for (let step = 0; step < 8; step += 1) await Promise.resolve();

    expect(result.handled).toBe(true);
    const [, , text] = transport.editButtons.mock.calls.at(-1) as unknown as [number, number, string, unknown[]];
    expect(text).toContain("Page 2/");
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
  });
});

describe("describedPanelAdapter title", () => {
  it("takes the host's own title for a panel whose tree names none", () => {
    const { component } = panel(reportTree());
    Object.assign(component, { nativeOverlay: { head: "Recent Changes" } });
    expect(describedPanelAdapter.read(component, ctxFor().ctx)).toMatchObject({ title: "Recent Changes" });
  });

  it("takes the panel's own title when it has no overlay head", () => {
    const { component } = panel(reportTree());
    Object.assign(component, { title: "Available Tools" });
    expect(describedPanelAdapter.read(component, ctxFor().ctx)).toMatchObject({ title: "Available Tools" });
  });

  it("names the panel after its command when the host gave no title", () => {
    const { component } = panel(reportTree());
    const { ctx } = ctxFor();
    ctx.commandName = "/changelog";
    expect(describedPanelAdapter.read(component, ctx)).toMatchObject({ title: "/changelog" });
  });

  it("keeps the entry's title over the host's own", () => {
    const { component } = panel(reportTree());
    Object.assign(component, { nativeOverlay: { head: "Recent Changes" } });
    const { ctx } = ctxFor("omp", { kind: "panel", source: "omp", title: "Usage" });
    expect(describedPanelAdapter.read(component, ctx)).toMatchObject({ title: "Usage" });
  });
});

describe("OMP panels with lists, meters and nested components", () => {
  // Shapes copied from OMP 18.14.1 dumps: `/marketplace` is a SelectList root with an empty-list item;
  // `/context` is a described root with a meter (parts + marks) and a selectable category list.
  const marketplaceTree = (): N => ({
    k: "col",
    p: { role: "omp.select" },
    c: [
      {
        k: "list",
        key: "list",
        p: { selected: "__empty__", empty: "No items", max: { lines: 1 } },
        c: [
          {
            k: "item",
            key: "__empty__",
            p: {
              label: [{ t: "No plugins available" }],
              detail: [{ t: "Add a marketplace first: /marketplace add <source>", s: "muted" }],
              disabled: true,
            },
          },
        ],
      },
    ],
  });

  const contextTree = (): N => ({
    k: "col",
    p: { role: "omp.context", grow: 1 },
    c: [
      {
        k: "meter",
        key: "bar",
        p: {
          value: 0.039,
          style: "bar",
          parts: [
            { value: 0.0156, token: "accent", label: "System Prompt (excluding Skills) · 3.1K tokens (1.6%)" },
            { value: 0.811, token: "track", label: "Free space · 162K tokens (81.1%)" },
          ],
          marks: [{ at: 0.85, tone: "warning", title: "Auto-compaction at 85% · 170K tokens" }],
        },
      },
      {
        k: "col",
        key: "overview",
        c: [
          {
            k: "list",
            key: "categories",
            p: { selected: "system-prompt", actions: { click: "select", dblclick: "activate" } },
            c: [
              { k: "item", key: "system-prompt", p: { label: [{ t: "■ ", s: "accent" }, { t: "System Prompt (excluding Skills)", s: "accent strong" }], value: [{ t: "3.1K · 1.6%", s: "accent" }] } },
              { k: "item", key: "skills", p: { label: [{ t: "■ ", s: "success" }, { t: "Skills" }], value: "0 · 0.0%" } },
            ],
          },
        ],
      },
      { k: "row", p: { role: "omp.actions" }, c: [button("Close", "close")] },
    ],
  });

  it("reads the empty marketplace list as its text instead of an empty body", () => {
    const { component } = panel(marketplaceTree());
    const model = describedPanelAdapter.read(component, ctxFor("omp", { kind: "panel", source: "omp", title: "/marketplace" }).ctx);

    expect(model).toMatchObject({ kind: "info", title: "/marketplace", closable: true, actions: [] });
    expect((model as { text: string }).text).toContain("No plugins available");
    expect((model as { text: string }).text).toContain("Add a marketplace first");
  });

  it("writes every context category and each meter part label into the text", () => {
    const { component } = panel(contextTree());
    const model = describedPanelAdapter.read(component, ctxFor().ctx) as { text: string; actions: { label: string }[] };

    expect(model.text).toContain("System Prompt (excluding Skills) · 3.1K tokens (1.6%)");
    expect(model.text).toContain("Free space · 162K tokens (81.1%)");
    expect(model.text).toContain("Auto-compaction at 85% · 170K tokens");
    expect(model.text).toContain("Skills");
    expect(model.actions.map((action) => action.label)).toEqual(["System Prompt (excluding Skills)", "Skills", "Close"]);
  });

  it("answers a press on a context category with an activate event for that item", () => {
    const { component, events } = panel(contextTree());
    const { ctx } = ctxFor();
    const model = describedPanelAdapter.read(component, ctx) as { actions: { label: string; key: string }[] };
    const skills = model.actions.find((action) => action.label === "Skills")!;

    expect(describedPanelAdapter.act(component, { type: "choose", key: skills.key }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "activate", key: "overview/categories", item: "skills" }]);
  });

  it("names an overlay the adapters cannot read by its title and its undescribed nested component", () => {
    class Spacer {
      render(): string[] {
        return [];
      }
    }
    // OMP's /debug: an overlay card (no native events of its own) over a spacer and a list.
    const component = {
      title: "Debug Tools",
      describe: () => ({ k: "card", p: { role: "omp.overlay", head: "Debug Tools" }, c: [new Spacer()] }),
      render: () => ["screen"],
    };
    const { ctx } = ctxFor();
    const adapter = pickAdapter(component, ctx);

    expect(adapter?.id).toBe("unsupported");
    expect(adapter?.read(component, ctx)).toEqual({
      kind: "unsupported",
      title: undefined,
      what: "Debug Tools (nested component without a description)",
    });
  });
});
