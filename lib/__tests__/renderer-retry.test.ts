import { describe, expect, it } from "vitest";
import { createTurnNotice } from "../controller.ts";
import { escapeHtml } from "../html.ts";
import { registerTelegramRenderer } from "../renderer.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "../turn-context.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

type FakeSession = {
  subscribe(listener: (event: any) => void): () => void;
  emit(event: unknown): void;
  listenerCount(): number;
};

function fakeSession(): FakeSession {
  const listeners = new Set<(event: any) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function createRetryHarness() {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const sent: Array<{ chatId: number; text: string; messageId: number }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  let nextId = 100;
  const transport: TelegramTransport = {
    removeInlineKeyboard: async () => undefined,
    sendText: async (chatId, text) => {
      const messageId = ++nextId;
      sent.push({ chatId, text, messageId });
      return [{ message_id: messageId }];
    },
    sendButtons: async () => ({ message_id: 1 }),
    editText: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    },
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
  const pi = {
    on: (event: string, handler: (event: any) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  let session: FakeSession | undefined = fakeSession();
  registerTelegramRenderer(pi as any, {
    getConfig: () => ({ botToken: "token", activeChatId: 111, tool: "brief", thinking: "brief" }),
    transport,
    getActiveTurn: () => getCurrentTelegramTurn(),
    hasActiveTurns: () => true,
    // The fake only carries what the renderer reads: subscribe.
    getSession: () => session as any,
  });
  const emit = async (event: string, payload: any = {}) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const failedAssistant = (text = "500: {\"message\":\"mock provider exploded (ERROR_PROBE)\"}") =>
    ({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: text } });
  return {
    emit,
    flush,
    sent,
    edits,
    failedAssistant,
    setSession: (next: FakeSession | undefined) => { session = next; },
    currentSession: () => session,
    transport,
  };
}

const ERROR = "500: {\"message\":\"mock provider exploded (ERROR_PROBE)\"}";

describe("Telegram renderer: provider error and auto-retry status (P2-5)", () => {
  it("one status message for a failed attempt and three failed retries, then one final error", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: ERROR });
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: ERROR });
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: ERROR });
      h.currentSession()!.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.flush();
    });

    // Only the status message is sent; every later update is an edit of it.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Retrying (1/3) in 2s");
    expect(h.edits.length).toBeGreaterThanOrEqual(3);
    const last = h.edits.at(-1)!;
    expect(last.messageId).toBe(h.sent[0].messageId);
    expect(last.text.startsWith("❌")).toBe(true);
    expect(h.sent.some((item) => item.text.includes("ERROR_PROBE"))).toBe(true);
    expect(h.sent.filter((item) => item.text.includes("ERROR_PROBE"))).toHaveLength(1);
  });

  it("does not repeat the host's 'Retry failed' notice once the final error is shown", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 1000, errorMessage: ERROR });
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: ERROR });
      h.currentSession()!.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.flush();
    });

    // The host forwards its own showError("Retry failed after 1 attempts: ...") to the turn.
    const notice = createTurnNotice(() => [turn], h.transport);
    const target = notice.turn();
    expect(target).toBeDefined();
    notice.send(target!, `❌ ${escapeHtml(`Retry failed after 1 attempts: ${ERROR}`)}`);
    await h.flush();
    expect(h.sent.filter((item) => item.text.includes("Retry failed"))).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it("a failed attempt followed by a successful retry ends as 'Recovered' and the reply is sent separately", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      await h.emit("agent_start");
      await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed answer" }], stopReason: "stop" } });
      h.currentSession()!.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      h.currentSession()!.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.flush();
    });

    const status = h.sent[0];
    expect(status.text).toContain("Retrying (1/3)");
    const finalStatus = h.edits.filter((edit) => edit.messageId === status.messageId).at(-1)!;
    expect(finalStatus.text).toContain("Recovered after 1 retry.");
    expect(finalStatus.text).not.toContain("❌");
    const reply = h.sent.find((item) => item.text.includes("fixed answer"));
    expect(reply).toBeDefined();
    expect(reply!.messageId).not.toBe(status.messageId);
  });

  it("an error that is not retried is shown once as ❌ <error>", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant("401: invalid api key"));
      h.currentSession()!.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.flush();
    });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toBe("❌ 401: invalid api key");
  });

  it("a cancelled retry ends as '⏹️ Retry cancelled.'", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
      h.currentSession()!.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      h.currentSession()!.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
      await h.flush();
    });

    expect(h.sent).toHaveLength(1);
    expect(h.edits.at(-1)!.text).toBe("⏹️ Retry cancelled.");
  });

  it("follows the active session: the new session's retry events arrive, the old session's do not", async () => {
    const h = createRetryHarness();
    const oldSession = h.currentSession()!;
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      oldSession.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "old" });
      await h.flush();
    });
    expect(h.sent).toHaveLength(1);

    const newSession = fakeSession();
    h.setSession(newSession);
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      expect(oldSession.listenerCount()).toBe(0);
      expect(newSession.listenerCount()).toBe(1);
      oldSession.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      newSession.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "new" });
      await h.flush();
    });

    expect(h.edits.some((edit) => edit.text.includes("Recovered"))).toBe(false);
    expect(h.edits.at(-1)!.text).toContain("new");
  });
});
