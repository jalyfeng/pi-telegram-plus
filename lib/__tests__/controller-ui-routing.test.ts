import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import type { TelegramTransport } from "../types.ts";

function createTransport(sent: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }>): TelegramTransport {
  return {
    removeInlineKeyboard: vi.fn(async () => undefined),
    sendText: vi.fn(async (chatId, text, messageThreadId, replyToMessageId) => {
      sent.push({ chatId, text, messageThreadId, replyToMessageId });
      return [{ message_id: sent.length }];
    }),
    sendButtons: vi.fn(async () => ({ message_id: 1 })),
    editText: vi.fn(async () => undefined),
    editButtons: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => undefined),
    sendPhoto: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => undefined),
  };
}

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Telegram controller UI routing", () => {
  it("keeps overlapping Telegram command UIs isolated by chat", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = { notify: async (message: string) => { tuiNotifications.push(message); } };
    let currentUi: any = tuiUi;
    let activeMode = "tui";
    const commandCtx: any = {
      isIdle: () => false,
      waitForIdle: async () => undefined,
    };
    Object.defineProperty(commandCtx, "ui", { get: () => currentUi });
    Object.defineProperty(commandCtx, "mode", { get: () => activeMode });
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
        getCommand: () => undefined,
        createCommandContext: () => commandCtx,
      },
    } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const a = defer();
    const b = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["a", async (_args, ctx) => {
        await ctx.ui.notify("A start");
        await a.promise;
        await ctx.ui.notify("A end");
      }],
      ["b", async (_args, ctx) => {
        await ctx.ui.notify("B start");
        await b.promise;
        await ctx.ui.notify("B end");
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 111 }, from: { id: 1 }, text: "/a" });
    await controller.handleMessage({ message_id: 2, chat: { id: 222 }, from: { id: 1 }, text: "/b" });
    await new Promise((r) => setTimeout(r, 0));
    a.resolve();
    await new Promise((r) => setTimeout(r, 0));
    b.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("A start") }),
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("A end") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("B start") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("B end") }),
    ]));
    expect(sent.find((item) => item.chatId === 111 && item.text.includes("B "))).toBeUndefined();
    expect(sent.find((item) => item.chatId === 222 && item.text.includes("A "))).toBeUndefined();
    expect(tuiNotifications).toEqual([]);
    expect(currentUi).toBe(tuiUi);
    expect(activeMode).toBe("tui");
  });

  it("keeps overlapping Telegram command UIs isolated by thread inside the same chat", async () => {
    const sent: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }> = [];
    const transport = createTransport(sent);
    const tuiUi = { notify: async () => undefined };
    let currentUi: any = tuiUi;
    const commandCtx: any = { isIdle: () => false, waitForIdle: async () => undefined };
    Object.defineProperty(commandCtx, "ui", { get: () => currentUi });
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown) => { currentUi = ui; },
        getCommand: () => undefined,
        createCommandContext: () => commandCtx,
      },
    } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const a = defer();
    const b = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["a", async (_args, ctx) => {
        await ctx.ui.notify("A topic start");
        await a.promise;
        // This runs while B is still on top of the global routed UI stack; it
        // must still route through A's earlier proxy to topic 10, not B/topic 20.
        await ctx.ui.notify("A topic after B stacked");
      }],
      ["b", async (_args, ctx) => { await ctx.ui.notify("B topic"); await b.promise; }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => ({ chatId, messageThreadId, sourceMessageId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 101, message_thread_id: 10, chat: { id: 111 }, from: { id: 1 }, text: "/a" });
    await controller.handleMessage({ message_id: 201, message_thread_id: 20, chat: { id: 111 }, from: { id: 1 }, text: "/b" });
    await new Promise((r) => setTimeout(r, 0));
    a.resolve();
    await new Promise((r) => setTimeout(r, 0));
    b.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 101, text: expect.stringContaining("A topic start") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 101, text: expect.stringContaining("A topic after B stacked") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20, replyToMessageId: 201, text: expect.stringContaining("B topic") }),
    ]));
    expect(sent.find((item) => item.messageThreadId === 10 && item.text.includes("B topic"))).toBeUndefined();
    expect(sent.find((item) => item.messageThreadId === 20 && item.text.includes("A topic"))).toBeUndefined();
  });

  it("routes local TUI calls to the original TUI while a Telegram command hold is in its grace window", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = { notify: async (message: string) => { tuiNotifications.push(message); } };
    let currentUi: any = tuiUi;
    let activeMode = "tui";
    let idle = true;
    const wait = defer();
    const commandCtx: any = {
      isIdle: () => idle,
      waitForIdle: () => wait.promise,
    };
    Object.defineProperty(commandCtx, "ui", { get: () => currentUi });
    Object.defineProperty(commandCtx, "mode", { get: () => activeMode });
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
        getCommand: () => undefined,
        createCommandContext: () => commandCtx,
      },
    } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["enqueue", async (_args, ctx) => {
        await ctx.ui.notify("telegram command started");
        idle = false;
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 555 }, from: { id: 1 }, text: "/enqueue" });
    await new Promise((r) => setTimeout(r, 10));
    expect(currentUi).not.toBe(tuiUi);

    idle = true;
    wait.resolve();
    await new Promise((r) => setTimeout(r, 10));
    await currentUi.notify("local task notification");

    expect(tuiNotifications).toEqual(["local task notification"]);
    expect(sent.find((item) => item.text.includes("local task notification"))).toBeUndefined();

    await new Promise((r) => setTimeout(r, 180));
    expect(currentUi).toBe(tuiUi);
    expect(activeMode).toBe("tui");
  });
});
