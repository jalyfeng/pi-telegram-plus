import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Telegram controller thread routing", () => {
  it("allows same-chat prompts in different topics to own separate turns", async () => {
    const gates = new Map<string, ReturnType<typeof defer>>([
      ["topic A", defer()],
      ["topic B", defer()],
    ]);
    const prompts: string[] = [];
    const activeTurns = new Map<string, TelegramTurn>();
    const turnKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
    const sendText = vi.fn(async () => [{ message_id: 1 }]);
    const session = {
      prompt: async (text: string) => {
        prompts.push(text);
        await gates.get(text)!.promise;
      },
      isStreaming: false,
      extensionRunner: {
        getUIContext: () => ({ notify: async () => undefined }),
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}) as any,
      },
    } as any;
    const transport: TelegramTransport = {
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
    };

    const controller = createTelegramController({
      getSession: () => session,
      transport,
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
      getActiveTurn: (chatId, messageThreadId) => activeTurns.get(turnKey(chatId, messageThreadId)),
      beginTelegramTurn: (chatId, replaceMessageId, messageThreadId, sourceMessageId) => {
        const key = turnKey(chatId, messageThreadId);
        if (activeTurns.has(key)) return undefined;
        const turn: TelegramTurn = { chatId, messageThreadId, sourceMessageId, replaceMessageId, queuedAttachments: [] };
        activeTurns.set(key, turn);
        return turn;
      },
      endTelegramTurn: (_chatId, turn) => {
        const key = turnKey(turn.chatId, turn.messageThreadId);
        if (activeTurns.get(key) === turn) activeTurns.delete(key);
      },
    });

    await controller.handleMessage({ message_id: 101, message_thread_id: 10, chat: { id: 111 }, from: { id: 1 }, text: "topic A" });
    await controller.handleMessage({ message_id: 201, message_thread_id: 20, chat: { id: 111 }, from: { id: 1 }, text: "topic B" });

    await vi.waitFor(() => expect(prompts).toEqual(["topic A", "topic B"]));
    expect([...activeTurns.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, messageThreadId: 10, sourceMessageId: 101 }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20, sourceMessageId: 201 }),
    ]));
    expect(sendText).not.toHaveBeenCalledWith(111, expect.stringContaining("busy"), expect.anything(), expect.anything());

    gates.get("topic A")!.resolve();
    gates.get("topic B")!.resolve();
    await vi.waitFor(() => expect(activeTurns.size).toBe(0));
  });
});
