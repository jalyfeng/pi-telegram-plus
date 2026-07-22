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

  it("includes replied-to Telegram message text in the agent prompt", async () => {
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
        create: () => ({ notify: async () => undefined }) as any,
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
      message_id: 2,
      chat: { id: 999 },
      from: { id: 100, username: "alice" },
      text: "What do you think?",
      reply_to_message: {
        message_id: 1,
        from: { id: 200, username: "bob" },
        text: "Original Telegram message",
      },
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("[telegram quoted message]");
    expect(prompts[0]).toContain("message_id: 1");
    expect(prompts[0]).toContain("from: @bob id:200");
    expect(prompts[0]).toContain("Original Telegram message");
    expect(prompts[0]).toContain("[telegram message]\nWhat do you think?");
  });

  it("includes Telegram selected quote text even without reply_to_message", async () => {
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
        create: () => ({ notify: async () => undefined }) as any,
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
      message_id: 2,
      chat: { id: 999 },
      text: "Explain the selected quote",
      quote: { text: "Selected quoted Telegram text", position: 5, is_manual: true },
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("[telegram quoted text]");
    expect(prompts[0]).toContain("Selected quoted Telegram text");
    expect(prompts[0]).toContain("position: 5");
    expect(prompts[0]).toContain("manual: true");
    expect(prompts[0]).toContain("[telegram message]\nExplain the selected quote");
  });

  it("includes replied-to Telegram message id even when Telegram omits quoted content", async () => {
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
        create: () => ({ notify: async () => undefined }) as any,
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
      message_id: 2,
      chat: { id: 999 },
      text: "Can you see what I replied to?",
      reply_to_message: { message_id: 1 },
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("[telegram quoted message]");
    expect(prompts[0]).toContain("message_id: 1");
    expect(prompts[0]).toContain("content: unavailable from Telegram update");
    expect(prompts[0]).toContain("[telegram message]\nCan you see what I replied to?");
  });

  it("includes replied-to Telegram attachment summaries without downloading them", async () => {
    const prompts: string[] = [];
    const saved: string[] = [];
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
        create: () => ({ notify: async () => undefined }) as any,
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
      saveIncomingTelegramAttachment: async (fileId) => {
        saved.push(fileId);
        return `/tmp/${fileId}`;
      },
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({
      message_id: 2,
      chat: { id: 999 },
      text: "Describe the quoted image",
      reply_to_message: {
        message_id: 1,
        caption: "Quoted image caption",
        photo: [{ file_id: "quoted-photo", file_size: 123 }],
      },
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("[telegram quoted message]");
    expect(prompts[0]).toContain("caption:\nQuoted image caption");
    expect(prompts[0]).toContain("[telegram quoted attachment]");
    expect(prompts[0]).toContain("photo (1 photo frame(s))");
    expect(saved).toEqual([]);
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

  it.each([
    ["steer", "steer"],
    ["queue", "followUp"],
  ] as const)("delivers goal-running messages in %s mode with %s behavior", async (mode, expectedBehavior) => {
    const prompt = vi.fn(async (_text: string, options?: { streamingBehavior?: string }) => {
      if (!options?.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
    });
    const session = {
      prompt,
      isStreaming: true,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({ waitForIdle: async () => undefined }) as any,
      },
    } as any;
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
        create: () => ({ notify: async () => undefined }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => mode,
      telegramCommands: new Map(),
      // Goal turns are started by pi-goal, so they are streaming without an
      // entry in this extension's TelegramTurn bookkeeping map.
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "Use my new instructions" });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(prompt).toHaveBeenCalledWith("Use my new instructions", {
      source: "interactive",
      streamingBehavior: expectedBehavior,
    });
    expect(sendText).not.toHaveBeenCalledWith(999, expect.stringContaining("could not be delivered"));
  });

  it("survives a goal continuation starting while input hooks are being dispatched", async () => {
    let streamingReads = 0;
    let session: any;
    const prompt = vi.fn(async (_text: string, options?: { streamingBehavior?: string }) => {
      // Mirrors AgentSession.prompt(): isStreaming is checked again only after
      // async input hooks have had a chance to let pi-goal start a continuation.
      const streamingNow = session.isStreaming;
      if (streamingNow && !options?.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
    });
    session = {
      prompt,
      get isStreaming() { return streamingReads++ > 0; },
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({ waitForIdle: async () => undefined }) as any,
      },
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
        create: () => ({ notify: async () => undefined }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "steer",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "Pause and inspect this" });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(prompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "steer" });
    expect(sendText).not.toHaveBeenCalledWith(999, expect.stringContaining("could not be delivered"));
  });

  it("reports asynchronous prompt failures back to Telegram", async () => {
    const session = {
      prompt: vi.fn(async () => { throw new Error("prompt failed"); }),
      isStreaming: true,
      extensionRunner: {
        getUIContext: () => undefined,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({} as any),
      },
    } as any;
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
        create: () => ({ notify: async () => undefined }) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "steer",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "Do not lose this" });
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith(
      999,
      "⚠️ Your message could not be delivered to π. Please retry.",
      undefined,
      1,
    ));
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
    expect(sendText).toHaveBeenCalledWith(999, "⏹️ Interrupt requested.", undefined, 3);
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

  it("does not crash and notifies Telegram when command handler rejects", async () => {
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

    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [{ message_id: 1 }]),
      sendButtons: vi.fn(async () => ({ message_id: 1 })),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };

    const controller = createTelegramController({
      getSession: () => session,
      transport,
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

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.sendText).toHaveBeenCalledWith(999, expect.stringContaining("Command failed"), undefined, 1);
    expect(transport.sendText).toHaveBeenCalledWith(999, expect.stringContaining("command boom"), undefined, 1);
  });

  it("sets Telegram command UI context to rpc mode and restores the previous mode", async () => {
    let activeMode = "tui";
    const previousUi = { kind: "tui" };
    const setCalls: Array<{ ui: unknown; mode: unknown }> = [];
    const commandCtx = Object.defineProperty({}, "mode", {
      get: () => activeMode,
    });
    let observedMode: string | undefined;
    const session = {
      extensionRunner: {
        getUIContext: () => previousUi,
        setUIContext: (ui: unknown, mode?: string) => {
          setCalls.push({ ui, mode });
          if (mode) activeMode = mode;
        },
        createContext: () => ({ mode: activeMode }),
        getCommand: () => undefined,
        createCommandContext: () => commandCtx as any,
      },
    } as any;

    const command = new Map<string, (args: string, ctx: any) => Promise<void>>();
    command.set("mode", async (_args, ctx) => {
      observedMode = ctx.mode;
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
        create: () => ({ notify: async () => undefined }) as any,
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
      text: "/mode",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observedMode).toBe("rpc");
    expect(setCalls[0]?.mode).toBe("rpc");
    expect(setCalls.at(-1)).toEqual({ ui: previousUi, mode: "tui" });
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

  it("holds the Telegram UI swap across a command's enqueued turn until the agent is idle", async () => {
    // Simulates /sisyphus-style commands that return immediately while enqueuing
    // an agent turn via pi.sendUserMessage. The UI swap must be held until that
    // turn finishes (waitForIdle) so dialogs raised during it bridge to Telegram.
    const setCalls: unknown[] = [];
    let idle = true;
    let resolveWait: () => void = () => {};
    const waitPromise = () => new Promise<void>((r) => { resolveWait = r; });
    const tuiUi = { _marker: "tui" };
    const session = {
      extensionRunner: {
        getUIContext: () => tuiUi,
        setUIContext: (u: unknown) => { setCalls.push(u); },
        getCommand: () => undefined,
        createCommandContext: () => ({ isIdle: () => idle, waitForIdle: () => waitPromise() }) as any,
      },
    } as any;

    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [] as any),
      sendButtons: vi.fn(async () => ({ message_id: 1 }) as any),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });

    let handlerRan = false;
    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("enqueue", async () => {
      handlerRan = true;
      // The command returns immediately, but the enqueued turn keeps the agent busy.
      idle = false;
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
      beginTelegramTurn: () => ({ chatId: 555, queuedAttachments: [], replaceMessageId: undefined }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 555 }, text: "/enqueue" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handlerRan).toBe(true);

    // The swap to the Telegram UI happened; the TUI UI has NOT been restored yet
    // because the enqueued turn is still "running" (waitForIdle pending).
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    expect(setCalls[0]).not.toBe(tuiUi);
    const restoresBefore = setCalls.filter((u) => u === tuiUi).length;
    expect(restoresBefore).toBe(0);

    // The enqueued turn finishes: agent goes idle, waitForIdle resolves.
    idle = true;
    resolveWait();
    // 120ms grace window used by the hold loop.
    await new Promise((r) => setTimeout(r, 180));

    // Now the TUI UI has been restored.
    expect(setCalls.filter((u) => u === tuiUi).length).toBe(1);
  });

  it("does not hold the swap when a local turn was already streaming (not idle)", async () => {
    const setCalls: unknown[] = [];
    const tuiUi = { _marker: "tui" };
    let handlerRan = false;
    const session = {
      extensionRunner: {
        getUIContext: () => tuiUi,
        setUIContext: (u: unknown) => { setCalls.push(u); },
        getCommand: () => undefined,
        createCommandContext: () => ({ isIdle: () => false, waitForIdle: () => Promise.resolve() }) as any,
      },
    } as any;
    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [] as any),
      sendButtons: vi.fn(async () => ({ message_id: 1 }) as any),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("busy", async () => { handlerRan = true; });
    const controller = createTelegramController({
      getSession: () => session, transport, ui: uiRuntime,
      authorizeUser: async () => true, setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot", getMessageMode: () => "queue",
      telegramCommands: command, getActiveTurn: () => undefined,
      beginTelegramTurn: () => ({ chatId: 1, queuedAttachments: [], replaceMessageId: undefined }),
      endTelegramTurn: () => undefined,
    });
    await controller.handleMessage({ message_id: 1, chat: { id: 1 }, text: "/busy" });
    await new Promise((r) => setTimeout(r, 20));
    expect(handlerRan).toBe(true);
    // Agent was not idle at command start → swap restored immediately after handler.
    expect(setCalls.filter((u) => u === tuiUi).length).toBe(1);
  });
});

describe("createTelegramController — callback keyboard cleanup ownership", () => {
  // The controller must NOT speculatively strip inline keyboards for handled UI
  // callbacks. Keyboard cleanup is owned by each UI flow (it calls
  // removeInlineKeyboard on its own prompt message right before resolving a
  // terminal value). Controller-side stripping races with continuation flows
  // (multi-question tab nav, single-question option toggle, select pagination)
  // that edit the SAME message in place — when the strip lands last the message
  // is left with no buttons (the answered Q1 but Q2 never appeared bug).
  function makeController(resolveInput: () => { handled: boolean; promptMessageId?: number }) {
    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [] as any),
      sendButtons: vi.fn(async () => ({ message_id: 1 }) as any),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    } as any;
    const ui = { resolveInput } as any;
    const controller = createTelegramController({
      getSession: () => ({ extensionRunner: {} }) as any,
      transport, ui,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      getMessageMode: () => "queue",
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: () => ({ chatId: 1, queuedAttachments: [], replaceMessageId: undefined }),
      endTelegramTurn: () => undefined,
    });
    return { controller, transport };
  }

  it("handled continuation callback (tab nav) does NOT strip the keyboard", async () => {
    const { controller, transport } = makeController(() => ({ handled: true, promptMessageId: 55 }));
    await controller.handleCallbackQuery({
      id: "cb",
      message: { chat: { id: 1 }, message_id: 55 },
      data: encodeUiCallback("f:1:t:1"),
    } as any);
    expect(transport.answerCallbackQuery).toHaveBeenCalledTimes(1);
    // The flow owns cleanup; the controller must not race it.
    expect(transport.removeInlineKeyboard).not.toHaveBeenCalled();
    expect(transport.sendText).not.toHaveBeenCalled();
  });

  it("stale/unhandled callback sends the no-longer-active notice (no strip)", async () => {
    const { controller, transport } = makeController(() => ({ handled: false }));
    await controller.handleCallbackQuery({
      id: "cb",
      message: { chat: { id: 1 }, message_id: 55 },
      data: encodeUiCallback("f:1:o:0"),
    } as any);
    expect(transport.sendText).toHaveBeenCalledWith(1, "This prompt is no longer active.", undefined, 55);
    expect(transport.removeInlineKeyboard).not.toHaveBeenCalled();
  });
});
