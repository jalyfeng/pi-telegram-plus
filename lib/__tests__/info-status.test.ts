import { describe, expect, it, vi } from "vitest";
import { buildStatusSnapshot, registerInfoCommands } from "../commands/info.ts";
import type { CapturedAgentSession, TelegramSentMessage, TelegramTransport } from "../types.ts";

function makeSession(overrides: Partial<{
  cwd: string;
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  pendingMessageCount: number;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}> = {}): CapturedAgentSession {
  const tokens = overrides.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const stats = {
    sessionFile: overrides.sessionFile ?? "/tmp/abc.jsonl",
    sessionId: overrides.sessionId ?? "sess-1",
    userMessages: overrides.userMessages ?? 0,
    assistantMessages: overrides.assistantMessages ?? 0,
    toolCalls: overrides.toolCalls ?? 0,
    toolResults: 0,
    totalMessages: (overrides.userMessages ?? 0) + (overrides.assistantMessages ?? 0),
    tokens,
    cost: overrides.cost ?? 0,
    contextUsage: overrides.contextUsage,
  };
  return {
    sessionManager: {
      getCwd: () => overrides.cwd ?? "/Users/me/proj",
      getSessionId: () => stats.sessionId,
      getSessionFile: () => stats.sessionFile,
      getSessionName: () => overrides.sessionName,
    },
    getSessionStats: () => stats,
    getContextUsage: () => overrides.contextUsage,
    model: overrides.model as CapturedAgentSession["model"],
    thinkingLevel: (overrides.thinkingLevel as CapturedAgentSession["thinkingLevel"]) ?? "off",
    isStreaming: overrides.isStreaming ?? false,
    pendingMessageCount: overrides.pendingMessageCount ?? 0,
  } as unknown as CapturedAgentSession;
}

describe("buildStatusSnapshot", () => {
  it("includes section headers and key labels", () => {
    const html = buildStatusSnapshot(makeSession());
    expect(html).toContain("🛰 TUI Status");
    expect(html).toContain("📂 Workspace");
    expect(html).toContain("🤖 Model");
    expect(html).toContain("📊 Context &amp; Tokens");
    expect(html).toContain("💬 Messages");
    expect(html).toContain("<b>cwd</b>");
    expect(html).toContain("<b>model</b>");
    expect(html).toContain("<b>context</b>");
  });

  it("escapes HTML in user-controlled values", () => {
    const html = buildStatusSnapshot(makeSession({ cwd: "/tmp/<script>" }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("uses 'active' badge when streaming and 'idle' otherwise", () => {
    const idle = buildStatusSnapshot(makeSession({ isStreaming: false, pendingMessageCount: 0 }));
    const active = buildStatusSnapshot(makeSession({ isStreaming: true }));
    const queueing = buildStatusSnapshot(makeSession({ isStreaming: false, pendingMessageCount: 2 }));
    expect(idle).toContain("⚪ idle");
    expect(active).toContain("🟢 active");
    expect(queueing).toContain("🟡 queueing");
  });

  it("shows '?' for context when percent is null", () => {
    const html = buildStatusSnapshot(makeSession({
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    }));
    expect(html).toContain("?/200000");
  });

  it("formats token counts using footer-like units", () => {
    const html = buildStatusSnapshot(makeSession({
      tokens: { input: 8_500, output: 4_500, cacheRead: 0, cacheWrite: 0, total: 13_000 },
    }));
    expect(html).toContain("8.5k");
    expect(html).toContain("4.5k");
    expect(html).toContain("13k");
  });

  it("keeps total size well under the 4096-byte Telegram limit", () => {
    const html = buildStatusSnapshot(makeSession({
      cwd: "/Users/me/very/very/long/path/that/should/stay/comfortably/small",
      sessionName: "a very long session name that should also be safe",
      tokens: { input: 1_234_567, output: 987_654, cacheRead: 555_555, cacheWrite: 222_222, total: 2_999_998 },
      cost: 1234.5678,
    }));
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(3600);
  });

  it("caps free-form text fields to keep the snapshot under the safe chunk size", () => {
    const longPath = "/" + "a".repeat(2_000);
    const longName = "n".repeat(2_000);
    const longId = "i".repeat(2_000);
    const html = buildStatusSnapshot(makeSession({
      cwd: longPath,
      sessionName: longName,
      sessionId: longId,
    }));
    // 2k + 2k + 2k of raw input should be truncated to 200 chars each,
    // leaving the final output well under 3600 bytes.
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(3600);
    // Truncation marker (U+2026 "…") is appended when the value is clipped.
    expect(html).toContain("…");
  });
});

type HandlerCtx = { ui: { notify: ReturnType<typeof vi.fn> } };

type HandlerEntry = {
  name: string;
  description?: string;
  handler: (args: string, ctx: HandlerCtx) => Promise<void>;
};

function makeRegistry(): { registry: { registerCommand: (name: string, options: { description?: string; handler: HandlerEntry["handler"] }) => void }; handlers: Map<string, HandlerEntry> } {
  const handlers = new Map<string, HandlerEntry>();
  return {
    handlers,
    registry: {
      registerCommand: (name, options) => {
        handlers.set(name, { name, description: options.description, handler: options.handler });
      },
    },
  };
}

function makeUi(): HandlerCtx & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  return { ui: { notify }, notify };
}

function makeTransport(overrides: { reject?: boolean } = {}): {
  transport: TelegramTransport;
  sendText: ReturnType<typeof vi.fn>;
} {
  const sendText = vi.fn(async (_chatId: number, _text: string): Promise<TelegramSentMessage[]> => {
    if (overrides.reject) return Promise.reject(new Error("send failure"));
    return [{ message_id: 1 }];
  });
  const transport = { sendText } as unknown as TelegramTransport;
  return { transport, sendText };
}

describe("registerInfoCommands /status handler", () => {
  it("calls ui.notify with 'No active session' when no session is present", async () => {
    const { registry, handlers } = makeRegistry();
    const { ui, notify } = makeUi();
    const { transport, sendText } = makeTransport();
    registerInfoCommands(registry, {
      getSession: () => undefined,
      getTransport: () => transport,
      getActiveChatId: () => 42,
    });

    const status = handlers.get("status");
    expect(status).toBeDefined();
    await status!.handler("", { ui });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("No active session", "error");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sends the HTML snapshot via transport.sendText when transport + chatId are available", async () => {
    const session = makeSession();
    const { registry, handlers } = makeRegistry();
    const { ui, notify } = makeUi();
    const { transport, sendText } = makeTransport();
    registerInfoCommands(registry, {
      getSession: () => session,
      getTransport: () => transport,
      getActiveChatId: () => 42,
    });

    const expected = buildStatusSnapshot(session);
    const status = handlers.get("status");
    expect(status).toBeDefined();
    await status!.handler("", { ui });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(42, expected, undefined, undefined);
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses active Telegram turn thread/source context for direct /status sends", async () => {
    const session = makeSession();
    const { registry, handlers } = makeRegistry();
    const { ui } = makeUi();
    const { transport, sendText } = makeTransport();
    registerInfoCommands(registry, {
      getSession: () => session,
      getTransport: () => transport,
      getActiveChatId: () => 42,
      getActiveTurn: () => ({ chatId: 99, messageThreadId: 7, sourceMessageId: 700, queuedAttachments: [] }),
    });

    const expected = buildStatusSnapshot(session);
    await handlers.get("status")!.handler("", { ui });

    expect(sendText).toHaveBeenCalledWith(99, expected, 7, 700);
  });

  it("falls back to ui.notify when no transport is provided", async () => {
    const session = makeSession();
    const { registry, handlers } = makeRegistry();
    const { ui, notify } = makeUi();
    registerInfoCommands(registry, {
      getSession: () => session,
      // no getTransport / getActiveChatId
    });

    const expected = buildStatusSnapshot(session);
    const status = handlers.get("status");
    expect(status).toBeDefined();
    await status!.handler("", { ui });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expected, "info");
  });

  it("falls back to ui.notify with stripped HTML when transport.sendText rejects", async () => {
    const session = makeSession();
    const { registry, handlers } = makeRegistry();
    const { ui, notify } = makeUi();
    const { transport, sendText } = makeTransport({ reject: true });
    registerInfoCommands(registry, {
      getSession: () => session,
      getTransport: () => transport,
      getActiveChatId: () => 42,
    });

    const html = buildStatusSnapshot(session);
    const status = handlers.get("status");
    expect(status).toBeDefined();
    await status!.handler("", { ui });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const [fallback, level] = notify.mock.calls[0];
    expect(level).toBe("info");
    // stripHtml branch uses the same regex as the production code.
    expect(fallback).toBe(html.replace(/<[^>]+>/g, ""));
    expect(fallback).not.toContain("<b>");
    expect(fallback).toContain("TUI Status");
    expect(fallback).toContain("📂 Workspace");
  });
});
