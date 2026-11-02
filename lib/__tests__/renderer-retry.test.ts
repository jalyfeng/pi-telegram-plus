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

const ERROR = "500: {\"message\":\"mock provider exploded (ERROR_PROBE)\"}";

/**
 * `omp: true` is the OMP shape: auto_retry_* and the settled agent_end arrive through pi.on
 * (no session subscription). `omp: false` is the pi 1.4.0 shape: retry events come from the
 * session subscription, and agent_end from the subscription too (it carries willRetry).
 */
function createRetryHarness(options: { omp?: boolean; session?: FakeSession | undefined } = {}) {
  const omp = options.omp === true;
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
  let session: FakeSession | undefined = "session" in options ? options.session : fakeSession();
  registerTelegramRenderer(pi as any, {
    isOmp: omp,
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
  /** A host retry or settle event, delivered the way this host delivers it. */
  const host = async (event: Record<string, unknown>) => {
    if (omp) await emit(event.type as string, event);
    else session?.emit(event);
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const failedAssistant = (text = ERROR) =>
    ({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: text } });
  const settle = async (opts: { willRetry?: boolean; stopReason?: string } = {}) => {
    const messages = opts.stopReason ? [{ role: "assistant", content: [], stopReason: opts.stopReason }] : [];
    await host({ type: "agent_end", messages, willRetry: opts.willRetry ?? false });
  };
  return {
    omp,
    emit,
    host,
    flush,
    settle,
    sent,
    edits,
    failedAssistant,
    setSession: (next: FakeSession | undefined) => { session = next; },
    currentSession: () => session,
    transport,
  };
}

describe("Telegram renderer: provider error and auto-retry status (P2-5)", () => {
  describe("pi 1.4.0 shape (events by session subscription)", () => {
    it("one status message for a failed attempt and three failed retries, then one final error", async () => {
      const h = createRetryHarness();
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_end", success: false, attempt: 3, finalError: ERROR });
        await h.settle();
        await h.flush();
      });

      // Only the status message is sent; every later update is an edit of it.
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].text).toContain("Retrying (1/3) in 2s");
      expect(h.edits.length).toBeGreaterThanOrEqual(3);
      const last = h.edits.at(-1)!;
      expect(last.messageId).toBe(h.sent[0].messageId);
      expect(last.text.startsWith("❌")).toBe(true);
      expect(h.sent.filter((item) => item.text.includes("ERROR_PROBE"))).toHaveLength(1);
    });

    it("a failed attempt followed by a successful retry ends as 'Recovered' and the reply is sent separately", async () => {
      const h = createRetryHarness();
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed answer" }], stopReason: "stop" } });
        await h.host({ type: "auto_retry_end", success: true, attempt: 1 });
        await h.settle();
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
        await h.settle();
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
        await h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
        await h.host({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
        await h.settle();
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

    it("a session without subscribe does not break the run", async () => {
      const h = createRetryHarness({ session: undefined });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await expect(runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
      })).resolves.toBeUndefined();
      expect(h.sent).toHaveLength(0);
    });
  });

  describe("OMP shape (events through pi.on, settled agent_end after the retry decision)", () => {
    it("ten retries then giving up: one message, ends as ❌, and the host's 'Retry failed' notice is not sent again", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        for (let attempt = 1; attempt <= 10; attempt++) {
          await h.host({ type: "auto_retry_start", attempt, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
          await h.emit("agent_start");
          await h.emit("message_end", h.failedAssistant());
        }
        await h.host({ type: "auto_retry_end", success: false, attempt: 10, finalError: ERROR });
        await h.settle();
        await h.flush();
      });

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].text).toContain("Retrying (1/10)");
      const last = h.edits.at(-1)!;
      expect(last.messageId).toBe(h.sent[0].messageId);
      expect(last.text.startsWith("❌ ")).toBe(true);
      expect(last.text).toContain("ERROR_PROBE");

      // The host's own notice for the same give-up is judged against the turn, synchronously.
      const notice = createTurnNotice(() => [turn], h.transport);
      notice.send(notice.turn()!, `❌ ${escapeHtml(`Retry failed after 10 attempts: ${ERROR}`)}`);
      await h.flush();
      expect(h.sent).toHaveLength(1);
    });

    it("/stop while a retry is waiting: ends as '⏹️ Retry cancelled.'", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
        await h.host({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
        await h.settle({ stopReason: "aborted" });
        await h.flush();
      });

      expect(h.sent).toHaveLength(1);
      expect(h.edits.at(-1)!.text).toBe("⏹️ Retry cancelled.");
    });

    it("/stop after a failed attempt but before any retry: ends as '⏹️ Stopped after an error: …'", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant("401: invalid api key"));
        await h.settle({ stopReason: "aborted" });
        await h.flush();
      });

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].text).toBe("⏹️ Stopped after an error: 401: invalid api key");
    });

    it("an error that is not retried is shown once as ❌ <error>", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant("401: invalid api key"));
        await h.settle();
        await h.flush();
      });

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].text).toBe("❌ 401: invalid api key");
    });

    it("a retry that succeeds ends as 'Recovered' and the reply is sent separately", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        await h.emit("message_end", h.failedAssistant());
        await h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed answer" }], stopReason: "stop" } });
        await h.host({ type: "auto_retry_end", success: true, attempt: 1 });
        await h.settle();
        await h.flush();
      });

      const status = h.sent[0];
      const finalStatus = h.edits.filter((edit) => edit.messageId === status.messageId).at(-1)!;
      expect(finalStatus.text).toContain("Recovered after 1 retry.");
      expect(h.sent.find((item) => item.text.includes("fixed answer"))).toBeDefined();
    });

    it("never subscribes to the session on OMP", async () => {
      const session = fakeSession();
      const h = createRetryHarness({ omp: true, session });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
      });
      expect(session.listenerCount()).toBe(0);
    });
  });
});
