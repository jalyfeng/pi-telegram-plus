import { describe, expect, it } from "vitest";
import { registerTelegramRenderer } from "../renderer.ts";
import type { TelegramConfig, TelegramTurn } from "../types.ts";

// TUI parity: subagent turns never appear as part of the main conversation.
// While an agent-spawning tool executes — or background agents keep the
// session streaming with the main loop idle — their events are suppressed;
// a single "Workflow running…" line is emitted per window (brief level).

type SentItem = { chatId: number; text: string };

function createRendererHarness(options: {
  config?: TelegramConfig;
  isStreaming?: () => boolean;
  isIdle?: () => boolean;
} = {}) {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const pi = {
    on: (event: string, handler: (event: any) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  const sent: SentItem[] = [];
  const turn: TelegramTurn = { chatId: 111, queuedAttachments: [] };

  registerTelegramRenderer(pi as any, {
    getConfig: () => options.config ?? { botToken: "token", activeChatId: 111, tool: "brief", thinking: "brief" },
    transport: {
      removeInlineKeyboard: async () => undefined,
      sendText: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
        return [{ message_id: sent.length }];
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
    getActiveTurn: () => turn,
    hasActiveTurns: () => true,
    getSession: () => ({
      isStreaming: options.isStreaming?.() ?? false,
      extensionRunner: { createCommandContext: () => ({ isIdle: () => options.isIdle?.() ?? true }) },
    }),
  });

  const emit = async (event: string, payload: any) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };

  return { emit, sent };
}

const assistantMessage = (text: string) => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("workflow/subagent rendering filter", () => {
  it("suppresses subagent activity inside a spawning-tool window and emits one notice", async () => {
    const { emit, sent } = createRendererHarness();

    await emit("tool_execution_start", { toolName: "subagent", toolCallId: "s1", args: {} });
    // Subagent's own assistant message and tools inside the window: suppressed.
    await emit("message_end", assistantMessage("I am a subagent reply"));
    await emit("tool_execution_start", { toolName: "bash", toolCallId: "b1", args: {} });
    await emit("tool_execution_end", { toolName: "bash", toolCallId: "b1", result: {}, isError: false });
    await emit("tool_execution_end", { toolName: "subagent", toolCallId: "s1", result: {}, isError: false });

    // Main thread's final message after the workflow resolves: rendered.
    await emit("message_end", assistantMessage("Main thread final answer"));

    expect(sent.filter((item) => item.text.includes("Workflow running"))).toHaveLength(1);
    expect(sent.filter((item) => item.text.includes("subagent reply"))).toHaveLength(0);
    expect(sent.filter((item) => item.text.includes("bash"))).toHaveLength(0);
    expect(sent.some((item) => item.text.includes("Main thread final answer"))).toBe(true);
  });

  it("suppresses background agent events when the session streams while the main loop is idle", async () => {
    let streaming = true;
    const { emit, sent } = createRendererHarness({ isStreaming: () => streaming, isIdle: () => true });

    await emit("message_end", assistantMessage("background agent chatter"));
    expect(sent.some((item) => item.text.includes("background agent chatter"))).toBe(false);
    expect(sent.filter((item) => item.text.includes("Workflow running"))).toHaveLength(1);

    // Main loop busy again (main turn resumed): normal rendering resumes.
    streaming = false;
    await emit("message_end", assistantMessage("real main answer"));
    expect(sent.some((item) => item.text.includes("real main answer"))).toBe(true);
  });

  it("renders the main thread's final message after the workflow resolves", async () => {
    const { emit, sent } = createRendererHarness();

    await emit("tool_execution_start", { toolName: "subagent", toolCallId: "s1", args: {} });
    await emit("tool_execution_end", { toolName: "subagent", toolCallId: "s1", result: {}, isError: false });
    await emit("message_end", assistantMessage("Main thread final answer"));

    expect(sent.some((item) => item.text.includes("Main thread final answer"))).toBe(true);
  });

  it("emits a notice per workflow window", async () => {
    const { emit, sent } = createRendererHarness();

    await emit("tool_execution_start", { toolName: "subagent", toolCallId: "s1", args: {} });
    await emit("tool_execution_end", { toolName: "subagent", toolCallId: "s1", result: {}, isError: false });
    await emit("tool_execution_start", { toolName: "subagent", toolCallId: "s2", args: {} });
    await emit("tool_execution_end", { toolName: "subagent", toolCallId: "s2", result: {}, isError: false });

    expect(sent.filter((item) => item.text.includes("Workflow running"))).toHaveLength(2);
  });
});
