import { describe, expect, it, vi } from "vitest";
import { registerTelegramRenderer } from "../renderer.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "../turn-context.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

function createRendererHarness(options: { tool?: "hidden" | "brief" | "full" } = {}) {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const sent: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }> = [];
  const actions: Array<{ chatId: number; action: string; messageThreadId?: number }> = [];
  const photos: Array<{ chatId: number; data: string; messageThreadId?: number; replyToMessageId?: number }> = [];
  const transport: TelegramTransport = {
    removeInlineKeyboard: async () => undefined,
    sendText: async (chatId, text, messageThreadId, replyToMessageId) => {
      sent.push({ chatId, text, messageThreadId, replyToMessageId });
      return [{ message_id: sent.length }];
    },
    sendButtons: async () => ({ message_id: 1 }),
    editText: async (chatId, _messageId, text) => {
      sent.push({ chatId, text });
    },
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async (chatId, data, _caption, _isPath, _signal, messageThreadId, replyToMessageId) => {
      photos.push({ chatId, data, messageThreadId, replyToMessageId });
    },
    sendChatAction: async (chatId, action, messageThreadId) => {
      actions.push({ chatId, action, messageThreadId });
    },
  };
  const pi = {
    on: (event: string, handler: (event: any) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  registerTelegramRenderer(pi as any, {
    getConfig: () => ({ botToken: "token", activeChatId: 111, tool: options.tool ?? "full", thinking: "brief" }),
    transport,
    getActiveTurn: () => getCurrentTelegramTurn(),
    hasActiveTurns: () => true,
  });

  const emit = async (event: string, payload: any) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };

  return { emit, sent, actions, photos };
}

describe("Telegram renderer turn routing", () => {
  it("routes interleaved assistant messages to their own Telegram chat", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 222, queuedAttachments: [] };

    await Promise.all([
      runWithTelegramTurn(turnA, () => emit("message_end", { message: { role: "assistant", content: "answer for A" } })),
      runWithTelegramTurn(turnB, () => emit("message_end", { message: { role: "assistant", content: "answer for B" } })),
    ]);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("answer for A") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("answer for B") }),
    ]));
    expect(sent.find((item) => item.chatId === 111 && item.text.includes("answer for B"))).toBeUndefined();
    expect(sent.find((item) => item.chatId === 222 && item.text.includes("answer for A"))).toBeUndefined();
  });

  it("routes same-chat different-thread assistant messages to their own Telegram topic", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, messageThreadId: 10, sourceMessageId: 1001, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 111, messageThreadId: 20, sourceMessageId: 2001, queuedAttachments: [] };

    await Promise.all([
      runWithTelegramTurn(turnA, () => emit("message_end", { message: { role: "assistant", content: "topic A answer" } })),
      runWithTelegramTurn(turnB, () => emit("message_end", { message: { role: "assistant", content: "topic B answer" } })),
    ]);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 1001, text: expect.stringContaining("topic A answer") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20, replyToMessageId: 2001, text: expect.stringContaining("topic B answer") }),
    ]));
    expect(sent.find((item) => item.messageThreadId === 10 && item.text.includes("topic B"))).toBeUndefined();
    expect(sent.find((item) => item.messageThreadId === 20 && item.text.includes("topic A"))).toBeUndefined();
  });

  it("deduplicates inline tool events per chat/thread instead of globally", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, messageThreadId: 10, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 111, messageThreadId: 20, queuedAttachments: [] };
    const event = { toolCallId: "call", toolName: "read", args: { path: "README.md" } };

    await runWithTelegramTurn(turnA, () => emit("tool_execution_start", event));
    await runWithTelegramTurn(turnB, () => emit("tool_execution_start", event));

    expect(sent.filter((item) => item.text.includes("read"))).toEqual([
      expect.objectContaining({ chatId: 111, messageThreadId: 10 }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20 }),
    ]);
  });

  it("does not fall back to activeChatId when active turns exist but the event has no turn context", async () => {
    const { emit, sent } = createRendererHarness();

    await emit("message_end", { message: { role: "assistant", content: "ambiguous output" } });

    expect(sent).toHaveLength(0);
  });

  it("routes full tool output images and text to the current turn chat", async () => {
    const { emit, sent, actions, photos } = createRendererHarness();
    const turnB: TelegramTurn = { chatId: 222, messageThreadId: 77, sourceMessageId: 7701, queuedAttachments: [] };

    await runWithTelegramTurn(turnB, () => emit("tool_execution_end", {
      toolCallId: "image-call",
      toolName: "image_tool",
      isError: false,
      result: {
        content: [
          { type: "text", text: "tool text for B" },
          { type: "image", data: "base64-image", mimeType: "image/png" },
        ],
      },
    }));

    expect(sent).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, replyToMessageId: 7701, text: expect.stringContaining("tool text for B") })]);
    expect(actions).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, action: "upload_photo" })]);
    expect(photos).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, replyToMessageId: 7701, data: "base64-image" })]);
  });

  it("renders brief failed tool results as a human summary instead of raw JSON", async () => {
    const { emit, sent } = createRendererHarness({ tool: "brief" });
    const turn: TelegramTurn = { chatId: 222, messageThreadId: 77, sourceMessageId: 7701, queuedAttachments: [] };
    const args = { command: 'for i in $(seq 1 20); do echo "tick $i"; sleep 1; done' };

    await runWithTelegramTurn(turn, async () => {
      await emit("tool_execution_start", { toolCallId: "bash-call", toolName: "bash", args });
      await emit("tool_execution_end", {
        toolCallId: "bash-call",
        toolName: "bash",
        isError: true,
        result: {
          content: [{ type: "text", text: "tick 1\ntick 2\n\nCommand aborted" }],
          details: {},
        },
      });
    });

    const failure = sent.find((item) => item.text.includes("❌ bash"));
    expect(failure?.text).toContain("Command aborted");
    expect(failure?.text).not.toContain('"content"');
  });
});
