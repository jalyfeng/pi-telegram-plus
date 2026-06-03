import { describe, expect, it, vi } from "vitest";
import { encodeUiCallback } from "../callback-protocol.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import { parseLeadingCommand, normalizeLeadingCommand } from "../command-parser.ts";
import { createTelegramController } from "../controller.ts";

describe("parseLeadingCommand", () => {
  it("parses simple slash command", () => {
    expect(parseLeadingCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseLeadingCommand("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
  });

  it("parses command with multi-word args", () => {
    expect(parseLeadingCommand("/tg-config tool full")).toEqual({ name: "tg-config", args: "tool full" });
  });

  it("handles @botUsername via normalizeLeadingCommand, not parseLeadingCommand", () => {
    // parseLeadingCommand uses [^\s@]+ so @ is excluded from name
    expect(parseLeadingCommand("/help@mybot")).toBeUndefined();
  });

  it("returns undefined for non-slash text", () => {
    expect(parseLeadingCommand("hello")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseLeadingCommand("")).toBeUndefined();
  });

  it("parses command with underscore name", () => {
    expect(parseLeadingCommand("/review_loop")).toEqual({ name: "review_loop", args: "" });
  });

  it("parses command with hyphen name", () => {
    expect(parseLeadingCommand("/tg-config")).toEqual({ name: "tg-config", args: "" });
  });

  it("parses command with remaining text as args", () => {
    expect(parseLeadingCommand("/new this is a test")).toEqual({ name: "new", args: "this is a test" });
  });
});

describe("normalizeLeadingCommand", () => {
  it("strips @botUsername suffix", () => {
    expect(normalizeLeadingCommand("/help@mybot", "mybot")).toBe("/help");
  });

  it("strips @botUsername with trailing space", () => {
    expect(normalizeLeadingCommand("/help@mybot args", "mybot")).toBe("/help args");
  });

  it("returns text unchanged without botUsername", () => {
    expect(normalizeLeadingCommand("/help@mybot", undefined)).toBe("/help@mybot");
  });

  it("is case-insensitive for bot username", () => {
    expect(normalizeLeadingCommand("/help@MyBot", "mybot")).toBe("/help");
  });

  it("does not strip non-matching username", () => {
    expect(normalizeLeadingCommand("/help@otherbot", "mybot")).toBe("/help@otherbot");
  });
});

describe("createTelegramController media message behavior", () => {
  it("submits prompt for incoming document-only message", async () => {
    const prompts: string[] = [];
    const session = {
      prompt: async (text: string) => {
        prompts.push(text);
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
    } as any;

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      document: {
        file_id: "abc",
        file_name: "photo.png",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[telegram attachment]");
    expect(prompts[0]).toContain("document: photo.png");
  });

  it("appends attachment summary to captioned message", async () => {
    const prompts: string[] = [];
    const session = {
      prompt: async (text: string) => {
        prompts.push(text);
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
    } as any;

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      caption: "Analyze this image",
      photo: [
        { file_id: "photo-id-1", file_size: 100 },
      ],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Analyze this image");
    expect(prompts[0]).toContain("photo (1 photo frame(s))");
  });

  it("downloads and records incoming photo attachment path", async () => {
    const prompts: string[] = [];
    const sent: string[] = [];
    const saved: Array<{ fileId: string; fileName?: string; kind: string }> = [];
    const session = {
      prompt: async (text: string) => {
        prompts.push(text);
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
    } as any;

    const transportSendText = vi.fn(async () => [{ message_id: 1 }]);

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async (_chatId, text) => {
          sent.push(text);
          return transportSendText();
        },
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      saveIncomingTelegramAttachment: async (fileId, fileName, kind) => {
        saved.push({ fileId, fileName, kind });
        return `/tmp/saved/${fileId}.jpg`;
      },
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      photo: [
        { file_id: "photo-small", file_size: 100 },
        { file_id: "photo-large", file_size: 400 },
      ],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("photo (2 photo frame(s))");
    expect(prompts[0]).toContain("photo-large");
    expect(prompts[0]).toContain("/tmp/saved/photo-large.jpg");
    expect(saved).toEqual([{ fileId: "photo-large", kind: "photo", fileName: undefined }]);
    expect(transportSendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain("✅ Saved attachments (local paths):");
    expect(sent[0]).toContain("/tmp/saved/photo-large.jpg");
  });

  it("does not block message handling while waiting for prompt completion", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = {
      prompt: async () => {
        await gate;
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
    } as any;

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 999 },
        text: "Continue the analysis",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(result).toBe(undefined);
    release();
    await gate;
  });

  it("skips queued follow-up prompts after /stop", async () => {
    let firstResolved = false;
    let firstRelease: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      firstRelease = resolve;
    });

    const prompts: string[] = [];
    const session: any = {
      prompt: async (text: string) => {
        prompts.push(text);
        if (text === "A") {
          await firstGate;
          firstResolved = true;
          return;
        }
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
      abort: vi.fn(() => Promise.resolve()),
    };

    const sendText = vi.fn(async () => [{ message_id: 1 }]);
    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText,
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "A",
    });
    await controller.handleMessage({
      message_id: 2,
      chat: { id: 999 },
      text: "B",
    });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 3,
        chat: { id: 999 },
        text: "/stop",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);
    expect(result).toBeUndefined();

    firstRelease();
    await firstGate;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(prompts).toEqual(["A"]);
    expect(firstResolved).toBe(true);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(999, "⏹️ Interrupt requested.");
  });

  it("does not block message handling while a command handler is waiting", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commandStarted: { value: boolean } = { value: false };
    const commandDone: { value: boolean } = { value: false };

    const session = {
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}) as any,
      },
    } as any;

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("new", async () => {
      commandStarted.value = true;
      await gate;
      commandDone.value = true;
    });

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: command,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 999 },
        text: "/new",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(result).toBe(undefined);
    expect(commandStarted.value).toBe(true);
    expect(commandDone.value).toBe(false);

    release();
    await gate;
    expect(commandDone.value).toBe(true);
  });

  it("does not block another command while a previous command waits", async () => {
    let releaseSecond: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const firstStarted: { value: boolean } = { value: false };
    const secondStarted: { value: boolean } = { value: false };

    const session = {
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}) as any,
      },
    } as any;

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("first", async () => {
      firstStarted.value = true;
      await firstGate;
    });
    command.set("second", async () => {
      secondStarted.value = true;
    });

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: command,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "/first",
    });

    const timeoutRace = await Promise.race([
      controller.handleMessage({
        message_id: 2,
        chat: { id: 999 },
        text: "/second",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(timeoutRace).toBe(undefined);
    expect(firstStarted.value).toBe(true);
    expect(secondStarted.value).toBe(true);

    releaseSecond();
    await firstGate;
  });

  it("does not crash when command handler rejects", async () => {
    const session = {
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}) as any,
      },
    } as any;

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("fail", async () => {
      throw new Error("command boom");
    });

    const controller = createTelegramController({
      getSession: () => session,
      transport: {
        removeInlineKeyboard: async () => undefined,
        sendText: async () => [{ message_id: 1 }],
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
      },
      ui: {
        create: () => ({
          notify: async () => undefined,
        }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: async () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: command,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await expect(controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "/fail",
    })).resolves.toBeUndefined();
  });

  it("resolves ui.confirm through callback without blocking", async () => {
    const commandPrompted = { confirmed: false };
    const session = {
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}) as any,
      },
    } as any;

    const sentMessageId = 77;
    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [] as any),
      sendButtons: vi.fn(async () => ({ message_id: sentMessageId } as any)),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };

    const uiRuntime = createTelegramUiRuntime({
      getSession: () => session,
      transport,
    });

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("ask", async () => {
      const ui = uiRuntime.create(321);
      commandPrompted.confirmed = await ui.confirm("Proceed?", "Are you sure?");
      if (commandPrompted.confirmed) {
        await ui.notify("confirmed");
      }
    });

    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: command,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    const handled = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 321 },
        text: "/ask",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);
    expect(handled).toBeUndefined();

    await controller.handleCallbackQuery({
      id: "cb-1",
      message: { chat: { id: 321 }, message_id: sentMessageId },
      data: encodeUiCallback("f:1:yes"),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commandPrompted.confirmed).toBe(true);
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.removeInlineKeyboard).toHaveBeenCalledWith(321, sentMessageId);
  });
});
