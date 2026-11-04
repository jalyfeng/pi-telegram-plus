/**
 * The broker's handling of a text field that lives *inside* another dialog
 * (§4.6.4 #5): OMP's settings page opens its own input for a text or number row,
 * and that field is reached through `settings.submenu.model` rather than as a
 * top-level `input`. The tests drive the real adapter registry against a fake OMP
 * settings page, because the behaviour pinned here is exactly what a top-level
 * `model.kind === "input"` check misses: a token typed into the sub-input is a
 * secret, and a value the host refused must never be typed into the terminal.
 */
import { describe, expect, it, vi } from "vitest";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import { SecretStore } from "../tui/secrets.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { TelegramTurn } from "../types.ts";
import type * as tuiBridgeModule from "../tui-bridge.ts";

// The prefs adapter models a settings page on the OMP host only, and the broker
// takes the host from the bridge's capture view.
vi.mock("../tui-bridge.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof tuiBridgeModule>();
  return {
    ...mod,
    getTuiHostState: () => ({ host: "omp" as const, mode: {}, ui: { requestRender: () => undefined } }),
  };
});

const turn = (chatId: number): TelegramTurn => ({ chatId, sourceMessageId: 7, queuedAttachments: [] });

function fakeTransport() {
  const sent: Array<{ chatId: number; text: string; rows: unknown[][] }> = [];
  const edits: Array<{ chatId: number; text: string }> = [];
  const deleted: number[] = [];
  return {
    sent,
    edits,
    deleted,
    sendButtons: async (chatId: number, text: string, rows: unknown[][]) => {
      sent.push({ chatId, text, rows });
      return { message_id: 100 + sent.length };
    },
    editButtons: async (chatId: number, _messageId: number, text: string) => {
      edits.push({ chatId, text });
    },
    sendText: async (chatId: number, text: string) => {
      sent.push({ chatId, text, rows: [] });
      return [{ message_id: 300 + sent.length }];
    },
    removeInlineKeyboard: async () => undefined,
    deleteMessage: async (_chatId: number, messageId: number) => {
      deleted.push(messageId);
    },
  };
}

/** A focus view the test drives by hand; the settings page is the only dialog. */
function fakeFocus() {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  return {
    current: () => info,
    entryFor: () => undefined,
    validate: () => undefined,
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      info = { kind: "dialog", component, source: "event" };
      for (const listener of [...listeners]) listener(info);
    },
  };
}

function makeBroker() {
  const transport = fakeTransport();
  const written: string[] = [];
  const focus = fakeFocus();
  const secrets = new SecretStore();
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => [turn(42)],
    writeText: (text: string) => {
      written.push(text);
      return true;
    },
    secrets,
    enabled: () => true,
  });
  broker.start();
  return { broker, transport, written, focus, secrets };
}

/** Flush the fire-and-forget Bot API calls. */
const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

/**
 * OMP's settings page as the TSP adapter sees it: `describe` for the rows,
 * `handleNativeEvent` for the changes, `handleInput` for the page's own search
 * box. A host that accepts a change writes it onto the row's control, so the
 * next `describe` shows it; `adopt: false` is the host that silently drops it.
 * A secret control is never written back, the way a host may keep it out of its
 * own description.
 */
function prefsPage(opts: { adopt?: boolean } = {}) {
  const adopt = opts.adopt !== false;
  const rows: Record<string, unknown>[] = [
    { id: "token", label: "Bot token", control: { k: "text", value: "old-token", secret: true } },
    { id: "width", label: "Width", control: { k: "number", value: 80 } },
  ];
  const props: Record<string, unknown> = {
    title: "Settings",
    pages: [],
    page: "general",
    sections: [{ id: "s", title: "S", rows }],
  };
  const events: unknown[] = [];
  const keys: string[] = [];
  return {
    events,
    keys,
    describe: () => ({ k: "prefs", p: props }),
    handleNativeEvent: (event: unknown) => {
      events.push(event);
      const change = event as { type?: string; item?: string; value?: unknown };
      if (!adopt || change.type !== "change") return;
      const row = rows.find((candidate) => candidate.id === change.item);
      const control = row?.control as Record<string, unknown> | undefined;
      if (!control || control.secret === true) return;
      if (control.k === "number" || control.k === "text" || control.k === "choice") control.value = change.value;
    },
    handleInput: (data: string) => {
      keys.push(data);
    },
  };
}

/** Tap the `…` button that opens the sub-input of row `rowId`. */
async function openSubInput(broker: DialogBroker, rowId: string) {
  const session = broker.current();
  if (!session) throw new Error("no session");
  const generation = session.generation;
  const arg = [...(session.keyMap.get(generation) ?? [])].find(([, key]) => key === rowId)?.[0];
  expect(arg).toBeDefined();
  expect(broker.handleCallback(42, undefined, { sessionId: session.id, generation, op: "m", arg })).toEqual({ handled: true });
  await settle();
  return session;
}

describe("a text field nested in the OMP settings page", () => {
  it("deletes and remembers the message that filled a secret sub-input", async () => {
    const { broker, transport, written, focus, secrets } = makeBroker();
    const page = prefsPage();
    focus.openDialog(page as unknown as Record<string, unknown>);
    await settle();
    expect(broker.current()?.adapter?.id).toBe("tsp-prefs");
    const session = await openSubInput(broker, "token");

    // The chat now waits for the token, and knows it is a secret even though the
    // dialog itself is a settings page.
    expect(session.pendingInput).toMatchObject({ purpose: "input", secret: true });

    expect(broker.handleText(session, "tok3n-xyz-9", 55)).toEqual({ handled: true });
    await settle();

    expect(written).toEqual([]);
    expect(page.events).toEqual([{ type: "change", key: "", item: "token", value: "tok3n-xyz-9" }]);
    expect(transport.deleted).toEqual([55]);
    expect(secrets.redact("42:main", "the token is tok3n-xyz-9")).toBe("the token is ***");
    expect(session.pendingInput).toBeUndefined();
  });

  it("keeps text the host refused out of the terminal and says so", async () => {
    const { broker, transport, written, focus } = makeBroker();
    const page = prefsPage();
    focus.openDialog(page as unknown as Record<string, unknown>);
    await settle();
    const session = await openSubInput(broker, "width");
    expect(session.pendingInput).toMatchObject({ purpose: "input", secret: false });

    expect(broker.handleText(session, "abc", 60)).toEqual({
      handled: true,
      toast: "The host did not accept this input",
    });
    await settle();

    // Nothing was typed at the terminal: with the settings page focused those
    // keystrokes would land in its own search box.
    expect(written).toEqual([]);
    expect(page.keys).toEqual([]);
    expect(page.events).toEqual([]);
    expect(transport.deleted).toEqual([]);
  });

  it("reports a number the host ignored as a refused input and keeps the field open", async () => {
    const { broker, transport, written, focus } = makeBroker();
    const page = prefsPage({ adopt: false });
    focus.openDialog(page as unknown as Record<string, unknown>);
    await settle();
    const session = await openSubInput(broker, "width");

    expect(broker.handleText(session, "42", 61)).toEqual({
      handled: true,
      toast: "The host did not accept this input",
    });
    await settle();

    expect(written).toEqual([]);
    expect(page.events).toEqual([{ type: "change", key: "", item: "width", value: 42 }]);
    // The row still shows 80, so the field stays up for a retry.
    expect(session.model.kind === "settings" ? session.model.submenu?.itemKey : undefined).toBe("width");
  });

  it("takes typed text as the page's search term before the terminal typed anything", async () => {
    const { broker, transport, written, focus } = makeBroker();
    const page = prefsPage();
    focus.openDialog(page as unknown as Record<string, unknown>);
    await settle();
    const session = broker.current();
    if (!session) throw new Error("no session");

    expect(session.model.kind === "settings" ? session.model.search : undefined).toEqual({ query: "" });
    expect(broker.waitsForText(42)).toBe(true);

    expect(broker.handleText(session, "token", 70)).toEqual({ handled: true });
    await settle();

    // The page's own search field gets the word, not the raw terminal stream.
    expect(page.keys).toEqual(["\x15", ..."token"]);
    expect(written).toEqual([]);
    expect(transport.deleted).toEqual([]);
  });
});
