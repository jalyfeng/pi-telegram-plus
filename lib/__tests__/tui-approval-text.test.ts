/**
 * A Telegram message sent while OMP's tool-approval dialog waits (P2-39).
 *
 * The message is handed to the host composer as its own native `send` event
 * (never as keys), the host steers it and denies the call, and the Telegram
 * card closes with "Denied - sent as new instructions". The broker must not
 * fall back to typing the text into the terminal when the composer refuses it.
 */
import { describe, expect, it, vi } from "vitest";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { TelegramTurn } from "../types.ts";

const sendNativeText = vi.hoisted(() => vi.fn((_text: string) => true));

vi.mock("../tui/host.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tui/host.ts")>();
  return {
    ...actual,
    currentHostState: () => ({ host: "omp" }) as ReturnType<typeof actual.currentHostState>,
    sendNativeText,
  };
});

type N = Record<string, unknown>;
const text = (value: string): N => ({ k: "text", p: { text: value } });
const item = (key: string, label: string): N => ({ k: "item", key, p: { label } });
const button = (label: string, act: string): N => ({ k: "row", p: { role: "omp.btn", actions: { click: act } }, c: [text(label)] });

/** The host's approval dialog while the call waits, as its describe() tree. */
function approvalDialog() {
  const events: unknown[] = [];
  const tree: N = {
    k: "col",
    c: [
      { k: "text", key: "title", p: { text: "Allow tool: bash", role: "omp.approval.title" } },
      { k: "col", key: "details", p: { role: "omp.approval.details" }, c: [text("Command: touch denied.txt")] },
      {
        k: "list",
        key: "choices",
        p: { role: "omp.approval.choices" },
        c: [item("once", "Approve"), item("session", "Approve bash for this session"), item("deny", "Deny")],
      },
      { k: "row", key: "bar", c: [button("Details", "expand"), button("Deny", "deny"), button("Approve", "approve")] },
    ],
  };
  const component = {
    describe: () => tree,
    handleNativeEvent: (event: unknown) => {
      events.push(event);
    },
    render: () => ["screen"],
  };
  return { component: component as Record<string, unknown>, events };
}

function fakeTransport() {
  const sent: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  return {
    sent,
    edits,
    sendButtons: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: 100 + sent.length };
    },
    editButtons: async (chatId: number, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
    },
    sendText: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return [{ message_id: 300 + sent.length }];
    },
    removeInlineKeyboard: async () => undefined,
    deleteMessage: async () => undefined,
  };
}

function fakeFocus() {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    current: () => info,
    entryFor: () => undefined,
    validate() {},
    handOverSilently() {},
    onChange: (listener: (next: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      emit({ kind: "dialog", component, source: "event" });
    },
    closeToEditor() {
      emit({ kind: "editor", component: editor, source: "event" });
    },
  };
}

const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

function makeBroker() {
  const transport = fakeTransport();
  const written: string[] = [];
  const focus = fakeFocus();
  const turns: TelegramTurn[] = [{ chatId: 42, sourceMessageId: 7, queuedAttachments: [] }];
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => turns,
    writeText: (value: string) => {
      written.push(value);
      return true;
    },
    enabled: () => true,
  });
  broker.start();
  return { broker, transport, written, focus };
}

describe("a Telegram message while the tool approval waits", () => {
  it("goes to the host composer as a native send, with no keys and no terminal write", async () => {
    sendNativeText.mockClear();
    sendNativeText.mockReturnValue(true);
    const { broker, focus, written } = makeBroker();
    const { component, events } = approvalDialog();
    focus.openDialog(component);
    await settle();
    const session = broker.sessionFor(42);
    expect(session?.adapter?.id).toBe("omp-approval");

    const result = broker.handleText(session!, "use the staging server", 55);
    expect(result).toEqual({ handled: true });
    expect(sendNativeText).toHaveBeenCalledWith("use the staging server");
    expect(written).toEqual([]);
    // The text is not an answer button: the dialog's own choices are not replayed.
    expect(events).toEqual([]);
  });

  it("closes the card as denied and sent as new instructions, the text not repeated", async () => {
    sendNativeText.mockClear();
    sendNativeText.mockReturnValue(true);
    const { broker, transport, focus } = makeBroker();
    const { component } = approvalDialog();
    focus.openDialog(component);
    await settle();
    const session = broker.sessionFor(42)!;
    broker.handleText(session, "use the staging server", 55);
    await settle();
    // The host steers the text and denies the call: the dialog closes.
    focus.closeToEditor();
    await settle();
    const last = transport.edits.at(-1)?.text ?? transport.sent.at(-1)?.text ?? "";
    expect(last).toContain("✖ Denied — sent as new instructions");
    expect(last).not.toContain("use the staging server");
  });

  it("says the host did not take the text when the composer refuses it, and types nothing", async () => {
    sendNativeText.mockClear();
    sendNativeText.mockReturnValue(false);
    const { broker, written, focus } = makeBroker();
    const { component } = approvalDialog();
    focus.openDialog(component);
    await settle();
    const session = broker.sessionFor(42)!;
    expect(broker.handleText(session, "use the staging server", 55)).toEqual({
      handled: true,
      toast: "The host did not accept this input",
    });
    expect(written).toEqual([]);
    // The dialog is still open and unanswered: no summary was claimed for it.
    expect(broker.sessionFor(42)).toBeDefined();
  });
});
