/**
 * Who answered a dialog, and what a Telegram tap says back. A tap whose own act closes the dialog is
 * a normal answer: its callback gets no "Answered in the terminal". A tap that reaches a dialog the
 * terminal has already closed or replaced gets that notice. A Telegram tap stays the cause of the
 * close until the dialog moves on to a different model (the tap was consumed), and the time since
 * the tap does not matter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogBroker, type BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { DialogAdapter, DialogModel, DialogSession } from "../tui/model.ts";
import type { TelegramTurn } from "../types.ts";

type Edit = { kind: string; text?: string };

function fakeFocus() {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  let live: object = editor;
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    current: () => info,
    entryFor: () => undefined,
    validate() {
      if (live === info.component) return;
      emit({ kind: live === editor ? "editor" : "dialog", component: live as Record<string, unknown>, source: "getter" });
    },
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      live = component;
      emit({ kind: "dialog", component, source: "event" });
    },
    closeToEditor() {
      live = editor;
      emit({ kind: "editor", component: editor, source: "event" });
    },
  };
}

/**
 * A command's confirm dialog, opened and drawn with its real model. `act` decides what the host
 * does with each Telegram action: it may close the dialog, change the model, or keep both.
 */
async function open(
  act: (action: { type: string }, ctx: { close(): void; setModel(m: DialogModel): void }) => boolean,
  initial: DialogModel = { kind: "confirm", title: "Log out API key #1?" },
) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const edits: Edit[] = [];
  const transport = {
    sendButtons: async () => ({ message_id: 101 }),
    editButtons: async (_c: number, _m: number, text: string) => { edits.push({ kind: "editButtons", text }); },
    editText: async (_c: number, _m: number, text: string) => { edits.push({ kind: "editText", text }); },
    removeInlineKeyboard: async () => { edits.push({ kind: "removeInlineKeyboard" }); },
    sendText: async () => [{ message_id: 301 }],
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
  const focus = fakeFocus();
  // No command scope: the dialog is drawn on a message of its own, for the chat's turn.
  const turn: TelegramTurn = { chatId: 42, sourceMessageId: 7, queuedAttachments: [] };
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => [turn],
    writeText: () => true,
    enabled: () => true,
  });
  broker.start();

  let model: DialogModel = initial;
  const replace = (next: DialogModel) => { model = next; };
  const adapter: DialogAdapter = {
    id: "scripted",
    detect: () => true,
    read: () => model,
    act: (_component, action) => act(action as { type: string }, { close: () => focus.closeToEditor(), setModel: replace }),
  };
  focus.openDialog({});
  await vi.advanceTimersByTimeAsync(10);
  const session = broker.current() as DialogSession;
  session.adapter = adapter;
  session.model = model;
  // The refresh draws the dialog with its real model, which is what the user is tapping.
  await vi.advanceTimersByTimeAsync(1100);
  const tap = (op: string, arg?: string) => broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op, arg });
  return { broker, focus, edits, session, tap, setModel: replace, last: () => edits.filter((edit) => edit.kind === "editButtons" || edit.kind === "editText").at(-1)?.text ?? "" };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a Telegram tap's own close is a normal answer", () => {
  it("answers the tap without a notice when its act closes the dialog", async () => {
    const ctx = await open((_action, host) => {
      host.close();
      return true;
    });

    expect(ctx.tap("y")).toEqual({ handled: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.last()).toContain("✅");
    expect(ctx.last()).not.toContain("Answered in the terminal");
  });

  it("answers a different tap on the closed dialog with the notice", async () => {
    const ctx = await open((_action, host) => {
      host.close();
      return true;
    });
    ctx.tap("y");

    expect(ctx.tap("n")).toEqual({ handled: true, toast: "Answered in the terminal", clear: true });
  });

  it("answers a tap that finds the dialog closed by the terminal with the notice", async () => {
    const ctx = await open(() => true);
    ctx.focus.closeToEditor();
    await vi.advanceTimersByTimeAsync(10);

    expect(ctx.tap("y")).toEqual({ handled: true, toast: "Answered in the terminal", clear: true });
  });
});

describe("a Telegram tap stays the cause of the close until the dialog says something new", () => {
  it("keeps a pick's close as Telegram's when the act itself leaves the picker's state", async () => {
    const choosing: DialogModel = {
      kind: "select",
      title: "Model",
      subtitle: "Set as default: choose one",
      items: [{ key: "a", label: "mock/mock" }, { key: "b", label: "mock/mock-model-2" }],
      total: 2,
    };
    const list: DialogModel = { kind: "select", title: "Model", items: choosing.items, total: 2 };
    const ctx = await open((_action, host) => {
      // Choosing a row leaves the picker's own state: the subtitle and the buttons go back to the list.
      host.setModel(list);
      return true;
    }, choosing);

    expect(ctx.tap("c", "0.1")).toEqual({ handled: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.session.telegramAction).toBeDefined();
    ctx.focus.closeToEditor();
    await vi.advanceTimersByTimeAsync(1500);

    expect(ctx.last()).toContain("✅");
    expect(ctx.last()).not.toContain("Answered in the terminal");
  });

  it("keeps a pick's close as Telegram's when the act only moves the terminal cursor and redraws", async () => {
    const picker = (focused: number): DialogModel => ({
      kind: "select",
      title: "Pick a model",
      items: [
        { key: "a", label: "mock/mock", focused: focused === 0 },
        { key: "b", label: "mock/mock-fast", focused: focused === 1 },
      ],
      total: 2,
    });
    const ctx = await open((_action, host) => {
      // Setting the default: the host moves the cursor (a redraw), then saves and closes.
      host.setModel(picker(1));
      return true;
    }, picker(0));

    expect(ctx.tap("c", "0.0")).toEqual({ handled: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.session.telegramAction).toBeDefined();
    ctx.focus.closeToEditor();
    await vi.advanceTimersByTimeAsync(1500);

    expect(ctx.last()).toContain("✅");
    expect(ctx.last()).not.toContain("Answered in the terminal");
  });

  it("counts the terminal's close as the terminal's after a draw says something new following the tap", async () => {
    const ctx = await open((action, host) => {
      // Cancel returns to a list: that list is what the tap leaves behind, the baseline it is judged by.
      if (action.type === "cancel") host.setModel({ kind: "confirm", title: "Back to the list?" });
      return true;
    });
    ctx.tap("x");
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.session.telegramAction).toBeDefined();

    // The dialog moves on again on its own, and the next draw shows it.
    ctx.setModel({ kind: "confirm", title: "Another question?" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.session.telegramAction).toBeUndefined();

    ctx.focus.closeToEditor();
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.last()).toContain("Answered in the terminal");
    expect(ctx.last()).not.toContain("✖ Cancelled");
  });

  it("counts a close as Telegram's however long after the tap it comes, while the dialog is unchanged", async () => {
    const ctx = await open((_action, host) => {
      // The host keeps the dialog up for a while after the answer, then closes it.
      setTimeout(() => host.close(), 3000);
      return true;
    });
    ctx.tap("y");
    await vi.advanceTimersByTimeAsync(3500);

    expect(ctx.session.telegramAction).toBeDefined();
    expect(ctx.last()).toContain("✅");
    expect(ctx.last()).not.toContain("Answered in the terminal");
  });
});

/** A runtime with no dialog open: what a replacement runtime is after a session switch. */
function freshRuntime() {
  const focus = fakeFocus();
  const turn: TelegramTurn = { chatId: 42, sourceMessageId: 7, queuedAttachments: [] };
  const broker = new DialogBroker({
    transport: { answerCallbackQuery: async () => undefined, removeInlineKeyboard: async () => undefined } as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => [turn],
    writeText: () => true,
    enabled: () => true,
  });
  broker.start();
  return { broker, focus };
}

describe("a tap whose act tears the runtime down", () => {
  it("answers a tap whose act tears the runtime down while it runs", async () => {
    let ctx!: Awaited<ReturnType<typeof open>>;
    ctx = await open((_action, host) => {
      // The host switches session inside the act: the runtime is disposed before the act returns.
      ctx.broker.stop({ handOver: true });
      host.close();
      return true;
    });

    expect(ctx.tap("y")).toEqual({ handled: true });
  });

  it("still answers a tap on a dialog the terminal closed before any act, with the notice", async () => {
    const ctx = await open(() => true);
    ctx.focus.closeToEditor();
    await vi.advanceTimersByTimeAsync(10);
    const next = freshRuntime();

    expect(next.broker.handleCallback(42, undefined, { sessionId: ctx.session.id, generation: ctx.session.generation, op: "y" }))
      .toEqual({ handled: true, toast: "Answered in the terminal", clear: true });
  });
});
