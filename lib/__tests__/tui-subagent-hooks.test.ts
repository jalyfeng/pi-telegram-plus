/**
 * A sub-agent session re-runs the extension factory in the same process (#32).
 * Its controller must not start the TUI runtime, or its FocusTracker attaches to
 * the shared host UI and replaces the main session's `focus-tracker` hook, so the
 * main session's DialogBroker never hears about a dialog again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramController, type TelegramController } from "../controller.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

const SHARED_STATE_KEY = "__piTelegramPlusTuiBridgeState";
const PICKER_TREE = { k: "picker", p: { title: "Model", items: [{ id: "a", label: "alpha" }] } };

/** OMP's model picker as the focus tracker sees it: keys, a render, a cancel signal, a TSP description. */
function pickerComponent() {
  return {
    abortController: new AbortController(),
    render: () => "",
    handleInput: () => undefined,
    describe: () => PICKER_TREE,
    handleNativeEvent: () => undefined,
  };
}

type Call = { method: string; text?: string };

function createTransport(calls: Call[]): TelegramTransport {
  return {
    removeInlineKeyboard: async () => undefined,
    sendText: async (_chatId, value) => { calls.push({ method: "text", text: value }); return [{ message_id: 1 }]; },
    sendButtons: async (_chatId, value) => { calls.push({ method: "buttons", text: value }); return { message_id: 2 }; },
    editText: async (_chatId, _messageId, value) => { calls.push({ method: "edit", text: value }); },
    editButtons: async (_chatId, _messageId, value) => { calls.push({ method: "buttons", text: value }); },
    answerCallbackQuery: async () => undefined,
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

function createBridge(): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "omp",
    getCommands: async () => [],
    submit: vi.fn(() => true),
    key: vi.fn(() => true),
    write: vi.fn(() => true),
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
  } as unknown as TuiBridgeAdapter;
}

function createController(calls: Call[], bridge: TuiBridgeAdapter): TelegramController {
  return createTelegramController({
    getSession: () => createSession(),
    transport: createTransport(calls),
    ui: {
      create: () => ({ notify: async () => undefined }) as never,
      resolveInput: () => ({ handled: false }),
      isSensitiveInput: () => false,
      hasPendingInput: () => false,
      dispose: () => undefined,
    } as never,
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    // A Telegram turn is in flight, so a dialog the host opens belongs to chat 42.
    getActiveTurns: () => [{ chatId: 42, queuedAttachments: [] }] as never,
    beginTelegramTurn: (chatId) => ({ chatId, queuedAttachments: [] }),
    endTelegramTurn: () => undefined,
    getConfig: () => ({ activeChatId: 42 }) as never,
    tuiBridge: bridge,
  });
}

/** A shared host UI with a real setFocus method and an editor, as the bridge captures it. */
function seedHost(): { restore: () => void; ui: { setFocus(component: unknown): void } } {
  const state = (globalThis as unknown as Record<string, Record<string, unknown>>)[SHARED_STATE_KEY];
  const saved = { host: state.host, mode: state.mode, ui: state.ui, editor: state.editor, defaultEditor: state.defaultEditor };
  const ui = {
    setFocus(_component: unknown) { /* the host keeps focus; the hook records it */ },
  };
  const editor = { render: () => "", handleInput: () => undefined };
  Object.assign(state, { host: "omp", mode: {}, ui, editor, defaultEditor: undefined });
  return {
    ui,
    restore: () => Object.assign(state, saved),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

describe("A sub-agent controller does not take over the main session's host hooks (#32)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it("the main session still receives a dialog focus after a sub-agent controller is created", async () => {
    const host = seedHost();
    cleanup.push(host.restore);
    const bridge = createBridge();
    const mainCalls: Call[] = [];
    const subCalls: Call[] = [];

    const main = createController(mainCalls, bridge);
    cleanup.push(() => main.dispose());
    main.startTui();
    // The sub-agent instance re-runs the factory but never calls startTui().
    const sub = createController(subCalls, bridge);
    cleanup.push(() => sub.dispose());

    host.ui.setFocus(pickerComponent());

    await waitFor(() => mainCalls.some((call) => call.method === "buttons"));
    expect(mainCalls.some((call) => call.method === "buttons")).toBe(true);
    expect(subCalls).toEqual([]);
  });

  it("of two FocusTrackers on one host, the one that started last receives the events", () => {
    // Mechanism behind #32, on the tracker alone: each start() subscribes to the
    // shared host state and re-hooks the same host method under the same stage
    // kind, so the later one replaces the earlier one's hook.
    const host = seedHost();
    cleanup.push(host.restore);
    const first = new FocusTracker();
    const second = new FocusTracker();
    cleanup.push(() => first.stop());
    cleanup.push(() => second.stop());
    const firstKinds: string[] = [];
    const secondKinds: string[] = [];
    first.onChange((info) => firstKinds.push(info.kind));
    second.onChange((info) => secondKinds.push(info.kind));

    first.start();
    second.start();
    host.ui.setFocus(pickerComponent());

    expect(secondKinds).toContain("dialog");
    expect(firstKinds).not.toContain("dialog");
  });
});
