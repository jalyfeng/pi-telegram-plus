/**
 * One command, one Telegram message (plan §0.0 #2): the gateway's `▶️ /cmd` ack
 * is the command's only message. A dialog the command opens is drawn on it, its
 * result and the command output are written onto it when the scope ends, and
 * output too long for one message is paged on it, never sent as extra messages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandGateway } from "../tui/gateway.ts";
import { OriginTracker, IDLE_MS } from "../tui/origin.ts";
import { OutputCapture } from "../tui/output.ts";
import { DialogBroker, type BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo, FocusTracker } from "../tui/focus.ts";
import type { EntryInfo } from "../tui/model.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

const checkpointCursor = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../polling.ts", () => ({ checkpointCurrentUpdateCursor: checkpointCursor }));

afterEach(() => {
  vi.useRealTimers();
});

function fakeTelegram() {
  const sent: string[] = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  const buttons: Array<{ messageId: number; text: string }> = [];
  const sentButtons: string[] = [];
  return {
    sent,
    edits,
    buttons,
    sentButtons,
    sendText: vi.fn(async (_chatId: number, text: string) => {
      sent.push(text);
      return [{ message_id: sent.length }];
    }),
    editText: vi.fn(async (_chatId: number, messageId: number, text: string) => {
      edits.push({ messageId, text });
    }),
    sendButtons: vi.fn(async (_chatId: number, text: string) => {
      sentButtons.push(text);
      return { message_id: 900 + sentButtons.length };
    }),
    editButtons: vi.fn(async (_chatId: number, messageId: number, text: string) => {
      buttons.push({ messageId, text });
    }),
    sendDocument: vi.fn(async () => undefined),
    removeInlineKeyboard: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
}

/** A focus view the test drives by hand: what the broker and the origin read. */
function fakeFocus(entry?: EntryInfo) {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    start: () => undefined,
    stop: () => undefined,
    current: () => info,
    isEditor: () => info.kind === "editor",
    entryFor: () => entry,
    validate: () => undefined,
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog: (component: Record<string, unknown>) => emit({ kind: "dialog", component, source: "event" }),
    closeToEditor: () => emit({ kind: "editor", component: editor, source: "event" }),
  };
}

/** A three-row selector that hands the focus back to the editor on Enter. */
function selector(focus: { closeToEditor: () => void }) {
  const keys: string[] = [];
  const component: Record<string, unknown> = {
    options: ["alpha", "beta"],
    selectedIndex: 0,
    handleInput: (input: string) => {
      keys.push(input);
      if (input === "\r") focus.closeToEditor();
    },
  };
  return { component, keys };
}

const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

function fakeBridge(): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [],
    submit: () => true,
    submitResult: () => ({ ok: true, result: Promise.resolve() }),
    readEditorText: () => "",
    writeEditorText: () => true,
    key: () => true,
    write: () => true,
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
  };
}

function setup(entry?: EntryInfo) {
  const telegram = fakeTelegram();
  const focus = fakeFocus(entry);
  const origin = new OriginTracker({
    isEditorFocused: () => focus.isEditor(),
    readDraft: () => "",
    writeDraft: () => true,
  });
  const output = new OutputCapture(telegram, origin);
  const broker = new DialogBroker({
    transport: telegram as unknown as BrokerDeps["transport"],
    focus: focus as unknown as BrokerDeps["focus"],
    origin,
    activeChatId: () => 7,
    activeTurns: () => [],
    writeText: () => true,
    enabled: () => true,
  });
  broker.start();
  output.attachPager((target, title, html) => broker.showPaged(target, title, html));
  const gateway = new CommandGateway({
    bridge: fakeBridge(),
    origin,
    output,
    focus: focus as unknown as FocusTracker,
    isEnabled: () => true,
    hostName: () => "pi",
    hostState: () => ({ host: "pi", mode: {}, editor: {} }),
    readDraft: () => "",
  });
  gateway.start();
  const run = (name: string) => gateway.run({ name, args: "", origin: { chatId: 7 }, transport: telegram });
  return { telegram, focus, origin, output, broker, gateway, run };
}

const ENTRY: EntryInfo = {
  kind: "select",
  title: "Pick model",
  options: ["alpha", "beta"],
  source: "pi",
  method: "select",
};

describe("one command, one message", () => {
  it("pages output too long for one message on the ack, sending nothing else", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run("changelog");
    const output = t.output as unknown as { push(html: string): void };
    output.push("x".repeat(20_000));
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1500);

    expect(t.telegram.sent).toHaveLength(1);
    expect(t.telegram.sentButtons).toHaveLength(0);
    expect(t.telegram.edits).toHaveLength(0);
    expect(t.telegram.buttons.at(-1)?.messageId).toBe(1);
    expect(t.telegram.buttons.at(-1)?.text).toContain("Page 1/");

    const session = t.broker.current();
    t.broker.handleCallback(7, undefined, { sessionId: session?.id ?? "", generation: 0, op: "p", arg: "1" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.telegram.buttons.at(-1)?.text).toContain("Page 2/");
    expect(t.telegram.sent).toHaveLength(1);
    t.gateway.dispose();
  });

  it("ends a command with no output and no dialog as the ack with ✓ Done", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run("session");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1500);

    expect(t.telegram.sent).toHaveLength(1);
    expect(t.telegram.edits.at(-1)).toEqual({ messageId: 1, text: "<b>▶️ /session</b>\n\n<i>✓ Done</i>" });
    t.gateway.dispose();
  });

  it("draws a dialog on the ack message and ends with its summary, not ✓ Done", async () => {
    vi.useFakeTimers();
    const t = setup(ENTRY);
    await t.run("model");
    const { component } = selector(t.focus);
    t.focus.openDialog(component);
    await settle();

    expect(t.telegram.sentButtons).toHaveLength(0);
    expect(t.telegram.buttons.at(-1)?.messageId).toBe(1);
    const session = t.broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "0:alpha")?.[0];
    expect(arg).toBeDefined();
    t.broker.handleCallback(7, undefined, { sessionId: session?.id ?? "", generation: 0, op: "c", arg });
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1500);

    expect(t.telegram.sent).toHaveLength(1);
    const final = t.telegram.edits.at(-1);
    expect(final?.messageId).toBe(1);
    expect(final?.text).toContain("▶️ /model");
    expect(final?.text).toContain("✅");
    expect(final?.text).not.toContain("✓ Done");
    t.gateway.dispose();
  });

  it("reuses the same message for two dialogs in one scope", async () => {
    vi.useFakeTimers();
    const t = setup(ENTRY);
    await t.run("login");
    for (let round = 0; round < 2; round += 1) {
      const { component } = selector(t.focus);
      t.focus.openDialog(component);
      await settle();
      const session = t.broker.current();
      const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "0:alpha")?.[0];
      t.broker.handleCallback(7, undefined, { sessionId: session?.id ?? "", generation: 0, op: "c", arg });
      await settle();
    }
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1500);

    expect(t.telegram.sentButtons).toHaveLength(0);
    expect(t.telegram.sent).toHaveLength(1);
    expect(t.telegram.buttons.every((edit) => edit.messageId === 1)).toBe(true);
    const final = t.telegram.edits.at(-1)?.text ?? "";
    expect(final.split("✅").length - 1).toBe(2);
    t.gateway.dispose();
  });
});
