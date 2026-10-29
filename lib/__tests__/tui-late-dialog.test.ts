/**
 * A dialog the host opens inside a command's call chain is that command's dialog,
 * even when the command's scope has already ended (the dialog's focus can arrive
 * after the scope's idle end). Each message keeps its own queued edit.
 */
import { describe, expect, it, vi } from "vitest";
import { runInCommand, runOutsideCommand } from "../tui/command-context.ts";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import { FocusTracker } from "../tui/focus.ts";
import { OriginTracker, type CommandScope } from "../tui/origin.ts";
import type { TelegramTurn } from "../types.ts";

class ExtensionSelectorComponent {
  options = ["alpha", "beta"];
  selectedIndex = 0;
  constructor(private readonly onDone: () => void) {}
  render() { return ""; }
  handleInput(key: string) { if (key === "\x1b") this.onDone(); }
}

function setup(turns: TelegramTurn[] = []) {
  const sent: Array<{ chatId: number; messageId: number; kind: string; text?: string }> = [];
  let nextId = 100;
  const transport = {
    sendButtons: async (chatId: number) => {
      nextId += 1;
      sent.push({ chatId, messageId: nextId, kind: "send" });
      return { message_id: nextId };
    },
    editButtons: async (chatId: number, messageId: number, text: string) => {
      sent.push({ chatId, messageId, kind: "edit", text });
    },
    editText: async (chatId: number, messageId: number, text: string) => {
      sent.push({ chatId, messageId, kind: "editText", text });
    },
    sendText: async (chatId: number) => {
      nextId += 1;
      sent.push({ chatId, messageId: nextId, kind: "text" });
      return [{ message_id: nextId }];
    },
    removeInlineKeyboard: async () => undefined,
    deleteMessage: async () => undefined,
  };
  const editor = { render: () => "", handleInput: () => undefined, getText: () => "", setText: () => undefined };
  const ui = {
    focusedComponent: editor as unknown,
    setFocus(component: unknown) { ui.focusedComponent = component; },
  };
  const focus = new FocusTracker();
  (focus as unknown as { attach(s: unknown): void }).attach({ host: "pi", ui, editor, mode: {} });
  const origin = new OriginTracker({ isEditorFocused: () => focus.isEditor(), readDraft: () => "", writeDraft: () => true });
  const settled: CommandScope[] = [];
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin,
    activeChatId: () => 42,
    activeTurns: () => turns,
    writeText: () => true,
    enabled: () => true,
    settleScope: (scope) => { settled.push(scope); },
  });
  broker.start();
  return { sent, ui, editor, origin, broker, settled, focus };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a dialog opened inside an ended command's call chain", () => {
  it("is drawn on the command's message and its close leaves header and summary", async () => {
    const { sent, ui, editor, origin, broker, settled } = setup();
    const scope = origin.begin({ chatId: 42 }, "login", "/login", "");
    scope.telegramMessageId = 500;
    origin.end(scope, "idle");

    const selector = new ExtensionSelectorComponent(() => ui.setFocus(editor));
    runInCommand(scope, () => ui.setFocus(selector));
    await flush();

    expect(broker.current()?.telegram).toEqual({ chatId: 42, messageThreadId: undefined, messageId: 500 });
    expect(sent.some((entry) => entry.messageId === 500 && entry.kind === "edit")).toBe(true);

    // The terminal closes the dialog: the message ends as header + summary, no "Done".
    ui.setFocus(editor);
    await flush();
    expect(scope.dialogSummaries).toEqual(["Answered in the terminal"]);
    expect(settled).toEqual([scope]);
  });
});

describe("a dialog the host focuses without a focus event during an idle command", () => {
  it("is read live before the idle end can close the command scope under it", async () => {
    const { ui, origin, broker, focus } = setup();
    const scope = origin.begin({ chatId: 42 }, "login", "/login", "");
    scope.telegramMessageId = 500;

    // The host moves focus to the selector without calling setFocus; the tracker's own
    // verify tick would take up to two seconds to notice, longer than the idle window.
    const selector = new ExtensionSelectorComponent(() => undefined);
    runInCommand(scope, () => { ui.focusedComponent = selector; });

    expect(focus.isEditor()).toBe(false);
    await flush();
    expect(scope.ended).toBe(false);
    expect(scope.dialogOpen).toBe(true);
    expect(broker.current()?.telegram?.messageId).toBe(500);
  });
});

describe("a dialog outside any command chain", () => {
  it("is mirrored to the chat of the running agent turn, as before", async () => {
    const { sent, ui, broker } = setup([{ chatId: 42, sourceMessageId: 7, queuedAttachments: [] } as TelegramTurn]);
    const selector = new ExtensionSelectorComponent(() => undefined);
    runOutsideCommand(() => ui.setFocus(selector));
    await flush();
    expect(sent.some((entry) => entry.kind === "send" && entry.chatId === 42)).toBe(true);
    expect(broker.current()?.telegram?.chatId).toBe(42);
  });

  it("with no turn and no command stays local: tracked, never mirrored", async () => {
    const { sent, ui, broker } = setup([]);
    ui.setFocus(new ExtensionSelectorComponent(() => undefined));
    await flush();
    expect(sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(true);
    expect(broker.current()?.telegram).toBeUndefined();
  });
});

describe("broker edit queue", () => {
  it("keeps a queued edit for each message in the same chat", () => {
    vi.useFakeTimers();
    try {
      const { broker } = setup();
      const rate = (broker as unknown as {
        rate(target: { chatId: number; messageId?: number }, edit: () => void): void;
      }).rate.bind(broker);
      const ran: string[] = [];
      rate({ chatId: 42, messageId: 500 }, () => ran.push("first-immediate"));
      rate({ chatId: 42, messageId: 500 }, () => ran.push("first-queued"));
      rate({ chatId: 42, messageId: 600 }, () => ran.push("second-queued"));
      vi.advanceTimersByTime(1500);
      expect(ran).toEqual(["first-immediate", "first-queued", "second-queued"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
