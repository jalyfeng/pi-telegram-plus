import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import { CommandGateway } from "../tui/gateway.ts";
import { DialogBroker } from "../tui/broker.ts";
import type { DialogSession } from "../tui/model.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

type Call = { method: string; text?: string; messageId?: number; queryId?: string };

function createTransport(calls: Call[]): TelegramTransport {
  const text = (value: string, messageId?: number): void => { calls.push({ method: "text", text: value, messageId }); };
  return {
    removeInlineKeyboard: async (_chatId, messageId) => { calls.push({ method: "removeKeyboard", messageId }); },
    sendText: async (_chatId, value) => {
      text(value);
      return [{ message_id: 1 }];
    },
    sendButtons: async (_chatId, value) => {
      text(value);
      return { message_id: 2 };
    },
    editText: async (_chatId, messageId, value) => { text(value, messageId); },
    editButtons: async (_chatId, messageId, value) => { calls.push({ method: "buttons", text: value, messageId }); },
    answerCallbackQuery: async (queryId, textValue) => {
      calls.push({ method: "answer", queryId, text: textValue });
    },
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
}

function createSession(overrides: Record<string, unknown> = {}): CapturedAgentSession {
  return {
    prompt: vi.fn(async () => undefined),
    isStreaming: false,
    extensionRunner: {
      getUIContext: () => undefined,
      setUIContext: () => undefined,
      getCommand: () => undefined,
      createCommandContext: () => ({}),
    },
    executeBash: vi.fn(async (_command: string, onChunk: (chunk: string) => void) => {
      onChunk("PTP_BASH_OK\n");
      return { exitCode: 0, output: "PTP_BASH_OK\n" };
    }),
    abortBash: vi.fn(),
    isBashRunning: false,
    ...overrides,
  } as unknown as CapturedAgentSession;
}

function createBridge(overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [{ name: "settings", description: "Open settings", source: "builtin" }],
    submit: vi.fn(() => true),
    key: vi.fn(() => true),
    write: vi.fn(() => true),
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
    ...overrides,
  };
}

function createHarness(options: {
  session?: CapturedAgentSession;
  bridge?: TuiBridgeAdapter;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = options.session ?? createSession();
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      create: () => ({ notify: async () => undefined, confirm: vi.fn(async () => true) }) as never,
      resolveInput: () => ({ handled: false }),
      isSensitiveInput: () => false,
      hasPendingInput: () => false,
      dispose: () => undefined,
    },
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({
      chatId,
      replaceMessageId,
      queuedAttachments: [],
    }),
    endTelegramTurn: () => undefined,
    getConfig: () => ({ bashConfirm: "dangerous", activeChatId: 42 }),
    tuiBridge: options.bridge ?? createBridge(),
  });
  return { controller, calls, session };
}

describe("dialog callback dispatch", () => {
  // A dialog payload is a key sequence for the focused component. Submitted as
  // text it would run as a prompt (or worse, as a shell line), so the dialog
  // branch has to swallow it.
  it("never submits a dialog callback as a prompt", async () => {
    const harness = createHarness();

    await harness.controller.handleCallbackQuery({
      id: "cb-9",
      data: "tgplus:dlg:s1:0:c:0.1",
      message: { message_id: 55, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.method === "text"
      && String(call.text).includes("tgplus:dlg:"))).toBe(false);
    // Nothing is focused, so the answer is "handled in the terminal" and the
    // dead keyboard has to come off the message.
    expect(harness.calls.some((call) => call.method === "answer"
      && call.text === "Answered in the terminal")).toBe(true);
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 55)).toBe(true);
  });

  it("swallows a dialog payload that no longer decodes", async () => {
    const harness = createHarness();

    await harness.controller.handleCallbackQuery({
      id: "cb-10",
      data: "tgplus:dlg:stale-keyboard",
      message: { message_id: 56, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.method === "answer"
      && call.text === "This menu has expired")).toBe(true);
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 56)).toBe(true);
  });

  it("keeps plain chat text on the prompt path", async () => {
    const harness = createHarness();

    await harness.controller.handleMessage({
      message_id: 60,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledWith(
      "summarize the failing test",
      { source: "interactive" },
    ));
  });

  it("keeps shell input on the bash path", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness();

      await harness.controller.handleMessage({
        message_id: 61,
        chat: { id: 42, type: "private" },
        from: { id: 7 },
        text: "!echo hi",
      });

      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({
        text: "!echo hi",
        label: "!",
      })));
      expect(harness.session.prompt).not.toHaveBeenCalled();
      expect(harness.session.executeBash).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });
});

describe("chat text while a host dialog holds the focus", () => {
  // decision 54: a dialog that is still on screen but takes no text owns the terminal's
  // input, and a message typed in the terminal cannot reach the prompt either. The
  // broker reports that case as `handled: false` with the session still live (see
  // tui-broker.test.ts); the chat then gets a notice instead of a prompt that would
  // sit behind a dialog nobody answered.
  const noticeOf = (title?: string) =>
    `A dialog is waiting in the terminal${title ? ` (${title})` : ""}. Answer it with the buttons, or send /stop to cancel.`;

  const sentTexts = (calls: Call[]): string[] =>
    calls.filter((call) => call.method === "text").map((call) => String(call.text));
  const sawNotice = (calls: Call[]): boolean =>
    sentTexts(calls).some((value) => value.includes("A dialog is waiting in the terminal"));

  /** `select` without `search`: no text purpose, so the broker leaves it alone. */
  function noTextSession(title = "Settings"): DialogSession {
    return {
      id: "s1",
      generation: 1,
      openedAt: 0,
      focus: {},
      kind: "dialog",
      ownerFromScope: false,
      model: { kind: "select", title, items: [], total: 0 },
      telegram: { chatId: 42, messageThreadId: undefined, messageId: 101 },
      state: "open",
    } as unknown as DialogSession;
  }

  const message = (messageId: number, text: string) => ({
    message_id: messageId,
    chat: { id: 42, type: "private" },
    from: { id: 7 },
    text,
  });

  it("notices chat text a text-less dialog blocks, and submits no prompt", async () => {
    const session = noTextSession();
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor").mockReturnValue(session);
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockReturnValue({ handled: false });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(70, "theme"));

      expect(handleText).toHaveBeenCalledWith(session, "theme", 70);
      expect(sentTexts(harness.calls)).toContain(noticeOf("Settings"));
      expect(harness.session.prompt).not.toHaveBeenCalled();
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });

  it("drops the title from the notice when the model has none", async () => {
    const session = {
      ...noTextSession(),
      model: { kind: "progress", text: "Working", cancellable: false },
    } as unknown as DialogSession;
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor").mockReturnValue(session);
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockReturnValue({ handled: false });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(71, "hello"));

      expect(sentTexts(harness.calls)).toContain(noticeOf());
      expect(harness.session.prompt).not.toHaveBeenCalled();
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });

  it("still hands chat text to a dialog that takes it", async () => {
    const session = {
      ...noTextSession("Provider"),
      model: { kind: "input", title: "Provider", secret: false },
    } as unknown as DialogSession;
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor").mockReturnValue(session);
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockReturnValue({ handled: true });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(72, "anthropic"));

      expect(handleText).toHaveBeenCalledWith(session, "anthropic", 72);
      expect(sawNotice(harness.calls)).toBe(false);
      expect(harness.session.prompt).not.toHaveBeenCalled();
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });

  it.each(["/stop", "/status"])("keeps %s off the dialog-text path", async (text) => {
    const session = noTextSession();
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor").mockReturnValue(session);
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockReturnValue({ handled: false });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(73, text));

      expect(handleText).not.toHaveBeenCalled();
      expect(sawNotice(harness.calls)).toBe(false);
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });

  it("answers a ! shell command blocked by the dialog with the same notice", async () => {
    // The `!` route used to carry its own older wording; one dialog, one notice.
    const session = noTextSession();
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor").mockReturnValue(session);
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockReturnValue({ handled: false });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(75, "!ls"));

      expect(handleText).not.toHaveBeenCalled();
      expect(sentTexts(harness.calls)).toContain(noticeOf("Settings"));
      expect(harness.session.prompt).not.toHaveBeenCalled();
      expect(harness.session.executeBash).not.toHaveBeenCalled();
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });

  it("submits chat text as a prompt once the dialog has left the screen", async () => {
    // `handleText` retiring the session is the other reading of `handled: false`:
    // the dialog is gone, so this text is an ordinary prompt again.
    const session = noTextSession();
    let open = true;
    const sessionFor = vi.spyOn(DialogBroker.prototype, "sessionFor")
      .mockImplementation(() => (open ? session : undefined));
    const handleText = vi.spyOn(DialogBroker.prototype, "handleText").mockImplementation(() => {
      open = false;
      return { handled: false };
    });
    try {
      const harness = createHarness();
      await harness.controller.handleMessage(message(74, "summarize the flaky test"));

      await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledWith(
        "summarize the flaky test",
        { source: "interactive" },
      ));
      expect(sawNotice(harness.calls)).toBe(false);
    } finally {
      sessionFor.mockRestore();
      handleText.mockRestore();
    }
  });
});
