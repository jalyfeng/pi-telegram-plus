/**
 * A host result produced after a Telegram answer belongs to the command that opened the
 * dialog (#33). The host runs the dialog callback outside the command's call chain, so the
 * broker enters the owner's command scope around that host call; OutputCapture then claims
 * what the host adds to the chat, and it lands on the command's Telegram message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCommandScope, runInCommand } from "../tui/command-context.ts";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import { OutputCapture } from "../tui/output.ts";
import { OriginTracker, type CommandScope } from "../tui/origin.ts";
import type { DialogAdapter, DialogModel, DialogSession } from "../tui/model.ts";
import { SecretStore } from "../tui/secrets.ts";

type CaptureTransport = ConstructorParameters<typeof OutputCapture>[0];

const RESULT = "Successfully logged out API key #1 from deepseek";

function brokerTransport() {
  const edits: Array<{ text: string }> = [];
  return {
    edits,
    sendButtons: async () => ({ message_id: 101 }),
    editButtons: async (_chatId: number, _messageId: number, text: string) => {
      edits.push({ text });
    },
    sendText: async () => [{ message_id: 301 }],
    removeInlineKeyboard: async () => undefined,
    deleteMessage: async () => undefined,
  };
}

/** A focus view the test drives by hand: only the members the broker reads. */
function fakeFocus() {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  let live: object = editor;
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    current: () => info,
    entryFor: () => undefined,
    validate() {
      if (live === info.component) return;
      emit({ kind: live === editor ? "editor" : "dialog", component: live as Record<string, unknown>, source: "getter" });
    },
    handOverSilently(component: Record<string, unknown>) {
      live = component;
    },
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      live = component;
      emit({ kind: "dialog", component, source: "event" });
    },
    closeToEditor() {
      live = editor;
      emit({ kind: "editor", component: editor, source: "event" });
    },
  };
}

const flushBroker = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

/**
 * A command that has opened a confirm dialog through the broker. The host's answer is
 * scripted: `act` starts the host work and reports its result to the chat after an await,
 * the way the host's dialog callback does.
 */
async function fixture(options: { onAct?: (chat: { addChild(child: unknown): void }) => void } = {}) {
  const editText = vi.fn(async () => undefined);
  const outputTransport: CaptureTransport = {
    sendText: async () => [],
    editText,
    sendDocument: async () => undefined,
  };
  const focus = fakeFocus();
  const origin = new OriginTracker({
    isEditorFocused: () => focus.current().kind === "editor",
    readDraft: () => "",
    writeDraft: () => true,
  });
  const output = new OutputCapture(outputTransport, origin, new SecretStore());
  const scope = origin.begin({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 }, "logout", "/logout", "");
  scope.telegramMessageId = 5;
  output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: "<b>▶️ /logout</b>" });

  const chat = { children: [] as unknown[], addChild(child: unknown): void { this.children.push(child); } };
  (output as unknown as { attach(state: unknown): void }).attach({ mode: undefined, ui: {}, chat, session: undefined });

  const transport = brokerTransport();
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin,
    activeChatId: () => 42,
    activeTurns: () => [],
    writeText: () => true,
    enabled: () => true,
  });
  broker.start();

  const model: DialogModel = { kind: "confirm", title: "Log out API key #1?" };
  const acts: string[] = [];
  const adapter: DialogAdapter = {
    id: "scripted",
    detect: () => true,
    read: () => model,
    act: (_component, action) => {
      acts.push(action.type);
      // The host closes the dialog when the answer is taken, then reports the result.
      focus.closeToEditor();
      options.onAct?.(chat);
      return true;
    },
  };
  // The command opens the dialog from inside its own call chain.
  runInCommand(scope, () => focus.openDialog({}));
  await flushBroker();
  const session = broker.current() as DialogSession;
  session.adapter = adapter;
  session.model = model;
  return { broker, scope, output, chat, editText, session, acts, origin, focus };
}

async function settleOutput(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1500);
}

function lastEdit(editText: ReturnType<typeof vi.fn>): string {
  const calls = editText.mock.calls as unknown as unknown[][];
  return String(calls.at(-1)?.[2] ?? "");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Telegram dialog answer output", () => {
  it("puts the host result of a Telegram answer on the command's message", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { broker, editText, session } = await fixture({
      onAct: (chat) => {
        // The host reports the result after an await, outside the synchronous call.
        void (async () => {
          await Promise.resolve();
          chat.addChild({ children: [{ markdown: RESULT }] });
        })();
      },
    });

    expect(broker.handleCallback(42, 7, { sessionId: session.id, generation: 0, op: "y" })).toMatchObject({ handled: true });
    await flushBroker();
    await settleOutput();

    expect(lastEdit(editText)).toContain(RESULT);
  });

  it("runs the host call without a scope when the owning command has ended", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const seen: Array<CommandScope | undefined> = [];
    const { broker, scope, session, acts } = await fixture({
      onAct: () => {
        seen.push(currentCommandScope());
      },
    });
    (scope as { ended: boolean }).ended = true;

    expect(() => broker.handleCallback(42, 7, { sessionId: session.id, generation: 0, op: "y" })).not.toThrow();
    await flushBroker();

    expect(acts).toEqual(["confirm"]);
    expect(seen).toEqual([undefined]);
  });

  it("enters the owning command's scope around the host call, synchronously and after an await", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const syncSeen: Array<CommandScope | undefined> = [];
    const asyncSeen: Array<CommandScope | undefined> = [];
    const { broker, scope, session } = await fixture({
      onAct: () => {
        syncSeen.push(currentCommandScope());
        void (async () => {
          await Promise.resolve();
          asyncSeen.push(currentCommandScope());
        })();
      },
    });

    broker.handleCallback(42, 7, { sessionId: session.id, generation: 0, op: "y" });
    await flushBroker();

    expect(syncSeen).toEqual([scope]);
    expect(asyncSeen).toEqual([scope]);
  });

  it("keeps the command open long enough for a result reported after its dialog closed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { broker, editText, session, scope, origin, focus, chat } = await fixture({
      onAct: (chat) => {
        // The host result arrives 400 ms after the dialog closed: after the tick that would
        // end an idle scope, but well inside the idle window the close restarts. A real timer
        // keeps the act's command context; fake timers do not, so the callback re-enters it.
        const inScope = currentCommandScope();
        setTimeout(() => {
          if (inScope) runInCommand(inScope, () => chat.addChild({ children: [{ markdown: RESULT }] }));
        }, 400);
      },
    });
    origin.markSubmitDone(scope);
    // The dialog stays open for longer than IDLE_MS: the scope is not idle while it waits.
    await vi.advanceTimersByTimeAsync(2000);
    expect(scope.ended).toBe(false);

    // Tap the button as it is drawn now: the periodic redraw may have moved the generation on.
    expect(broker.handleCallback(42, 7, { sessionId: session.id, generation: session.generation, op: "y" })).toMatchObject({ handled: true });
    await flushBroker();
    expect(focus.current().kind).toBe("editor");
    await vi.advanceTimersByTimeAsync(1000);
    expect(scope.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scope.ended).toBe(true);
    await settleOutput();

    expect(lastEdit(editText)).toContain(RESULT);
  });
});
