import { describe, expect, it, vi } from "vitest";
import { createTelegramController, type TelegramController } from "../controller.ts";
import { CommandGateway } from "../tui/gateway.ts";
import { OriginTracker } from "../tui/origin.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import { hostOwnsPrompts, type TuiBridgeAdapter } from "../tui-bridge.ts";

type Call = { method: string; text?: string; messageId?: number; rows?: unknown };

const CONFIRM_MESSAGE_ID = 7;

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
    editButtons: async (_chatId, messageId, value, rows) => {
      calls.push({ method: "buttons", text: value, messageId, rows });
    },
    answerCallbackQuery: async () => undefined,
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
  config?: { bashConfirm?: "always" | "dangerous" | "never"; activeChatId?: number };
  confirmResult?: boolean;
  telegramCommands?: Map<string, any>;
  confirm?: ReturnType<typeof vi.fn>;
  isOmpHost?: () => boolean;
  /** Mirror the plugin UI's `notify` into the recorded Bot API calls, as the real runtime does. */
  notifySendsToChat?: boolean;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = options.session ?? createSession();
  const bridge = options.bridge ?? createBridge();
  const confirm = options.confirm ?? vi.fn(async () => options.confirmResult ?? true);
  const config = options.config ?? { bashConfirm: "dangerous", activeChatId: 42 };
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      // The confirmation is sent as message 7; confirm() reports that id before it waits.
      create: (_chatId: number, _threadId?: number, _sourceId?: number, _onMenu?: unknown, onConfirmMessage?: (messageId: number) => void) => ({
        notify: async (message: string) => {
          if (options.notifySendsToChat) calls.push({ method: "text", text: String(message) });
        },
        confirm: async (...args: unknown[]) => {
          onConfirmMessage?.(CONFIRM_MESSAGE_ID);
          return (confirm as (...a: unknown[]) => unknown)(...args);
        },
      }) as never,
      resolveInput: () => ({ handled: false }),
      isSensitiveInput: () => false,
      hasPendingInput: () => false,
      dispose: () => undefined,
    },
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    telegramCommands: options.telegramCommands ?? new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId, replaceMessageId) => ({ chatId, replaceMessageId, queuedAttachments: [] }),
    endTelegramTurn: () => undefined,
    getConfig: () => config,
    tuiBridge: bridge,
    isOmpHost: options.isOmpHost,
  });
  return { controller, transport, calls, session, bridge, config, confirm };
}

describe("Telegram shell commands", () => {
  const send = (controller: TelegramController, text: string, messageId: number, chatType = "private") => (
    controller.handleMessage({
      message_id: messageId,
      chat: { id: 42, type: chatType },
      from: { id: 7 },
      text,
    })
  );

  it("submits !cmd to the host editor through the gateway", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness();
      await send(harness.controller, "!echo hi", 10);

      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({
        text: "!echo hi",
        label: "!",
        origin: expect.objectContaining({ chatId: 42 }),
      })));
      expect(harness.session.executeBash).not.toHaveBeenCalled();
      // The old direct-execution path edited its own status message with the
      // streamed output; that must not happen any more.
      expect(harness.calls.some((call) => call.text?.includes("PTP_BASH_OK"))).toBe(false);
    } finally {
      runText.mockRestore();
    }
  });

  it("a Telegram prompt sent while the command is still in its idle window supersedes that command's scope", async () => {
    const endSpy = vi.spyOn(OriginTracker.prototype, "end");
    // No captured host in this harness: let the real gateway run the scope and submit.
    const ready = vi.spyOn(CommandGateway.prototype as unknown as { hostReady(name: string): Promise<boolean> }, "hostReady").mockResolvedValue(true);
    try {
      const harness = createHarness();
      await send(harness.controller, "!echo hi", 13);
      await vi.waitFor(() => expect(harness.bridge.submit).toHaveBeenCalledWith("!echo hi"));

      await send(harness.controller, "please run the probe", 14);

      await vi.waitFor(() => expect(endSpy).toHaveBeenCalledWith(expect.objectContaining({ label: "!" }), "superseded"));
      expect(harness.session.prompt).toHaveBeenCalled();
    } finally {
      ready.mockRestore();
      endSpy.mockRestore();
    }
  });

  it("keeps the !! prefix so the host excludes the output from context", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness();
      await send(harness.controller, "!!false", 11);

      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({
        text: "!!false",
        label: "!",
      })));
      expect(harness.session.executeBash).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("asks before a destructive command under the dangerous policy", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({ confirmResult: false });
      await send(harness.controller, "!rm -rf /tmp/example", 12);

      expect(harness.confirm).toHaveBeenCalledWith(
        "Run shell command?",
        expect.stringContaining("rm -rf /tmp/example"),
      );
      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("cancelled"))).toBe(true));
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("a refused command edits its confirmation message instead of sending a new one", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({ confirmResult: false });
      await send(harness.controller, "!rm -rf /tmp/example", 12);

      await vi.waitFor(() => expect(harness.calls.some((call) => call.messageId === CONFIRM_MESSAGE_ID)).toBe(true));
      expect(harness.calls).toContainEqual(expect.objectContaining({
        method: "text",
        messageId: CONFIRM_MESSAGE_ID,
        text: expect.stringContaining("✖ Shell command cancelled."),
      }));
      expect(harness.calls.some((call) => call.messageId === undefined && call.text?.includes("cancelled"))).toBe(false);
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("an approved command runs on its confirmation message", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({ confirmResult: true });
      await send(harness.controller, "!rm -rf /tmp/example", 12);

      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({
        text: "!rm -rf /tmp/example",
        reuseMessageId: CONFIRM_MESSAGE_ID,
      })));
    } finally {
      runText.mockRestore();
    }
  });

  it("returns the update handler while a bash confirmation is pending", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const gate = Promise.withResolvers<boolean>();
      const confirm = vi.fn(() => gate.promise);
      const harness = createHarness({ confirm });

      await expect(harness.controller.handleMessage({
        message_id: 16,
        chat: { id: 42, type: "private" },
        from: { id: 7 },
        text: "!rm -rf /tmp/example",
      })).resolves.toBeUndefined();

      expect(confirm).toHaveBeenCalled();
      gate.resolve(false);
      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("cancelled"))).toBe(true));
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("always asks before a safe command", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({
        config: { bashConfirm: "always", activeChatId: 42 },
        confirmResult: false,
      });
      await send(harness.controller, "!echo safe", 14);

      expect(harness.confirm).toHaveBeenCalled();
      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("cancelled"))).toBe(true));
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("never asks before a dangerous command", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({
        config: { bashConfirm: "never", activeChatId: 42 },
      });
      await send(harness.controller, "!rm -rf /tmp/example", 15);

      expect(harness.confirm).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({
        text: "!rm -rf /tmp/example",
      })));
    } finally {
      runText.mockRestore();
    }
  });

  it("rejects shell commands outside private chats", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness();
      await send(harness.controller, "!echo hi", 13, "supergroup");

      expect(runText).not.toHaveBeenCalled();
      expect(harness.calls.some((call) => call.text?.includes("private chats"))).toBe(true);
    } finally {
      runText.mockRestore();
    }
  });

  it("refuses a new ! while a bash command is already running", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({ session: createSession({ isBashRunning: true }) });
      await send(harness.controller, "!ls", 20);

      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("already running"))).toBe(true));
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("submits ! as usual when no bash command is running", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({ session: createSession({ isBashRunning: false }) });
      await send(harness.controller, "!ls", 21);

      await vi.waitFor(() => expect(runText).toHaveBeenCalledWith(expect.objectContaining({ text: "!ls", label: "!" })));
      expect(harness.calls.some((call) => call.text?.includes("already running"))).toBe(false);
    } finally {
      runText.mockRestore();
    }
  });

  it("refuses a dangerous ! while running without asking for confirmation", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    try {
      const harness = createHarness({
        session: createSession({ isBashRunning: true }),
        config: { bashConfirm: "dangerous", activeChatId: 42 },
      });
      await send(harness.controller, "!rm -rf /tmp/example", 22);

      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("already running"))).toBe(true));
      expect(harness.confirm).not.toHaveBeenCalled();
      expect(runText).not.toHaveBeenCalled();
    } finally {
      runText.mockRestore();
    }
  });

  it("refuses a second ! while the first submit has not returned yet", async () => {
    let resolveFirst!: (value: boolean) => void;
    const runText = vi.spyOn(CommandGateway.prototype, "runText")
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(true);
    try {
      const harness = createHarness();
      void send(harness.controller, "!ls a", 30);
      await vi.waitFor(() => expect(runText).toHaveBeenCalledTimes(1));

      await send(harness.controller, "!ls b", 31);
      await vi.waitFor(() => expect(harness.calls.some((call) => call.text?.includes("already running"))).toBe(true));
      expect(runText).toHaveBeenCalledTimes(1);

      resolveFirst(true);
      (harness.session as unknown as Record<string, unknown>).isBashRunning = true;
      await send(harness.controller, "!ls c", 32);
      await vi.waitFor(() => expect(harness.calls.filter((call) => call.text?.includes("already running"))).toHaveLength(2));
      expect(runText).toHaveBeenCalledTimes(1);

      (harness.session as unknown as Record<string, unknown>).isBashRunning = false;
      await send(harness.controller, "!ls d", 33);
      await vi.waitFor(() => expect(runText).toHaveBeenLastCalledWith(expect.objectContaining({ text: "!ls d" })));
      expect(runText).toHaveBeenCalledTimes(2);
    } finally {
      runText.mockRestore();
    }
  });

  it("clears the in-flight mark when the submit throws", async () => {
    const runText = vi.spyOn(CommandGateway.prototype, "runText")
      .mockRejectedValueOnce(new Error("submit failed"))
      .mockResolvedValue(true);
    try {
      const harness = createHarness();
      await send(harness.controller, "!ls a", 40).catch(() => undefined);
      await vi.waitFor(() => expect(runText).toHaveBeenCalledTimes(1));

      await send(harness.controller, "!ls b", 41);
      await vi.waitFor(() => expect(runText).toHaveBeenLastCalledWith(expect.objectContaining({ text: "!ls b" })));
      expect(runText).toHaveBeenCalledTimes(2);
      expect(harness.calls.some((call) => call.text?.includes("already running"))).toBe(false);
    } finally {
      runText.mockRestore();
    }
  });
});

describe("Host capability routing", () => {
  it("hands prompts to the host whenever the bridge serves them", () => {
    const adapter = (host: string, available = true) => ({ isAvailable: () => available, getHost: () => host });
    const asBridge = (value: unknown) => value as unknown as TuiBridgeAdapter; // only the two probed members matter
    // Both hosts: a dialog is recognised from the entry the host asked about, and
    // read from the frame it draws, whatever its fields look like (§4.6.5).
    expect(hostOwnsPrompts(asBridge(adapter("pi")))).toBe(true);
    expect(hostOwnsPrompts(asBridge(adapter("omp")))).toBe(true);
    expect(hostOwnsPrompts(asBridge(adapter("pi", false)))).toBe(false);
  });

  it("still reports to the chat for a command that only notifies while the host owns prompts", async () => {
    // /hotkeys (a native-handler mapping) answers with a single notify and
    // no dialog. With the host owning prompts the command context used to carry the
    // host's raw ui, whose notify only prints in the terminal - so the remote user
    // got nothing at all and the command looked like a hang.
    const terminalPrints: string[] = [];
    const hostUi = {
      notify: vi.fn(async (message: string) => { terminalPrints.push(message); }),
      select: vi.fn(async () => "host_choice"),
    };
    const session = createSession({
      extensionRunner: {
        getUIContext: () => hostUi,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({
          isIdle: () => true,
          waitForIdle: async () => undefined,
          ui: hostUi,
        }),
      },
    });
    const harness = createHarness({
      session,
      bridge: createBridge(),
      config: { bashConfirm: "dangerous", activeChatId: 42 },
      notifySendsToChat: true,
      telegramCommands: new Map<string, any>([
        ["hotkeys", async (_args: string, ctx: any) => {
          await ctx.ui.notify("Changelog: https://example.test/releases", "info");
        }],
      ]),
    });

    await send(harness, "/hotkeys");

    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.text?.includes("Changelog: https://example.test"))).toBe(true);
    });
    // The notice belongs to the Telegram chat that issued the command: the terminal does not print it.
    expect(terminalPrints).toEqual([]);
  });

  const send = async (harness: { controller: { handleMessage(m: unknown): Promise<void> } }, text: string) => {
    await harness.controller.handleMessage({
      message_id: 30,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text,
    });
  };

});
