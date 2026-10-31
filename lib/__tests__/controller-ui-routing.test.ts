import { describe, expect, it, vi } from "vitest";
import { decodeUiCallback } from "../callback-protocol.ts";
import { createTelegramController } from "../controller.ts";
import type { TelegramCommandHandler } from "../controller.ts";
import { isRoutedUi, setRunnerUiContext } from "../pi-compat.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

function createTransport(sent: Array<{ chatId: number; text: string; rows?: Array<Array<{ text: string; value: string }>>; messageThreadId?: number; replyToMessageId?: number; message_id?: number }>): TelegramTransport {
  return {
    removeInlineKeyboard: vi.fn(async () => undefined),
    sendText: vi.fn(async (chatId, text, messageThreadId, replyToMessageId) => {
      const message_id = sent.length + 1;
      sent.push({ chatId, text, messageThreadId, replyToMessageId, message_id });
      return [{ message_id }];
    }),
    sendButtons: vi.fn(async (chatId, text, rows, messageThreadId, replyToMessageId) => {
      const message_id = sent.length + 1;
      sent.push({ chatId, text, rows, messageThreadId, replyToMessageId, message_id });
      return { message_id };
    }),
    editText: vi.fn(async () => undefined),
    editButtons: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => undefined),
    sendPhoto: vi.fn(async () => undefined),
    sendChatAction: vi.fn(async () => undefined),
  };
}

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// v6 gates every host command behind the bridge; the routing tests below run
// with it up (which also selects host-prompt mode, the mode the leak lived in).
function availableBridge(): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi" as const,
    getCommands: async () => [],
    submit: () => false,
    key: () => false,
    write: () => false,
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
  };
}

// Real hosts hand out a fresh command context per command; the UI swap
// redefines `ui` on it in place, so a shared double would leak one command's
// wrapper into another command's handler.
function makeCommandContext(getUi: () => unknown, getMode: () => string): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    isIdle: () => false,
    waitForIdle: async () => undefined,
  };
  Object.defineProperty(ctx, "ui", { get: getUi, configurable: true });
  Object.defineProperty(ctx, "mode", { get: getMode, configurable: true });
  return ctx;
}

describe("Telegram controller UI routing", () => {
  it("keeps overlapping Telegram command UIs isolated by chat", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = { notify: async (message: string) => { tuiNotifications.push(message); } };
    let currentUi: unknown = tuiUi;
    let activeMode = "tui";
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
        getCommand: () => undefined,
        createCommandContext: () => makeCommandContext(() => currentUi, () => activeMode),
      },
    } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const a = defer();
    const b = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["status", async (_args, ctx) => {
        await ctx.ui.notify("A start");
        await a.promise;
        await ctx.ui.notify("A end");
      }],
      ["cwd", async (_args, ctx) => {
        await ctx.ui.notify("B start");
        await b.promise;
        await ctx.ui.notify("B end");
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
      tuiBridge: availableBridge(),
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 111 }, from: { id: 1 }, text: "/status" });
    await controller.handleMessage({ message_id: 2, chat: { id: 222 }, from: { id: 1 }, text: "/cwd" });
    await new Promise((r) => setTimeout(r, 0));
    a.resolve();
    await new Promise((r) => setTimeout(r, 0));
    b.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("A start") }),
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("A end") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("B start") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("B end") }),
    ]));
    expect(sent.find((item) => item.chatId === 111 && item.text.includes("B "))).toBeUndefined();
    expect(sent.find((item) => item.chatId === 222 && item.text.includes("A "))).toBeUndefined();
    // Host mode prints notifications on the terminal as well as in the chat by
    // design (see createHostPromptUi); the isolation point is that each copy
    // reaches its OWN chat and never the other one.
    expect(tuiNotifications).toEqual(["A start", "B start", "A end", "B end"]);
    expect(currentUi).toBe(tuiUi);
    expect(activeMode).toBe("tui");
  });

  it("routes a runner notify outside any Telegram turn to the host UI, not a chat", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = { notify: async (message: string) => { tuiNotifications.push(message); } };
    let currentUi: unknown = tuiUi;
    let activeMode = "tui";
    const runner = {
      getUIContext: () => currentUi,
      setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
      getCommand: () => undefined,
      createCommandContext: () => makeCommandContext(() => currentUi, () => activeMode),
    };
    const session = { extensionRunner: runner } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const hold = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["status", async (_args, ctx) => {
        await ctx.ui.notify("A running");
        await hold.promise;
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
      tuiBridge: availableBridge(),
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 111 }, from: { id: 1 }, text: "/status" });
    await vi.waitFor(() => expect(currentUi).not.toBe(tuiUi));

    // A local terminal call while the command holds the UI: no Telegram turn is
    // active, so it must land on the host UI and never on the waiting chat.
    const hostUi = runner.getUIContext() as { notify(message: string): Promise<unknown> };
    await hostUi.notify("local terminal notify");
    expect(tuiNotifications).toContain("local terminal notify");
    expect(sent.find((item) => item.text.includes("local terminal notify"))).toBeUndefined();

    hold.resolve();
    await vi.waitFor(() => expect(currentUi).toBe(tuiUi));
    expect(activeMode).toBe("tui");
  });

  it("keeps nested same-chat command notifications on that chat and restores the host UI", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiUi = { notify: async () => undefined };
    let currentUi: unknown = tuiUi;
    let activeMode = "tui";
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
        getCommand: () => undefined,
        createCommandContext: () => makeCommandContext(() => currentUi, () => activeMode),
      },
    } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const a = defer();
    const b = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["status", async (_args, ctx) => {
        await ctx.ui.notify("n1 start");
        await a.promise;
        await ctx.ui.notify("n1 end");
      }],
      ["cwd", async (_args, ctx) => {
        await ctx.ui.notify("n2 start");
        await b.promise;
        await ctx.ui.notify("n2 end");
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => ({ chatId, messageThreadId, sourceMessageId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
      tuiBridge: availableBridge(),
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 555 }, from: { id: 1 }, text: "/status" });
    await controller.handleMessage({ message_id: 2, chat: { id: 555 }, from: { id: 1 }, text: "/cwd" });
    await new Promise((r) => setTimeout(r, 0));
    a.resolve();
    await new Promise((r) => setTimeout(r, 0));
    b.resolve();
    await new Promise((r) => setTimeout(r, 0));

    for (const text of ["n1 start", "n1 end", "n2 start", "n2 end"]) {
      const hits = sent.filter((item) => item.text.includes(text));
      expect(hits.length).toBe(1);
      expect(hits[0]!.chatId).toBe(555);
    }
    expect(currentUi).toBe(tuiUi);
    expect(activeMode).toBe("tui");
  });

  it("keeps overlapping Telegram command UIs isolated by thread inside the same chat", async () => {
    const sent: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }> = [];
    const transport = createTransport(sent);
    const tuiUi = { notify: async () => undefined };
    let currentUi: any = tuiUi;
    const commandCtx: any = { isIdle: () => false, waitForIdle: async () => undefined };
    Object.defineProperty(commandCtx, "ui", { get: () => currentUi });
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown) => { currentUi = ui; },
        getCommand: () => undefined,
        createCommandContext: () => commandCtx,
      },
    } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const a = defer();
    const b = defer();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["cwd", async (_args, ctx) => {
        await ctx.ui.notify("A topic start");
        await a.promise;
        // This runs while B is still on top of the global routed UI stack; it
        // must still route through A's earlier proxy to topic 10, not B/topic 20.
        await ctx.ui.notify("A topic after B stacked");
      }],
      ["cd", async (_args, ctx) => { await ctx.ui.notify("B topic"); await b.promise; }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => ({ chatId, messageThreadId, sourceMessageId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 101, message_thread_id: 10, chat: { id: 111 }, from: { id: 1 }, text: "/cwd" });
    await controller.handleMessage({ message_id: 201, message_thread_id: 20, chat: { id: 111 }, from: { id: 1 }, text: "/cd" });
    await new Promise((r) => setTimeout(r, 0));
    a.resolve();
    await new Promise((r) => setTimeout(r, 0));
    b.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 101, text: expect.stringContaining("A topic start") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 101, text: expect.stringContaining("A topic after B stacked") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20, replyToMessageId: 201, text: expect.stringContaining("B topic") }),
    ]));
    expect(sent.find((item) => item.messageThreadId === 10 && item.text.includes("B topic"))).toBeUndefined();
    expect(sent.find((item) => item.messageThreadId === 20 && item.text.includes("A topic"))).toBeUndefined();
  });

  it("routes local TUI calls to the original TUI while a Telegram command hold is in its grace window", async () => {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = { notify: async (message: string) => { tuiNotifications.push(message); } };
    let currentUi: any = tuiUi;
    let activeMode = "tui";
    let idle = true;
    const wait = defer();
    const commandCtx: any = {
      isIdle: () => idle,
      waitForIdle: () => wait.promise,
    };
    Object.defineProperty(commandCtx, "ui", { get: () => currentUi });
    Object.defineProperty(commandCtx, "mode", { get: () => activeMode });
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown, mode?: string) => { currentUi = ui; if (mode) activeMode = mode; },
        getCommand: () => undefined,
        createCommandContext: () => commandCtx,
      },
    } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["status", async (_args, ctx) => {
        await ctx.ui.notify("telegram command started");
        idle = false;
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 555 }, from: { id: 1 }, text: "/status" });
    await new Promise((r) => setTimeout(r, 10));
    expect(currentUi).not.toBe(tuiUi);

    idle = true;
    wait.resolve();
    await new Promise((r) => setTimeout(r, 10));
    await currentUi.notify("local task notification");

    expect(tuiNotifications).toEqual(["local task notification"]);
    expect(sent.find((item) => item.text.includes("local task notification"))).toBeUndefined();

    await new Promise((r) => setTimeout(r, 180));
    expect(currentUi).toBe(tuiUi);
    expect(activeMode).toBe("tui");
  });

// Mirrors Pi 0.85 prompt wrapping because ExtensionRunner has no stable public test constructor.
type UiPromptEvent =
  | { type: "ui_prompt_start"; reason: "ui_prompt"; kind: string; title?: string }
  | { type: "ui_prompt_end"; reason: "ui_prompt"; kind: string; title?: string };

class Pi085RunnerDouble {
  public uiContext: any;
  public mode = "print";
  public emittedEvents: UiPromptEvent[] = [];
  private uiPromptDepth = 0;
  private activeUIPrompt?: { kind: string; title?: string };

  constructor(initialUi?: any, initialMode = "tui") {
    if (initialUi) {
      this.setUIContext(initialUi, initialMode);
    }
  }

  emit(event: UiPromptEvent): void {
    this.emittedEvents.push(event);
  }

  private emitUIPromptEvent(event: UiPromptEvent): void {
    queueMicrotask(() => {
      this.emit(event);
    });
  }

  withUIPrompt<T>(kind: string, title: string | undefined, run: () => Promise<T>): Promise<T> {
    const outerPrompt = this.uiPromptDepth++ === 0;
    if (outerPrompt) {
      this.activeUIPrompt = { kind, title };
      this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
    }
    const finish = () => {
      if (--this.uiPromptDepth > 0) return;
      this.uiPromptDepth = 0;
      const prompt = this.activeUIPrompt ?? { kind, title };
      this.activeUIPrompt = undefined;
      this.emitUIPromptEvent({
        type: "ui_prompt_end",
        reason: "ui_prompt",
        kind: prompt.kind,
        ...(prompt.title ? { title: prompt.title } : {}),
      });
    };
    try {
      return run().finally(finish);
    } catch (err) {
      finish();
      throw err;
    }
  }

  wrapUIPromptContext(ui: any): any {
    return {
      ...ui,
      select: (title: string, options: any, opts?: any) =>
        this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
      confirm: (title: string, message: any, opts?: any) =>
        this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
      input: (title: string, placeholder: any, opts?: any) =>
        this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
      editor: (title: string, prefill: any) =>
        this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
      custom: (factory: any, options: any) =>
        this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
    };
  }

  setUIContext(uiContext: any, mode = "print"): void {
    this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : undefined;
    this.mode = mode;
  }

  getUIContext(): any {
    return this.uiContext;
  }

  createCommandContext(): any {
    const self = this;
    const ctx: any = {
      isIdle: () => true,
      waitForIdle: async () => undefined,
    };
    Object.defineProperty(ctx, "ui", { get: () => self.uiContext });
    Object.defineProperty(ctx, "mode", { get: () => self.mode });
    return ctx;
  }

  getCommand(): undefined {
    return undefined;
  }
}

  it("preserves prompt lifecycle events, property spread, and dynamic routing under Pi 0.85 prompt wrapping", async () => {
    const sent: Array<{ chatId: number; text: string; rows?: Array<Array<{ text: string; value: string }>>; messageThreadId?: number; replyToMessageId?: number; message_id?: number }> = [];
    const transport = createTransport(sent);
    const tuiNotifications: string[] = [];
    const tuiUi = {
      notify: vi.fn(async (message: string) => {
        tuiNotifications.push(message);
      }),
      setStatus: vi.fn(),
      select: vi.fn(async () => "tui_selected"),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "tui_input"),
      editor: vi.fn(async () => "tui_editor"),
      custom: vi.fn(async () => "tui_custom"),
      get theme() {
        return { fg: () => "" };
      },
    };

    const runner = new Pi085RunnerDouble(tuiUi, "tui");
    const originalUiContext = runner.getUIContext();
    const session = { extensionRunner: runner } as any;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });

    let commandExecuted = false;
    let commandError: Error | undefined;

    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>([
      ["pair", async (_args, ctx) => {
        try {
          const spreadUi = { ...ctx.ui };
          expect(typeof spreadUi.notify).toBe("function");
          expect(typeof spreadUi.setStatus).toBe("function");
          expect(typeof spreadUi.select).toBe("function");
          expect(typeof spreadUi.confirm).toBe("function");
          expect(typeof spreadUi.input).toBe("function");
          expect(typeof spreadUi.editor).toBe("function");
          expect(typeof spreadUi.custom).toBe("function");
          expect(spreadUi.theme).toBeDefined();

          await spreadUi.notify("Spread notify works", "info");
          await ctx.ui.notify("Command executed successfully", "info");

          const promptPromise = ctx.ui.confirm("Prompt Title", "Proceed with operation?");
          while (!uiRuntime.hasPendingInput(777)) {
            await new Promise((r) => setTimeout(r, 5));
          }
          const sentConfirm = sent.filter((item) => item.text.includes("Prompt Title")).at(-1);
          expect(sentConfirm).toBeDefined();
          const rawCallback = sentConfirm?.rows?.[0]?.[0]?.value ?? "";
          const callbackValue = decodeUiCallback(rawCallback) ?? rawCallback;
          const resolveResult = uiRuntime.resolveInput(777, callbackValue, sentConfirm!.message_id, true);
          expect(resolveResult.handled).toBe(true);
          const confirmResult = await promptPromise;
          expect(confirmResult).toBe(true);

          commandExecuted = true;
        } catch (err) {
          commandError = err as Error;
          throw err;
        }
      }],
    ]);

    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 777 }, from: { id: 1 }, text: "/pair" });
    await new Promise((r) => setTimeout(r, 80));

    expect(commandError).toBeUndefined();
    expect(commandExecuted).toBe(true);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 777, text: expect.stringContaining("Spread notify works") }),
      expect.objectContaining({ chatId: 777, text: expect.stringContaining("Command executed successfully") }),
    ]));

    expect(runner.emittedEvents).toEqual([
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Prompt Title" },
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Prompt Title" },
    ]);

    expect(tuiNotifications).toEqual([]);
    expect(tuiUi.confirm).not.toHaveBeenCalled();

    // After command completion and grace window, runner must restore the exact pre-turn UI context identity
    await new Promise((r) => setTimeout(r, 180));
    expect(runner.mode).toBe("tui");
    expect(isRoutedUi(runner.uiContext)).toBe(false);
    expect(runner.getUIContext()).toBe(originalUiContext);

    await runner.uiContext.notify("Local TUI notification after turn");
    expect(tuiNotifications).toEqual(["Local TUI notification after turn"]);
    expect(sent.find((item) => item.text.includes("Local TUI notification after turn"))).toBeUndefined();

    await runner.uiContext.confirm("Local Prompt", "TUI dialog");
    expect(tuiUi.confirm).toHaveBeenCalledWith("Local Prompt", "TUI dialog", undefined);
    expect(runner.emittedEvents).toEqual(expect.arrayContaining([
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Local Prompt" },
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Local Prompt" },
    ]));
    expect(sent.find((item) => item.text.includes("Local Prompt"))).toBeUndefined();

    // Running a subsequent Telegram command must also restore the exact original UI context
    await controller.handleMessage({ message_id: 2, chat: { id: 777 }, from: { id: 1 }, text: "/pair" });
    await new Promise((r) => setTimeout(r, 80));
    await new Promise((r) => setTimeout(r, 180));
    expect(runner.getUIContext()).toBe(originalUiContext);
    expect(runner.mode).toBe("tui");
  });

  it("executes all prompt methods through Pi 0.85 prompt lifecycle wrapping and preserves object spread", async () => {
    const runner = new Pi085RunnerDouble();

    const underlyingCalls: Record<string, { args: any[]; count: number }> = {
      select: { args: [], count: 0 },
      confirm: { args: [], count: 0 },
      input: { args: [], count: 0 },
      editor: { args: [], count: 0 },
      custom: { args: [], count: 0 },
      notify: { args: [], count: 0 },
      setStatus: { args: [], count: 0 },
      setWorkingMessage: { args: [], count: 0 },
    };

    const targetUi: any = {
      select: vi.fn(async (title: string, options: any, opts?: any) => {
        underlyingCalls.select.count++;
        underlyingCalls.select.args = [title, options, opts];
        return "selected-val";
      }),
      confirm: vi.fn(async (title: string, message: any, opts?: any) => {
        underlyingCalls.confirm.count++;
        underlyingCalls.confirm.args = [title, message, opts];
        return true;
      }),
      input: vi.fn(async (title: string, placeholder: any, opts?: any) => {
        underlyingCalls.input.count++;
        underlyingCalls.input.args = [title, placeholder, opts];
        return "input-val";
      }),
      editor: vi.fn(async (title: string, prefill: any) => {
        underlyingCalls.editor.count++;
        underlyingCalls.editor.args = [title, prefill];
        return "editor-val";
      }),
      custom: vi.fn(async (factory: any, options: any) => {
        underlyingCalls.custom.count++;
        underlyingCalls.custom.args = [factory, options];
        return "custom-val";
      }),
      notify: vi.fn((message: string, level?: string) => {
        underlyingCalls.notify.count++;
        underlyingCalls.notify.args = [message, level];
      }),
      setStatus: vi.fn((status: string) => {
        underlyingCalls.setStatus.count++;
        underlyingCalls.setStatus.args = [status];
      }),
      setWorkingMessage: vi.fn((message: string) => {
        underlyingCalls.setWorkingMessage.count++;
        underlyingCalls.setWorkingMessage.args = [message];
      }),
      theme: { fg: () => "green" },
    };

    const routedUi = new Proxy(targetUi, {
      get(target, prop, receiver) {
        if (prop === "__piTelegramPlusRoutedUi") return true;
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    setRunnerUiContext(runner, routedUi, "rpc");
    const activeUi: any = runner.getUIContext();

    const customFactory = vi.fn();
    const promptCases = [
      {
        name: "select",
        kind: "select",
        title: "Select Title",
        invoke: (ui: any) => ui.select("Select Title", ["opt1", "opt2"], { timeout: 100 }),
        expectedResult: "selected-val",
        expectedArgs: ["Select Title", ["opt1", "opt2"], { timeout: 100 }],
      },
      {
        name: "confirm",
        kind: "confirm",
        title: "Confirm Title",
        invoke: (ui: any) => ui.confirm("Confirm Title", "Are you sure?", { default: true }),
        expectedResult: true,
        expectedArgs: ["Confirm Title", "Are you sure?", { default: true }],
      },
      {
        name: "input",
        kind: "input",
        title: "Input Title",
        invoke: (ui: any) => ui.input("Input Title", "placeholder text", { secure: false }),
        expectedResult: "input-val",
        expectedArgs: ["Input Title", "placeholder text", { secure: false }],
      },
      {
        name: "editor",
        kind: "editor",
        title: "Editor Title",
        invoke: (ui: any) => ui.editor("Editor Title", "prefilled code"),
        expectedResult: "editor-val",
        expectedArgs: ["Editor Title", "prefilled code"],
      },
      {
        name: "custom",
        kind: "custom",
        title: undefined,
        invoke: (ui: any) => ui.custom(customFactory, { extra: 1 }),
        expectedResult: "custom-val",
        expectedArgs: [customFactory, { extra: 1 }],
      },
    ];

    for (const testCase of promptCases) {
      runner.emittedEvents = [];
      const result = await testCase.invoke(activeUi);
      expect(result).toBe(testCase.expectedResult);
      expect(underlyingCalls[testCase.name].count).toBe(1);
      expect(underlyingCalls[testCase.name].args).toEqual(testCase.expectedArgs);

      // Microtasks must flush for queued prompt event emissions
      await new Promise((r) => setTimeout(r, 0));
      expect(runner.emittedEvents).toEqual([
        {
          type: "ui_prompt_start",
          reason: "ui_prompt",
          kind: testCase.kind,
          ...(testCase.title ? { title: testCase.title } : {}),
        },
        {
          type: "ui_prompt_end",
          reason: "ui_prompt",
          kind: testCase.kind,
          ...(testCase.title ? { title: testCase.title } : {}),
        },
      ]);
    }

    const spreadUi = { ...activeUi };

    spreadUi.notify("test message", "warning");
    expect(underlyingCalls.notify.count).toBe(1);
    expect(underlyingCalls.notify.args).toEqual(["test message", "warning"]);

    spreadUi.setStatus("busy");
    expect(underlyingCalls.setStatus.count).toBe(1);
    expect(underlyingCalls.setStatus.args).toEqual(["busy"]);

    spreadUi.setWorkingMessage("processing...");
    expect(underlyingCalls.setWorkingMessage.count).toBe(1);
    expect(underlyingCalls.setWorkingMessage.args).toEqual(["processing..."]);

    expect(spreadUi.theme.fg()).toBe("green");

    for (const testCase of promptCases) {
      runner.emittedEvents = [];
      underlyingCalls[testCase.name].count = 0;
      const result = await testCase.invoke(spreadUi);
      expect(result).toBe(testCase.expectedResult);
      expect(underlyingCalls[testCase.name].count).toBe(1);
      await new Promise((r) => setTimeout(r, 0));
      expect(runner.emittedEvents).toEqual([
        {
          type: "ui_prompt_start",
          reason: "ui_prompt",
          kind: testCase.kind,
          ...(testCase.title ? { title: testCase.title } : {}),
        },
        {
          type: "ui_prompt_end",
          reason: "ui_prompt",
          kind: testCase.kind,
          ...(testCase.title ? { title: testCase.title } : {}),
        },
      ]);
    }
  });

  it("routes command prompts to Telegram when the runner has no setUIContext (OMP)", async () => {
    const sent: Array<{ chatId: number; text: string; rows?: Array<Array<{ text: string; value: string }>>; messageThreadId?: number; replyToMessageId?: number; message_id?: number }> = [];
    const transport = createTransport(sent);
    const tuiConfirm = vi.fn(async () => true);
    const tuiUi = {
      notify: vi.fn(async () => undefined),
      confirm: tuiConfirm,
    };
    const newSession = vi.fn(async () => ({ cancelled: false }));
    // Partial command context: only the fields this handler and the dispatcher read.
    const commandCtx = {
      ui: tuiUi,
      isIdle: () => false,
      waitForIdle: async () => undefined,
      newSession,
    };
    // OMP runner shape: getUIContext()/createCommandContext() only, no setUIContext().
    const session = {
      extensionRunner: {
        getUIContext: () => tuiUi,
        createContext: () => ({ ui: tuiUi }),
        createCommandContext: () => commandCtx,
        getCommand: () => undefined,
      },
    } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const commands = new Map<string, TelegramCommandHandler>([
      ["pair", async (_args, ctx) => {
        const confirmed = await ctx.ui.confirm("New session", "Start a new session? Current session will be saved.");
        if (!confirmed) return;
        await ctx.newSession();
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 777 }, from: { id: 1 }, text: "/pair" });
    await vi.waitFor(() => expect(uiRuntime.hasPendingInput(777)).toBe(true));

    const sentConfirm = sent.find((item) => item.text.includes("New session"));
    expect(sentConfirm).toBeDefined();
    expect(tuiConfirm).not.toHaveBeenCalled();
    expect(sentConfirm?.rows?.[0]?.map((button) => button.text)).toEqual(["Yes", "No", "Cancel"]);

    const rawCallback = sentConfirm?.rows?.[0]?.[0]?.value ?? "";
    const callbackValue = decodeUiCallback(rawCallback) ?? rawCallback;
    const resolveResult = uiRuntime.resolveInput(777, callbackValue, sentConfirm?.message_id, true);
    expect(resolveResult.handled).toBe(true);

    await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    expect(tuiConfirm).not.toHaveBeenCalled();
  });

  it("routes runner getUIContext/createContext dialogs to Telegram on OMP", async () => {
    const sent: Array<{ chatId: number; text: string; rows?: Array<Array<{ text: string; value: string }>>; messageThreadId?: number; replyToMessageId?: number; message_id?: number }> = [];
    const transport = createTransport(sent);
    const tuiConfirm = vi.fn(async (_title: string, _message: string) => true);
    const tuiSelect = vi.fn(async (_title: string, _options: string[]) => "TUI choice");
    const tuiUi = {
      notify: vi.fn(async () => undefined),
      confirm: tuiConfirm,
      select: tuiSelect,
    };
    // Partial command context: only the fields the dispatcher reads.
    const commandCtx = {
      ui: tuiUi,
      isIdle: () => false,
      waitForIdle: async () => undefined,
    };
    // OMP runner shape: no setUIContext(); agent/tool/hook dialogs read these two methods.
    const runner = {
      getUIContext: () => tuiUi,
      createContext: () => ({ ui: tuiUi }),
      createCommandContext: () => commandCtx,
      getCommand: () => undefined,
    };
    const session = { extensionRunner: runner } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const observed: Array<string | undefined> = [];
    const commands = new Map<string, TelegramCommandHandler>([
      ["status", async () => {
        const approved = await runner.getUIContext().confirm("Tool approval", "Allow write?");
        observed.push(approved ? "approved" : "denied");
        const hookCtx = runner.createContext();
        observed.push(await hookCtx.ui.select("Hook question", ["One", "Two"]));
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 888 }, from: { id: 1 }, text: "/status" });

    await vi.waitFor(() => expect(sent.find((item) => item.text.includes("Tool approval"))).toBeDefined());
    const approval = sent.find((item) => item.text.includes("Tool approval"));
    expect(tuiConfirm).not.toHaveBeenCalled();
    expect(approval?.rows?.[0]?.map((button) => button.text)).toEqual(["Yes", "No", "Cancel"]);
    const approvalCallback = decodeUiCallback(approval?.rows?.[0]?.[0]?.value ?? "") ?? "";
    expect(uiRuntime.resolveInput(888, approvalCallback, approval?.message_id, true).handled).toBe(true);

    await vi.waitFor(() => expect(sent.find((item) => item.text.includes("Hook question"))).toBeDefined());
    const hook = sent.find((item) => item.text.includes("Hook question"));
    expect(tuiSelect).not.toHaveBeenCalled();
    const hookCallback = decodeUiCallback(hook?.rows?.[0]?.[0]?.value ?? "") ?? "";
    expect(uiRuntime.resolveInput(888, hookCallback, hook?.message_id, true).handled).toBe(true);

    await vi.waitFor(() => expect(observed).toEqual(["approved", "One"]));
    expect(tuiConfirm).not.toHaveBeenCalled();
    expect(tuiSelect).not.toHaveBeenCalled();

    // The patch is permanent per runner but falls back to the host UI once the
    // Telegram turn's stack entry is gone.
    await vi.waitFor(() => expect(runner.getUIContext()).toBe(tuiUi));
    await runner.getUIContext().confirm("Local dialog", "local?");
    expect(tuiConfirm).toHaveBeenCalledWith("Local dialog", "local?");
  });

  it("routes built-in ask and eval-prelude tool contexts to Telegram on OMP", async () => {
    const sent: Array<{ chatId: number; text: string; rows?: Array<Array<{ text: string; value: string }>>; messageThreadId?: number; replyToMessageId?: number; message_id?: number }> = [];
    const transport = createTransport(sent);
    const tuiConfirm = vi.fn(async (_title: string, _message: string) => true);
    const tuiUi = {
      notify: vi.fn(async () => undefined),
      confirm: tuiConfirm,
    };
    const observed: string[] = [];
    const toolSession = {
      getToolContext: (): { ui: typeof tuiUi; hasUI: boolean } => ({ ui: tuiUi, hasUI: true }),
    };
    const askTool = {
      name: "ask",
      execute: async (
        _input: unknown,
        context: { ui: { confirm(title: string, message: string): Promise<boolean> } },
      ) => {
        observed.push(await context.ui.confirm("Ask question", "Proceed?") ? "ask-approved" : "ask-denied");
      },
    };
    const bashTool = { name: "bash", session: toolSession };
    const commandCtx = {
      ui: tuiUi,
      isIdle: () => false,
      waitForIdle: async () => undefined,
    };
    const runner = {
      getUIContext: () => tuiUi,
      createContext: () => ({ ui: tuiUi }),
      createCommandContext: () => commandCtx,
      getCommand: () => undefined,
    };
    const session = {
      extensionRunner: runner,
      agent: { state: { tools: [askTool, bashTool] } },
    } as unknown as CapturedAgentSession;
    const uiRuntime = createTelegramUiRuntime({ getSession: () => session, transport });
    const commands = new Map<string, TelegramCommandHandler>([
      ["tg", async () => {
        await askTool.execute({}, { ui: tuiUi });
        const context = toolSession.getToolContext();
        observed.push(context.ui === tuiUi ? "prelude-tui" : "prelude-routed");
        observed.push(await context.ui.confirm("Computer approval", "Allow?") ? "computer-approved" : "computer-denied");
      }],
    ]);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: uiRuntime,
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: commands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId) => ({ chatId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, from: { id: 1 }, text: "/tg" });

    await vi.waitFor(() => expect(sent.find((item) => item.text.includes("Ask question"))).toBeDefined());
    const ask = sent.find((item) => item.text.includes("Ask question"));
    expect(tuiConfirm).not.toHaveBeenCalled();
    const askCallback = decodeUiCallback(ask?.rows?.[0]?.[0]?.value ?? "") ?? "";
    expect(uiRuntime.resolveInput(999, askCallback, ask?.message_id, true).handled).toBe(true);
    await vi.waitFor(() => expect(observed).toContain("ask-approved"));

    await vi.waitFor(() => expect(sent.find((item) => item.text.includes("Computer approval"))).toBeDefined());
    const computer = sent.find((item) => item.text.includes("Computer approval"));
    expect(tuiConfirm).not.toHaveBeenCalled();
    const computerCallback = decodeUiCallback(computer?.rows?.[0]?.[0]?.value ?? "") ?? "";
    expect(uiRuntime.resolveInput(999, computerCallback, computer?.message_id, true).handled).toBe(true);
    await vi.waitFor(() => expect(observed).toContain("computer-approved"));
    expect(observed).toContain("prelude-routed");
    expect(tuiConfirm).not.toHaveBeenCalled();

    // Outside a Telegram turn both surfaces fall back to the host UI.
    await vi.waitFor(() => expect(toolSession.getToolContext().ui).toBe(tuiUi));
    await toolSession.getToolContext().ui.confirm("Local prelude", "local?");
    expect(tuiConfirm).toHaveBeenCalledWith("Local prelude", "local?");
  });
});
