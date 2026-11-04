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
 * The renderer's two inputs, as the host gives them:
 * - `pi.on` handlers (agent_start, the replies' message_end): kept per event name here;
 * - the main session's subscription (`getRetrySession`): every failed attempt, retry event
 *   and settled agent_end. This is the only source of retry events on both hosts.
 * `omp` only names the host in the renderer's logs.
 */
function createRetryHarness(options: { omp?: boolean; retrySession?: FakeSession | undefined; runningSession?: FakeSession | undefined } = {}) {
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
  let retrySession: FakeSession | undefined = "retrySession" in options ? options.retrySession : fakeSession();
  const runningSession = "runningSession" in options ? options.runningSession : retrySession;
  registerTelegramRenderer(pi as any, {
    isOmp: options.omp === true,
    getConfig: () => ({ botToken: "token", activeChatId: 111, tool: "brief", thinking: "brief" }),
    transport,
    getActiveTurn: () => getCurrentTelegramTurn(),
    hasActiveTurns: () => true,
    getSession: () => runningSession as any,
    getRetrySession: () => retrySession as any,
  });
  const emit = async (event: string, payload: any = {}) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };
  /** A session event: delivered only through the subscription. */
  const host = (event: Record<string, unknown>) => {
    retrySession?.emit(event);
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const failedAssistant = (text = ERROR) =>
    ({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: text } });
  const settle = (opts: { willRetry?: boolean; stopReason?: string } = {}) => {
    const messages = opts.stopReason ? [{ role: "assistant", content: [], stopReason: opts.stopReason }] : [];
    host({ type: "agent_end", messages, willRetry: opts.willRetry ?? false });
  };
  return {
    emit,
    host,
    flush,
    settle,
    sent,
    edits,
    failedAssistant,
    registeredPiOn: () => [...handlers.keys()].sort(),
    setRetrySession: (next: FakeSession | undefined) => { retrySession = next; },
    currentSession: () => retrySession,
    transport,
  };
}

describe("Telegram renderer: provider error and auto-retry status (P2-5)", () => {
  it("one status message for a failed attempt and three failed retries, then one final error", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      await h.emit("agent_start");
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: ERROR });
      await h.emit("agent_start");
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: ERROR });
      await h.emit("agent_start");
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_end", success: false, attempt: 3, finalError: ERROR });
      h.settle();
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
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      await h.emit("agent_start");
      await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed answer" }], stopReason: "stop" } });
      h.host({ type: "auto_retry_end", success: true, attempt: 1 });
      h.settle();
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
      h.host(h.failedAssistant("401: invalid api key"));
      h.settle();
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
      h.host(h.failedAssistant());
      h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR });
      h.host({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
      h.settle();
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
    h.setRetrySession(newSession);
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
    const h = createRetryHarness({ retrySession: undefined });
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await expect(runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("message_end", h.failedAssistant());
    })).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(0);
  });

  describe("OMP shape: retry events reach the renderer only through the session subscription", () => {
    it("pi.on carries no retry names, so the subscription is the only source", async () => {
      const h = createRetryHarness({ omp: true });
      await h.emit("agent_start");
      expect(h.registeredPiOn().filter((name) => name.startsWith("auto_retry") || name === "agent_end")).toEqual([]);
    });

    it("ten retries then giving up: one message, ends as ❌, and the host's 'Retry failed' notice is not sent again", async () => {
      const h = createRetryHarness({ omp: true });
      const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
      await runWithTelegramTurn(turn, async () => {
        await h.emit("agent_start");
        h.host(h.failedAssistant());
        for (let attempt = 1; attempt <= 10; attempt++) {
          h.host({ type: "auto_retry_start", attempt, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
          await h.emit("agent_start");
          h.host(h.failedAssistant());
        }
        h.host({ type: "auto_retry_end", success: false, attempt: 10, finalError: ERROR });
        h.settle();
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
        h.host(h.failedAssistant());
        h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
        h.host({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
        h.settle({ stopReason: "aborted" });
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
        h.host(h.failedAssistant("401: invalid api key"));
        h.settle({ stopReason: "aborted" });
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
        h.host(h.failedAssistant("401: invalid api key"));
        h.settle();
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
        h.host(h.failedAssistant());
        h.host({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 1000, errorMessage: ERROR });
        await h.emit("agent_start");
        await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixed answer" }], stopReason: "stop" } });
        h.host({ type: "auto_retry_end", success: true, attempt: 1 });
        h.settle();
        await h.flush();
      });

      const status = h.sent[0];
      const finalStatus = h.edits.filter((edit) => edit.messageId === status.messageId).at(-1)!;
      expect(finalStatus.text).toContain("Recovered after 1 retry.");
      expect(h.sent.find((item) => item.text.includes("fixed answer"))).toBeDefined();
    });

    it("subscribes to the TUI's live session, not to the registry session", async () => {
      const liveSession = fakeSession();
      const registrySession = fakeSession();
      const h = createRetryHarness({ omp: true, retrySession: liveSession, runningSession: registrySession });
      await h.emit("agent_start");
      expect(liveSession.listenerCount()).toBe(1);
      expect(registrySession.listenerCount()).toBe(0);
    });
  });
});

describe("Telegram renderer: OMP todo reminder and tool failure repeats (P2-30, P2-31)", () => {
  it("shows a todo_reminder from the session subscription as the terminal does", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      h.host({
        type: "todo_reminder",
        todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }],
        attempt: 1,
        maxAttempts: 3,
      });
      await h.flush();
    });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("2 incomplete todos — reminder 1/3");
    expect(h.sent[0].text).toContain("☐ a\n");
    expect(h.sent[0].text).toContain("☐ b");
  });

  it("lists at most ten todos and counts the rest", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    const todos = Array.from({ length: 12 }, (_, index) => ({ content: `item ${index + 1}`, status: "pending" }));
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      h.host({ type: "todo_reminder", todos, attempt: 2, maxAttempts: 3 });
      await h.flush();
    });

    expect(h.sent[0].text).toContain("12 incomplete todos — reminder 2/3");
    expect(h.sent[0].text).toContain("☐ item 10");
    expect(h.sent[0].text).not.toContain("☐ item 11");
    expect(h.sent[0].text).toContain("… +2 more");
  });

  it("does not forward a host warning that repeats a tool failure already shown in the turn", async () => {
    const h = createRetryHarness();
    const turn: TelegramTurn = { chatId: 111, sourceMessageId: 7, queuedAttachments: [] };
    await runWithTelegramTurn(turn, async () => {
      await h.emit("agent_start");
      await h.emit("tool_execution_end", {
        toolCallId: "todo-1",
        toolName: "todo",
        isError: true,
        result: {
          content: [{ type: "text", text: "Errors: Missing phase name for append operation\nRemaining items (2):\n  - a [in_progress] (P1)" }],
          details: {},
        },
      });
      await h.flush();
    });
    expect(h.sent.some((item) => item.text.includes("❌ todo"))).toBe(true);
    expect(turn.lastToolFailure).toBe("Errors: Missing phase name for append operation");

    const forwarded: string[] = [];
    const notice = createTurnNotice(() => [turn], {
      sendText: async (_chatId, text) => {
        forwarded.push(text);
        return [];
      },
    });
    notice.send(notice.turn()!, "⚠️ Todo update failed: Errors: Missing phase name for append operation Remaining items (2): - a [in_progress] (P1)");
    notice.send(notice.turn()!, "⚠️ compaction: Compaction freed too little context");

    expect(forwarded).toEqual(["⚠️ compaction: Compaction freed too little context"]);
  });
});
