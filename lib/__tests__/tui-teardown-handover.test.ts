/**
 * A runtime torn down by a session switch (P2-21) must still write the command's message as its
 * final content. The old runtime's transport drops every send once its send lease is gone, and
 * disposeRuntime clears that lease before the output is finished. So the final content is handed
 * to the replacement runtime through the pending-notice queue, and the Telegram tap that closed
 * the dialog is still attributed to Telegram.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActiveTelegramTransport } from "../active-transport.ts";
import { runInCommand } from "../tui/command-context.ts";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import { OutputCapture } from "../tui/output.ts";
import { OriginTracker, type CommandScope } from "../tui/origin.ts";
import type { DialogAdapter, DialogModel, DialogSession } from "../tui/model.ts";
import { SecretStore } from "../tui/secrets.ts";
import { deliverPendingNotices, takePendingNotices } from "../pending-notices.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

const HEADER = "<b>▶️ /logout</b>";

type Sent = { kind: string; text?: string };

/** The old runtime's transport, gated the way index.ts gates it: sends need the send lease. */
function gatedTransport(state: { active: boolean }, sent: Sent[]) {
  const base = {
    editText: async (_chatId: number, _messageId: number, text: string) => { sent.push({ kind: "editText", text }); },
    editButtons: async (_chatId: number, _messageId: number, text: string) => { sent.push({ kind: "editButtons", text }); },
    removeInlineKeyboard: async () => { sent.push({ kind: "removeInlineKeyboard" }); },
    sendText: async () => [{ message_id: 301 }],
    sendButtons: async () => ({ message_id: 101 }),
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
  return createActiveTelegramTransport(base as unknown as TelegramTransport, {
    isActive: () => state.active,
    getLease: () => (state.active ? "lease" : undefined),
  });
}

/** A focus view the test drives by hand: only the members the broker reads. */
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

const flush = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

/**
 * A command that opened a confirm dialog through the broker and is now answered from Telegram.
 * `closeOnAct` decides whether the host closes the dialog while the tap is handled (a selector
 * that leaves at once) or only later (a host that keeps the dialog up until the switch).
 */
async function fixture(closeOnAct: boolean) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const sent: Sent[] = [];
  const state = { active: true };
  const transport = gatedTransport(state, sent);
  const focus = fakeFocus();
  const origin = new OriginTracker({
    isEditorFocused: () => focus.current().kind === "editor",
    readDraft: () => "",
    writeDraft: () => true,
  });
  const output = new OutputCapture(transport, origin, new SecretStore());
  const scope = origin.begin({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 }, "logout", "/logout", "");
  scope.telegramMessageId = 5;
  output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: HEADER });
  const chat = { children: [] as unknown[], addChild(child: unknown): void { this.children.push(child); } };
  (output as unknown as { attach(state: unknown): void }).attach({ mode: undefined, ui: {}, chat, session: undefined });

  const broker = new DialogBroker({
    transport,
    focus,
    origin,
    activeChatId: () => 42,
    activeTurns: () => [],
    writeText: () => true,
    enabled: () => true,
    settleScope: (settled: CommandScope) => output.settleAfterDialog(settled),
  } as unknown as BrokerDeps);
  broker.start();

  const model: DialogModel = { kind: "confirm", title: "Log out API key #1?" };
  const adapter: DialogAdapter = {
    id: "scripted",
    detect: () => true,
    read: () => model,
    act: () => {
      if (closeOnAct) focus.closeToEditor();
      return true;
    },
  };
  runInCommand(scope, () => focus.openDialog({}));
  await flush();
  const session = broker.current() as DialogSession;
  session.adapter = adapter;
  session.model = model;
  // The refresh redraws the dialog with its real model, as the host would have shown it.
  await vi.advanceTimersByTimeAsync(1100);
  broker.handleCallback(42, 7, { sessionId: session.id, generation: session.generation, op: "y" });
  await flush();
  return { broker, output, origin, scope, sent, state, chat };
}

/**
 * The order disposeRuntime and controller.dispose({ handOver: true }) use: the send lease is
 * cleared first, then the output hands over, the broker stops, and the gateway stops the output
 * and ends the scope.
 */
function teardown(ctx: Awaited<ReturnType<typeof fixture>>): void {
  ctx.state.active = false;
  ctx.output.handOver();
  ctx.broker.stop({ handOver: true });
  ctx.output.stop();
  ctx.origin.dispose();
}

afterEach(() => {
  vi.useRealTimers();
  takePendingNotices(Date.now() + 10 * 60 * 1000);
});

describe("runtime teardown after a Telegram answer", () => {
  it("hands the finished message to the replacement runtime when the dialog closed before teardown", async () => {
    takePendingNotices(Date.now() + 10 * 60 * 1000);
    const ctx = await fixture(true);
    teardown(ctx);

    const notices = takePendingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ chatId: 42, messageThreadId: 7, editMessageId: 5 });
    expect(notices[0].html).toContain(HEADER);
    expect(notices[0].html).toMatch(/✅ \S/);
    expect(notices[0].html).not.toContain("Answered in the terminal");
  });

  it("writes the summary of a Telegram answer whose dialog is still open at teardown, past the 1.5 s window", async () => {
    const ctx = await fixture(false);
    await vi.advanceTimersByTimeAsync(3000);
    teardown(ctx);

    const notices = takePendingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].html).toMatch(/✅ \S/);
    expect(notices[0].html).not.toContain("Answered in the terminal");
  });

  it("the replacement runtime delivers the handed-over message with its own transport", async () => {
    takePendingNotices(Date.now() + 10 * 60 * 1000);
    const ctx = await fixture(true);
    teardown(ctx);

    const next: Sent[] = [];
    deliverPendingNotices(gatedTransport({ active: true }, next));
    await flush();
    expect(next).toEqual([expect.objectContaining({ kind: "editText" })]);
    expect(next[0].text).toMatch(/^<b>▶️ \/logout<\/b>[\s\S]*✅ \S/);
  });
});

/**
 * A dialog drawn on its own message, with no command scope behind it (a host-opened dialog). Its
 * keyboard has to be dropped by the replacement runtime too, not left as a dead menu.
 */
async function standaloneDialog(closeOnAct: boolean) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const sent: Sent[] = [];
  const state = { active: true };
  const transport = gatedTransport(state, sent);
  const focus = fakeFocus();
  const turn: TelegramTurn = { chatId: 42, sourceMessageId: 7, queuedAttachments: [] };
  const broker = new DialogBroker({
    transport,
    focus,
    origin: { active: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => [turn],
    writeText: () => true,
    enabled: () => true,
  } as unknown as BrokerDeps);
  broker.start();

  const model: DialogModel = { kind: "confirm", title: "Log out API key #1?" };
  const adapter: DialogAdapter = {
    id: "scripted",
    detect: () => true,
    read: () => model,
    act: () => {
      if (closeOnAct) focus.closeToEditor();
      return true;
    },
  };
  focus.openDialog({});
  await vi.advanceTimersByTimeAsync(10);
  const session = broker.current() as DialogSession;
  session.adapter = adapter;
  session.model = model;
  await vi.advanceTimersByTimeAsync(1100);
  return { broker, session, sent, state };
}

describe("runtime teardown of a dialog without a command scope", () => {
  it("hands the Telegram answer over as the message's text, without the keyboard", async () => {
    takePendingNotices(Date.now() + 10 * 60 * 1000);
    // The host has not closed the dialog yet when the runtime goes away.
    const ctx = await standaloneDialog(false);
    ctx.broker.handleCallback(42, undefined, { sessionId: ctx.session.id, generation: ctx.session.generation, op: "y" });
    await vi.advanceTimersByTimeAsync(1500);
    ctx.sent.length = 0;

    ctx.state.active = false;
    ctx.broker.stop({ handOver: true });

    const notices = takePendingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ chatId: 42, editMessageId: 101 });
    expect(notices[0].html).toMatch(/✅ \S/);
    expect(ctx.sent).toEqual([]);
  });

  it("hands an unanswered dialog over as its text without the keyboard", async () => {
    takePendingNotices(Date.now() + 10 * 60 * 1000);
    const ctx = await standaloneDialog(false);
    ctx.sent.length = 0;

    ctx.state.active = false;
    ctx.broker.stop({ handOver: true });

    const notices = takePendingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ chatId: 42, editMessageId: 101 });
    expect(notices[0].html).toContain("Log out API key #1?");
    expect(ctx.sent).toEqual([]);
  });
});

describe("runtime teardown with a paged final body", () => {
  it("hands the full body to the replacement runtime, which shows it with its own pager", async () => {
    takePendingNotices(Date.now() + 10 * 60 * 1000);
    const ctx = await fixture(true);
    const body = Array.from({ length: 300 }, (_, index) => `line ${index} of a long command output`).join("\n\n");
    runInCommand(ctx.scope, () => ctx.chat.addChild({ children: [{ markdown: body }] }));
    teardown(ctx);

    // The replacement runtime's reconcile delivers the queue: the body goes to its pager, not as text.
    const pager = vi.fn();
    const next: Sent[] = [];
    deliverPendingNotices(gatedTransport({ active: true }, next), pager);
    expect(pager).toHaveBeenCalledTimes(1);
    const [target, title, html] = pager.mock.calls[0] as [unknown, string, string];
    expect(target).toEqual({ chatId: 42, messageThreadId: 7, messageId: 5 });
    expect(title).toBe("▶️ /logout");
    expect(html).toContain("line 299 of a long command output");
    expect(html.length).toBeGreaterThan(3400);
    expect(next).toEqual([]);
  });
});
