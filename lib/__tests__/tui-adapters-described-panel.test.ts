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
      actions: [{ label: "Close", key: "0" }],
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

    expect(describedPanelAdapter.act(component, { type: "choose", key: "0" }, ctx)).toBe(true);
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

  it("refuses a choose whose index is no longer a described button", () => {
    const { component, events } = panel(reportTree());
    expect(describedPanelAdapter.act(component, { type: "choose", key: "5" }, ctxFor().ctx)).toBe(false);
    expect(events).toEqual([]);
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

    expect(describedPanelAdapter.act(outer, { type: "choose", key: "0" }, ctx)).toBe(true);
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
      arg: "0",
    });
    for (let step = 0; step < 8; step += 1) await Promise.resolve();

    expect(result.handled).toBe(true);
    expect(events).toEqual([{ type: "action", key: "1/0", act: "close", mods: [] }]);
  });
});
