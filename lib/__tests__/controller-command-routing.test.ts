import { describe, expect, it, vi } from "vitest";
import { createTelegramController, EXPIRED_TUI_CALLBACK_PREFIX, type TelegramController } from "../controller.ts";
import { CommandGateway } from "../tui/gateway.ts";
import { DialogBroker } from "../tui/broker.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import { tuiBridge, type TuiBridgeAdapter } from "../tui-bridge.ts";
import { currentCommandScope } from "../tui/command-context.ts";

type Call = { method: string; text?: string; messageId?: number; toast?: string };

function createTransport(calls: Call[]): TelegramTransport {
  return {
    removeInlineKeyboard: async (_chatId, messageId) => { calls.push({ method: "removeKeyboard", messageId }); },
    sendText: async (_chatId, value) => { calls.push({ method: "text", text: value }); return [{ message_id: 1 }]; },
    sendButtons: async (_chatId, value) => { calls.push({ method: "buttons", text: value }); return { message_id: 2 }; },
    editText: async (_chatId, messageId, value) => { calls.push({ method: "edit", text: value, messageId }); },
    editButtons: async (_chatId, messageId, value) => { calls.push({ method: "buttons", text: value, messageId }); },
    answerCallbackQuery: async (_queryId, toast) => { calls.push({ method: "answer", toast }); },
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
}

function createSession(): CapturedAgentSession {
  return {
    prompt: vi.fn(async () => undefined),
    isStreaming: false,
    extensionRunner: {
      getUIContext: () => undefined,
      setUIContext: () => undefined,
      getCommand: () => undefined,
      createCommandContext: () => ({}),
    },
    isBashRunning: false,
  } as unknown as CapturedAgentSession;
}

function createBridge(overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [{ name: "tools", description: "List tools", source: "builtin" as const }],
    submit: vi.fn(() => true),
    key: vi.fn(() => true),
    write: vi.fn(() => true),
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
    ...overrides,
  };
}

function createHarness(options: {
  bridge?: TuiBridgeAdapter;
  telegramCommands?: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  /** When set, the chat UI's menu() reports this message id to the controller, as telegram-ui does. */
  menuMessageId?: number;
  /** Reports the host as OMP, which runs /new through its native handler. */
  isOmpHost?: () => boolean;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = createSession();
  const bridge = options.bridge ?? createBridge();
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      create: (_chatId: number, _threadId?: number, _sourceId?: number, onMenuMessage?: (messageId: number) => void) => (options.menuMessageId === undefined
        ? { notify: async () => undefined }
        : { notify: async () => undefined, menu: async () => { onMenuMessage?.(options.menuMessageId!); return undefined; } }) as never,
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
    beginTelegramTurn: (chatId) => ({ chatId, queuedAttachments: [] }),
    endTelegramTurn: () => undefined,
    getConfig: () => ({ activeChatId: 42 }) as never,
    tuiBridge: bridge,
    isOmpHost: options.isOmpHost,
  });
  return { controller, calls, session, bridge };
}

const send = async (controller: TelegramController, text: string) => {
  await controller.handleMessage({
    message_id: 30,
    chat: { id: 42, type: "private" },
    from: { id: 7 },
    text,
  });
};

describe("Command routing after the mirror removal (D2)", () => {
  it("routes a catalog host command through the gateway, not the mirror", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({ bridge: createBridge({ submit }) });

    await send(harness.controller, "/tools");

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      name: "tools",
      origin: expect.objectContaining({ chatId: 42 }),
    }));
    // The old mirror path submitted the text to the editor itself and acked
    // with a "TUI command" status message; neither may happen any more.
    expect(submit).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.text?.includes("TUI command"))).toBe(false);
    run.mockRestore();
  });

  it("routes a host-served command to the gateway instead of the native handler", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const nativeSettings = vi.fn(async () => undefined);
    const harness = createHarness({
      bridge: createBridge({ getCommands: async () => [{ name: "settings", description: "Open settings", source: "builtin" as const }] }),
      telegramCommands: new Map([["settings", nativeSettings]]),
    });

    await send(harness.controller, "/settings");

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "settings" }));
    expect(nativeSettings).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("submits the host's own spelling of a command Telegram advertises with an underscore", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const harness = createHarness({
      bridge: createBridge({
        getCommands: async () => [{ name: "scoped-models", description: "Enable/disable models", source: "builtin" as const }],
      }),
    });

    await send(harness.controller, "/scoped_models");

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "scoped-models" }));
    run.mockRestore();
  });

  it("routes /debug to the host gateway, not a plugin handler", async () => {
    // The plugin's /debug was given back to the host: even if a stale plugin
    // handler is still in the map, a host-served /debug must reach the gateway.
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const debugHandler = vi.fn(async () => undefined);
    const harness = createHarness({
      bridge: createBridge({ getCommands: async () => [{ name: "debug", description: "Debug", source: "builtin" as const }] }),
      telegramCommands: new Map([["debug", debugHandler]]),
    });

    await send(harness.controller, "/debug");

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "debug" }));
    expect(debugHandler).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("routes /fork and /clone to the gateway, not the plugin handler", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const fork = vi.fn(async () => undefined);
    const clone = vi.fn(async () => undefined);
    const harness = createHarness({
      bridge: createBridge({
        getCommands: async () => [
          { name: "fork", description: "Fork from a message", source: "builtin" as const },
          { name: "clone", description: "Clone at a message", source: "builtin" as const },
        ],
      }),
      telegramCommands: new Map([["fork", fork], ["clone", clone]]),
    });

    await send(harness.controller, "/fork");
    await send(harness.controller, "/clone m42");

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "fork", args: "" }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "clone", args: "m42" }));
    expect(fork).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers an unknown tg_ command with the /tg notice", async () => {
    const harness = createHarness();

    await send(harness.controller, "/tg_bot_add");

    expect(harness.calls.some((call) => call.text?.includes("Unknown command. Use /tg."))).toBe(true);
  });

  it("answers a stale screen-mirror callback as expired without injecting keys", async () => {
    const key = vi.fn(() => true);
    const write = vi.fn(() => true);
    const harness = createHarness({ bridge: createBridge({ key, write }) });

    await harness.controller.handleCallbackQuery({
      id: "cb-stale",
      data: `${EXPIRED_TUI_CALLBACK_PREFIX}down`,
      message: { message_id: 5, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    expect(harness.calls.some((call) => call.method === "answer" && call.toast === "This button has expired")).toBe(true);
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 5)).toBe(true);
    expect(key).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("§4.5 rule 6: a command settles this chat's open dialog before the gateway", () => {
  const settingsBridge = (overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter => createBridge({
    getCommands: async () => [{ name: "settings", description: "Open settings", source: "builtin" as const }],
    ...overrides,
  });

  it("abandons this chat's open dialog before handing a gateway command to the host", async () => {
    const abandon = vi.spyOn(DialogBroker.prototype, "abandonFor").mockReturnValue({ kind: "closed", title: "Settings" });
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const harness = createHarness({ bridge: settingsBridge() });

    await send(harness.controller, "/settings");

    expect(abandon).toHaveBeenCalledWith(42, undefined);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "settings" }));
    // The Esc must land before the submission - submitting first would queue the
    // command behind the very dialog the chat just abandoned.
    expect(abandon.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    const notice = harness.calls.find((call) => call.text?.includes("Closed the unanswered dialog"));
    expect(notice?.text).toContain("Settings");
    abandon.mockRestore();
    run.mockRestore();
  });

  it("does not hand a gateway command to the host when another chat's dialog blocks it", async () => {
    const abandon = vi.spyOn(DialogBroker.prototype, "abandonFor").mockReturnValue({ kind: "blocked", title: "Confirm" });
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({ bridge: settingsBridge({ submit }) });

    await send(harness.controller, "/settings");

    expect(run).not.toHaveBeenCalled();
    // Treated as handled: the command text may not fall through to the editor either.
    expect(submit).not.toHaveBeenCalled();
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.text?.includes("The terminal has an unanswered dialog"))).toBe(true);
    abandon.mockRestore();
    run.mockRestore();
  });

  it("still runs the gateway command with no notice when no dialog is open", async () => {
    const abandon = vi.spyOn(DialogBroker.prototype, "abandonFor").mockReturnValue({ kind: "nothing" });
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const harness = createHarness({ bridge: settingsBridge() });

    await send(harness.controller, "/settings");

    expect(abandon).toHaveBeenCalledWith(42, undefined);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "settings" }));
    expect(harness.calls.some((call) => call.text?.includes("unanswered dialog"))).toBe(false);
    abandon.mockRestore();
    run.mockRestore();
  });
});

describe("Local TUI submits stay in the terminal", () => {
  const SHARED_STATE_KEY = "__piTelegramPlusTuiBridgeState";

  it("sends nothing to Telegram for a local /model submit through the bridge", async () => {
    // The bridge's shared state is process-wide and already created by the import
    // above, so the fake host is written into that object and restored afterwards.
    const state = (globalThis as unknown as Record<string, Record<string, unknown>>)[SHARED_STATE_KEY];
    const saved = { host: state.host, mode: state.mode, ui: state.ui, editor: state.editor };
    const onSubmit = vi.fn(() => undefined);
    Object.assign(state, { host: "pi", mode: {}, ui: {}, editor: { onSubmit } });
    try {
      const harness = createHarness({ bridge: tuiBridge });

      // The user submits in the terminal; the host's own editor handles it.
      (state.editor as { onSubmit: (text: string) => unknown }).onSubmit("/model");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onSubmit).toHaveBeenCalledWith("/model");
      expect(harness.calls).toEqual([]);
    } finally {
      Object.assign(state, saved);
    }
  });
});

describe("Terminal-only commands from Telegram", () => {
  it("answers /open and /dump with the terminal hint and never reaches the host", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createBridge({
        submit,
        getCommands: async () => [
          { name: "open", description: "Open a file", source: "builtin" as const },
          { name: "dump", description: "Dump output", source: "builtin" as const },
        ],
      }),
    });

    await send(harness.controller, "/open");
    await send(harness.controller, "/dump");

    expect(harness.calls.filter((call) => call.text === "/open only works in the terminal.")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.text === "/dump only works in the terminal.")).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers a suffixed terminal-only command such as /git:foo with the terminal hint", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "git", description: "Git", source: "builtin" as const }],
      }),
    });

    await send(harness.controller, "/git:foo");

    expect(harness.calls.some((call) => call.text === "/git:foo only works in the terminal.")).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers /mcp and /mcp add with the terminal hint and never reaches the host", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "mcp", description: "Manage MCP servers", source: "builtin" as const }],
      }),
    });

    await send(harness.controller, "/mcp");
    await send(harness.controller, "/mcp add");

    expect(harness.calls.filter((call) => call.text === "/mcp only works in the terminal.")).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers /context with and without arguments with the terminal hint and never reaches the host", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "context", description: "Show context usage", source: "builtin" as const }],
      }),
    });

    await send(harness.controller, "/context");
    await send(harness.controller, "/context detail");

    expect(harness.calls.filter((call) => call.text === "/context only works in the terminal.")).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers /tree and /copy with the terminal hint and never reaches the host", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createBridge({
        submit,
        getCommands: async () => [
          { name: "tree", description: "Navigate session tree", source: "builtin" as const },
          { name: "copy", description: "Copy last message", source: "builtin" as const },
        ],
      }),
    });

    await send(harness.controller, "/tree");
    await send(harness.controller, "/copy");

    expect(harness.calls.filter((call) => call.text === "/tree only works in the terminal.")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.text === "/copy only works in the terminal.")).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("answers /cd on OMP with the /move hint and does not dispatch it", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const submit = vi.fn(() => true);
    const nativeCd = vi.fn(async () => undefined);
    const harness = createHarness({
      bridge: createBridge({ getHost: () => "omp", submit }),
      telegramCommands: new Map([["cd", nativeCd]]),
    });

    await send(harness.controller, "/cd /tmp");

    // HTML parse mode: the angle brackets in <path> arrive escaped.
    expect(harness.calls.some((call) => call.text?.includes("On OMP, use /move &lt;path&gt; to change the working directory."))).toBe(true);
    expect(nativeCd).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    run.mockRestore();
  });

  it("still routes /cd on pi to its own handler", async () => {
    const nativeCd = vi.fn(async () => undefined);
    const harness = createHarness({ telegramCommands: new Map([["cd", nativeCd]]) });

    await send(harness.controller, "/cd /tmp");

    expect(nativeCd).toHaveBeenCalledTimes(1);
    expect(harness.calls.some((call) => call.text?.includes("only works in the terminal"))).toBe(false);
  });
});

describe("Colon-suffixed host commands (/force:read)", () => {
  const SHARED_STATE_KEY = "__piTelegramPlusTuiBridgeState";

  it("hands /force:read to the host editor as typed, not as a prompt", async () => {
    // The gateway needs a captured host editor; write a fake one into the shared
    // bridge state and restore it afterwards, as the local TUI test does.
    const state = (globalThis as unknown as Record<string, Record<string, unknown>>)[SHARED_STATE_KEY];
    const saved = { host: state.host, mode: state.mode, ui: state.ui, editor: state.editor };
    Object.assign(state, { host: "omp", mode: {}, ui: {}, editor: { onSubmit: vi.fn(() => undefined) } });
    try {
      const submit = vi.fn(() => true);
      const harness = createHarness({
        bridge: createBridge({
          submit,
          getHost: () => "omp",
          getCommands: async () => [{ name: "force", description: "Force the next turn", source: "builtin" as const }],
        }),
      });

      await send(harness.controller, "/force:read check hello.txt");

      expect(submit).toHaveBeenCalledWith("/force:read check hello.txt");
      expect(harness.session.prompt).not.toHaveBeenCalled();
    } finally {
      Object.assign(state, saved);
    }
  });

  it("keeps the old behaviour when the host has no command for the base name", async () => {
    const state = (globalThis as unknown as Record<string, Record<string, unknown>>)[SHARED_STATE_KEY];
    const saved = { host: state.host, mode: state.mode, ui: state.ui, editor: state.editor };
    Object.assign(state, { host: "omp", mode: {}, ui: {}, editor: { onSubmit: vi.fn(() => undefined) } });
    try {
      const submit = vi.fn(() => true);
      const harness = createHarness({
        bridge: createBridge({
          submit,
          getHost: () => "omp",
          getCommands: async () => [{ name: "force", description: "Force the next turn", source: "builtin" as const }],
        }),
      });

      await send(harness.controller, "/nosuch:thing hi");

      expect(submit).not.toHaveBeenCalled();
      expect(harness.session.prompt).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(state, saved);
    }
  });
});

describe("Plugin command scope without an ack (P3)", () => {
  it("runs a plugin command that has no ack inside its own command scope", async () => {
    const seen: Array<{ chatId?: number } | undefined> = [];
    const tg = vi.fn(async () => {
      seen.push(currentCommandScope()?.origin);
    });
    const harness = createHarness({ telegramCommands: new Map([["tg", tg]]) });

    await send(harness.controller, "/tg");

    await vi.waitFor(() => expect(tg).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([expect.objectContaining({ chatId: 42 })]);
  });
});

describe("/tg menu message is the command scope's message (P18)", () => {
  it("a menu page /tg sends becomes the scope's message, so the dialogs it opens draw on it", async () => {
    let scopeSeen: { telegramMessageId?: number } | undefined;
    const tg = vi.fn(async (_args: string, ctx: unknown) => {
      scopeSeen = currentCommandScope();
      await (ctx as { ui: { menu: (title: string, options: string[], body?: string) => Promise<unknown> } }).ui.menu("🤖 Bots", ["Back"], "body");
    });
    const harness = createHarness({ telegramCommands: new Map([["tg", tg]]), menuMessageId: 77 });
    // A host UI context is present, so the /tg scope exists (host prompts mode).
    (harness.session.extensionRunner as unknown as { createCommandContext: () => unknown }).createCommandContext = () => ({ ui: {} });

    await send(harness.controller, "/tg");

    await vi.waitFor(() => expect(tg).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(scopeSeen?.telegramMessageId).toBe(77));
  });
});

describe("Host-control commands are one command, one message (P20, P2-35)", () => {
  it("/new on OMP sends one ack message, and its confirmation and result are written onto it", async () => {
    const handler = vi.fn(async () => undefined);
    const harness = createHarness({
      telegramCommands: new Map([["new", handler]]),
      isOmpHost: () => true,
    });

    await send(harness.controller, "/new");

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const texts = harness.calls.filter((call) => call.method === "text");
    expect(texts.map((call) => call.text)).toEqual(["<b>▶️ /new</b>"]);
  });

  it("/hotkeys sends one message, the ack, not a second message for its output", async () => {
    const handler = vi.fn(async () => undefined);
    const harness = createHarness({ telegramCommands: new Map([["hotkeys", handler]]) });

    await send(harness.controller, "/hotkeys");

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const texts = harness.calls.filter((call) => call.method === "text");
    expect(texts.map((call) => call.text)).toEqual(["<b>▶️ /hotkeys</b>"]);
  });
});

describe("host turns started by a Telegram command (#61, #60)", () => {
  it("a command routed to the host makes its message the origin of the host-started turns", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const harness = createHarness({ bridge: createBridge() });

    await harness.controller.handleMessage({
      message_id: 55,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/tools",
    });

    expect(run).toHaveBeenCalled();
    expect(harness.controller.hostOriginTurn()).toEqual(expect.objectContaining({ chatId: 42, sourceMessageId: 55 }));
    run.mockRestore();
  });
});
