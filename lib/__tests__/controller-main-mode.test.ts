import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";

// ── Issue #10: messages during background workflows ──────────────────────
// While background workflow agents run, AgentSession.isStreaming stays true
// even though the main thread is idle, and steer/followUp messages drain
// into a workflow agent's turn. The "main" message mode holds the message
// until the main loop is idle, then submits a plain prompt so the message
// always starts a fresh main-thread turn. Steer/queue modes now emit a
// transparency notice instead of silently swallowing the message.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

function createSession(streamingRef: { value: boolean }, opts: { hasIdleHelpers?: boolean } = {}) {
  const prompts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
  const ctx: any = opts.hasIdleHelpers === false
    ? {}
    : {
        isIdle: () => !streamingRef.value,
        waitForIdle: async () => {
          while (streamingRef.value) await sleep(5);
        },
      };
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
  Object.defineProperty(session, "isStreaming", {
    get: () => streamingRef.value,
    configurable: true,
  });
  return { session, prompts };
}

function createDeps(streamingRef: { value: boolean }, session: any, sent: Array<{ text: string }>) {
  const transport = {
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
    getMessageMode: () => "main",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
    endTelegramTurn: () => undefined,
  });
  return { controller, transport };
}

async function sendMessage(controller: ReturnType<typeof createTelegramController>, text: string, messageId = 1) {
  await controller.handleMessage({
    message_id: messageId,
    chat: { id: 999 },
    from: { id: 1 },
    text,
  });
}

describe("main message mode (issue #10)", () => {
  it("holds a message while background work keeps the session streaming, then delivers a plain prompt", async () => {
    const streamingRef = { value: true };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const { controller } = createDeps(streamingRef, session, sent);

    const delivery = sendMessage(controller, "hello while busy");
    await sleep(30);
    expect(prompts).toHaveLength(0); // still held
    expect(sent.some((item) => item.text.includes("holding your message"))).toBe(true);

    streamingRef.value = false; // background workflow finished
    await delivery;
    // submitText dispatches fire-and-forget; wait for the actual delivery.
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].text).toBe("hello while busy");
    // Plain prompt: no streamingBehavior attached — this is what forces a
    // fresh main-thread turn instead of draining into a workflow agent.
    expect(prompts[0].opts).toEqual({ source: "interactive" });
    expect(sent.filter((item) => item.text.includes("holding your message"))).toHaveLength(1);
  });

  it("delivers immediately without a notice when the session is already idle", async () => {
    const streamingRef = { value: false };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const { controller } = createDeps(streamingRef, session, sent);

    await sendMessage(controller, "hello while idle");
    await waitFor(() => prompts.length === 1);

    expect(prompts[0].opts).toEqual({ source: "interactive" });
    expect(sent.some((item) => item.text.includes("holding your message"))).toBe(false);
  });

  it("chains concurrent messages and delivers them in order after idle", async () => {
    const streamingRef = { value: true };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const { controller } = createDeps(streamingRef, session, sent);

    const first = sendMessage(controller, "first");
    const second = sendMessage(controller, "second", 2);
    await sleep(30);
    expect(prompts).toHaveLength(0);

    streamingRef.value = false;
    await Promise.all([first, second]);
    await waitFor(() => prompts.length === 2);

    expect(prompts.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("polls isStreaming when the pi host exposes no waitForIdle helper", async () => {
    const streamingRef = { value: true };
    const { session, prompts } = createSession(streamingRef, { hasIdleHelpers: false });
    const sent: Array<{ text: string }> = [];
    const { controller } = createDeps(streamingRef, session, sent);

    const delivery = sendMessage(controller, "hello without waitForIdle");
    await sleep(30);
    expect(prompts).toHaveLength(0);
    streamingRef.value = false;

    await delivery;
    // Polling fallback: isStreaming is re-checked every 500ms + 120ms settle.
    await waitFor(() => prompts.length === 1, 3000);
    expect(prompts[0].opts).toEqual({ source: "interactive" });
  });
});

describe("busy transparency notice (issue #10)", () => {
  const buildController = (mode: "steer" | "queue", streamingRef: { value: boolean }, sent: Array<{ text: string }>, prompts: Array<{ text: string; opts?: Record<string, unknown> }>, session: any) => createTelegramController({
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
    getMessageMode: () => mode,
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
    endTelegramTurn: () => undefined,
  });

  it("notifies in steer mode when the session is busy without an active turn", async () => {
    const streamingRef = { value: true };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const controller = buildController("steer", streamingRef, sent, prompts, session);

    await sendMessage(controller, "steer me");
    await waitFor(() => prompts.length === 1);

    expect(sent.some((item) => item.text.includes("may be injected into a background task"))).toBe(true);
    expect(prompts[0].opts?.streamingBehavior).toBe("steer");
  });

  it("notifies in queue mode when the session is busy without an active turn", async () => {
    const streamingRef = { value: true };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const controller = buildController("queue", streamingRef, sent, prompts, session);

    await sendMessage(controller, "queue me");
    await waitFor(() => prompts.length === 1);

    expect(sent.some((item) => item.text.includes("may be injected into a background task"))).toBe(true);
    expect(prompts[0].opts?.streamingBehavior).toBe("followUp");
  });

  it("stays silent when the session is idle", async () => {
    const streamingRef = { value: false };
    const { session, prompts } = createSession(streamingRef);
    const sent: Array<{ text: string }> = [];
    const controller = buildController("steer", streamingRef, sent, prompts, session);

    await sendMessage(controller, "quiet delivery");
    await waitFor(() => prompts.length === 1);

    expect(sent.some((item) => item.text.includes("may be injected into a background task"))).toBe(false);
  });
});
