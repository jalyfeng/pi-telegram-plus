/**
 * A host notice (showWarning / showError / showStatus) raised while a Telegram turn runs,
 * outside any command scope, is forwarded to that turn's chat (#33). Inside a command
 * scope it stays with the command's own message. With no Telegram turn nothing is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInCommand } from "../tui/command-context.ts";
import { createTurnNotice } from "../controller.ts";
import { OutputCapture, type NoticeTarget, type TurnNotice } from "../tui/output.ts";
import { OriginTracker } from "../tui/origin.ts";
import { SecretStore } from "../tui/secrets.ts";
import type { TelegramTurn } from "../types.ts";

const TURN: TelegramTurn = { chatId: 42, messageThreadId: 7, sourceMessageId: 99, queuedAttachments: [] };

/** A host mode with the three notice methods the real InteractiveMode exposes. */
class FakeMode {
  showStatus(_message: string): void {}
  showError(_message: string): void {}
  showWarning(_message: string): void {}
}

function fixture(turns: TelegramTurn[] = [TURN]) {
  const sendText = vi.fn(async () => []);
  const transport = { sendText, editText: vi.fn(async () => undefined), sendDocument: vi.fn(async () => undefined) };
  const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
  const secrets = new SecretStore();
  const sent: Array<{ target: NoticeTarget; html: string }> = [];
  const notice: TurnNotice = {
    turn: () => (turns.length ? { chatId: turns[turns.length - 1].chatId, messageThreadId: turns[turns.length - 1].messageThreadId, sourceMessageId: turns[turns.length - 1].sourceMessageId } : undefined),
    send: (target, html) => {
      sent.push({ target, html });
    },
  };
  const output = new OutputCapture(transport, origin, secrets, notice);
  const capture = output as unknown as { attach(state: unknown): void };
  const mode = new FakeMode();
  capture.attach({ mode, ui: {}, chat: undefined, session: undefined });
  const bind = (label: string) => {
    const scope = origin.begin({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 }, label, `/${label}`, "");
    output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  };
  return { mode, output, origin, sent, sendText, secrets, bind };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutputCapture host notice during a Telegram turn", () => {
  it("forwards a warning raised outside any command to the active turn", () => {
    const { mode, sent } = fixture();
    mode.showWarning("compaction: Compaction freed too little context");
    expect(sent).toHaveLength(1);
    expect(sent[0].target).toEqual({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 });
    expect(sent[0].html).toBe("⚠️ compaction: Compaction freed too little context");
  });

  it("uses the error prefix for showError and no prefix for showStatus", () => {
    const { mode, sent } = fixture();
    mode.showError("boom & bad");
    mode.showStatus("Background job completed");
    expect(sent.map((item) => item.html)).toEqual(["❌ boom &amp; bad", "Background job completed"]);
  });

  it("sends nothing when no Telegram turn is active", () => {
    const { mode, sent } = fixture([]);
    mode.showWarning("compaction: Compaction freed too little context");
    expect(sent).toHaveLength(0);
  });

  it("keeps a notice inside a command scope with the command, not the turn", () => {
    const { mode, sent, bind, origin } = fixture();
    const scope = bind("compact");
    runInCommand(scope, () => mode.showWarning("compaction: inside command"));
    expect(sent).toHaveLength(0);
    expect(origin.active()).toBe(scope);
  });

  it("masks a tracked secret before forwarding", () => {
    const { mode, sent, secrets } = fixture();
    secrets.remember("42:7", "flow", "supersecret-value");
    mode.showWarning("token supersecret-value leaked");
    expect(sent[0].html).toBe("⚠️ token *** leaked");
  });
});

describe("createTurnNotice", () => {
  it("targets the newest active turn", () => {
    const older: TelegramTurn = { ...TURN, sourceMessageId: 1 };
    const newer: TelegramTurn = { ...TURN, chatId: 43, sourceMessageId: 2 };
    const notice = createTurnNotice(() => [older, newer], { sendText: vi.fn(async () => []) });
    expect(notice.turn()).toEqual({ chatId: 43, messageThreadId: 7, sourceMessageId: 2 });
  });

  it("returns no target when no turn is active", () => {
    const notice = createTurnNotice(() => [], { sendText: vi.fn(async () => []) });
    expect(notice.turn()).toBeUndefined();
  });

  it("sends the same html to the same turn once within 5 seconds", async () => {
    const sendText = vi.fn(async (..._args: unknown[]) => []);
    let clock = 1_000;
    const notice = createTurnNotice(() => [TURN], { sendText }, () => clock);
    const target = { chatId: 42, messageThreadId: 7, sourceMessageId: 99 };
    notice.send(target, "⚠️ same");
    clock += 1_000;
    notice.send(target, "⚠️ same");
    clock += 5_000;
    notice.send(target, "⚠️ same");
    notice.send(target, "⚠️ other");
    await Promise.resolve();
    expect(sendText.mock.calls.map((call) => call[1])).toEqual(["⚠️ same", "⚠️ same", "⚠️ other"]);
    expect(sendText.mock.calls[0]).toEqual([42, "⚠️ same", 7, 99]);
  });
});
