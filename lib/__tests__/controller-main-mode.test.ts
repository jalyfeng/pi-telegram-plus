import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";

// ── TUI parity (fixed behavior, no modes) ────────────────────────────────
// Telegram messages behave exactly like typing in the pi terminal:
//  • main loop busy with its own turn → steer into the main turn
//  • main loop idle + background agents running → hold, then start a fresh
//    main-thread turn with a plain prompt (never injected into a subagent)
//  • everything idle → fresh main-thread turn immediately
// ctx.isIdle() distinguishes "main turn running" from "background agents
// running" — session.isStreaming alone cannot (issue #10).

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

function createSession(streamingRef: { value: boolean }, idleRef: { value: boolean }, prompts: Array<{ text: string; opts?: Record<string, unknown> }>, hasIdleHelpers = true) {
  const ctx: any = hasIdleHelpers
    ? {
        isIdle: () => idleRef.value,
        waitForIdle: async () => {
          while (streamingRef.value) await sleep(5);
        },
      }
    : {};
  const session: any = {
    prompt: vi.fn(async (text: string, promptOpts?: Record<string, unknown>) => {
      prompts.push({ text, opts: promptOpts });
    }),
    extensionRunner: {
      getUIContext: () => undefined,
      setUIContext: () => undefined,
      getCommand: () => undefined,
      createCommandContext: () => ctx,
    },
  };
  Object.defineProperty(session, "isStreaming", { get: () => streamingRef.value, configurable: true });
  return session;
}

function createController(session: any, sent: Array<{ text: string }>) {
  return createTelegramController({
    getSession: () => session,
    transport: {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async (_chatId: number, text: string) => {
        sent.push({ text });
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
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
    endTelegramTurn: () => undefined,
  });
}

async function sendMessage(controller: ReturnType<typeof createTelegramController>, text: string, messageId = 1) {
  await controller.handleMessage({
    message_id: messageId,
    chat: { id: 999 },
    from: { id: 1 },
    text,
  });
}

describe("TUI-parity message delivery", () => {
  it("steers into the main turn while the main loop is busy (like typing in the TUI)", async () => {
    const streamingRef = { value: true };
    const idleRef = { value: false }; // main turn running
    const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const sent: Array<{ text: string }> = [];
    const controller = createController(createSession(streamingRef, idleRef, prompts), sent);

    await sendMessage(controller, "steer into main turn");
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].opts?.streamingBehavior).toBe("steer");
    expect(prompts[0].text).toBe("steer into main turn");
  });

  it("holds while background agents run with an idle main loop, then starts a fresh main turn", async () => {
    const streamingRef = { value: true };
    const idleRef = { value: true }; // workflow running in background
    const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const sent: Array<{ text: string }> = [];
    const controller = createController(createSession(streamingRef, idleRef, prompts), sent);

    const delivery = sendMessage(controller, "hello during workflow");
    await sleep(30);
    expect(prompts).toHaveLength(0); // held
    expect(sent.some((item) => item.text.includes("holding your message"))).toBe(true);

    streamingRef.value = false; // workflow finished
    await delivery;
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].text).toBe("hello during workflow");
    expect(prompts[0].opts).toEqual({ source: "interactive" }); // plain prompt, never a subagent
    expect(sent.filter((item) => item.text.includes("holding your message"))).toHaveLength(1);
  });

  it("delivers a plain prompt immediately when everything is idle", async () => {
    const streamingRef = { value: false };
    const idleRef = { value: true };
    const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const sent: Array<{ text: string }> = [];
    const controller = createController(createSession(streamingRef, idleRef, prompts), sent);

    await sendMessage(controller, "hello idle");
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].opts).toEqual({ source: "interactive" });
    expect(sent.some((item) => item.text.includes("holding your message"))).toBe(false);
  });

  it("falls back to session.isStreaming when the host exposes no isIdle", async () => {
    const streamingRef = { value: true };
    const idleRef = { value: true };
    const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const sent: Array<{ text: string }> = [];
    const controller = createController(createSession(streamingRef, idleRef, prompts, false), sent);

    await sendMessage(controller, "fallback steer");
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].opts?.streamingBehavior).toBe("steer");
  });

  it("chains concurrent messages and delivers them to the main thread in order", async () => {
    const streamingRef = { value: true };
    const idleRef = { value: true };
    const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const sent: Array<{ text: string }> = [];
    const controller = createController(createSession(streamingRef, idleRef, prompts), sent);

    const first = sendMessage(controller, "first");
    const second = sendMessage(controller, "second", 2);
    await sleep(30);
    expect(prompts).toHaveLength(0);

    streamingRef.value = false;
    await Promise.all([first, second]);
    await waitFor(() => prompts.length === 2);

    expect(prompts.map((item) => item.text)).toEqual(["first", "second"]);
    expect(prompts.every((item) => item.opts && !("streamingBehavior" in item.opts))).toBe(true);
  });
});
