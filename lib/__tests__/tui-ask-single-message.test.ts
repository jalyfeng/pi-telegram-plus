/**
 * Issue #22: one OMP `ask` call must reach Telegram as one message. The fake host
 * mirrors OMP 18.12.5 `extension-ui-controller.ts`: the tool UI context forwards
 * `askDialog` synchronously to the mode's `showAskDialog`, which builds one ask
 * component and focuses it. A prompt editor opened on top and closed again
 * focuses the same ask object once more.
 */
import { describe, expect, it } from "vitest";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import { FocusTracker } from "../tui/focus.ts";
import { OriginTracker } from "../tui/origin.ts";
import type { AskQuestion } from "../tui/model.ts";
import type { TelegramTurn } from "../types.ts";

class AskDialogComponent {
  constructor(private readonly question: AskQuestion) {}
  render() { return ""; }
  handleInput(_key: string) { /* keys are not modelled */ }
  describe() {
    const rows = this.question.options.map((option, index) => ({
      k: "item",
      key: `option:${index}`,
      p: { label: [{ t: option.label }], role: "omp.ask.option" },
    }));
    return {
      k: "col",
      p: { role: "omp.editor.ask" },
      c: [
        { k: "list", key: "q0", p: { selected: "option:0", role: "omp.ask.options" }, c: rows },
        {
          k: "row",
          key: "actions",
          p: { role: "omp.actions" },
          c: [
            { k: "row", p: { role: "omp.btn", actions: { click: "cancel" } }, c: [] },
            { k: "row", p: { role: "omp.btn", actions: { click: "submit" } }, c: [] },
          ],
        },
      ],
    };
  }
}

/** Same shape as pi's and OMP's prompt editor; the name is what `HookEditorComponent` would carry. */
class HookEditorComponent {
  render() { return ""; }
  handleInput(_key: string) { /* keys are not modelled */ }
  getText() { return ""; }
  setText(_text: string) { /* not modelled */ }
}

const QUESTION: AskQuestion = {
  id: "colour",
  question: "Pick a color for the acceptance run",
  options: [{ label: "red" }, { label: "green" }],
  recommended: 1,
};

type Sent = { chatId: number; messageId: number; kind: string; text?: string };

function setup(options: { draftBeneath?: boolean } = {}) {
  const sent: Sent[] = [];
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
  const editor = { focused: false, render: () => "", handleInput: () => undefined, getText: () => "", setText: () => undefined };
  const focusCalls: unknown[] = [];
  const ui = {
    focusedComponent: editor as unknown,
    setFocus(component: unknown) {
      focusCalls.push(component);
      ui.focusedComponent = component;
    },
  };
  const mode = {
    editorContainer: { children: [] as unknown[] },
    // OMP's `#showLocalAskDialog`: one component, mounted, focused once.
    showAskDialog(questions: AskQuestion[], _dialogOptions?: unknown) {
      const component = new AskDialogComponent(questions[0]);
      mode.editorContainer.children = options.draftBeneath ? [component, editor] : [component];
      editor.focused = options.draftBeneath === true;
      state.ask = component;
      ui.setFocus(component);
      return new Promise<unknown>(() => undefined);
    },
  };
  const toolUi = {
    askDialog: (questions: AskQuestion[], dialogOptions?: unknown) => mode.showAskDialog(questions, dialogOptions),
  };
  const state: { ask?: AskDialogComponent } = {};
  const turns: TelegramTurn[] = [{ chatId: 42, sourceMessageId: 7, queuedAttachments: [] } as TelegramTurn];

  const focus = new FocusTracker();
  (focus as unknown as { attach(s: unknown): void }).attach({
    host: "omp",
    ui,
    editor,
    mode,
    session: { extensionRunner: { getUIContext: () => toolUi } },
  });
  const origin = new OriginTracker({ isEditorFocused: () => focus.isEditor(), readDraft: () => "", writeDraft: () => true });
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin,
    activeChatId: () => 42,
    activeTurns: () => turns,
    writeText: () => true,
    enabled: () => true,
  });
  broker.start();
  return { sent, ui, focusCalls, toolUi, state, broker, focus };
}

const flush = async (ticks = 3) => {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};
/** OMP passes `dialogOptions` with an abort signal; the race wrapper only exists for that shape. */
const askOptions = () => ({ signal: new AbortController().signal });
const sendsOf = (sent: Sent[]) => sent.filter((entry) => entry.kind === "send");

describe("#22 one ask call sends one Telegram message", () => {
  it("S1 plain: a single askDialog call sends exactly one message", async () => {
    const { sent, toolUi, focusCalls, focus, state } = setup();
    void toolUi.askDialog([QUESTION], askOptions());
    await flush();
    expect(focus.entryFor(state.ask as unknown as Record<string, unknown>)?.race).toBeDefined();
    expect(focusCalls).toHaveLength(1);
    expect(sendsOf(sent)).toHaveLength(1);
  });

  it("S2 draft beneath: the editor mounted under the dialog does not add a message", async () => {
    const { sent, toolUi } = setup({ draftBeneath: true });
    void toolUi.askDialog([QUESTION], askOptions());
    await flush();
    expect(sendsOf(sent)).toHaveLength(1);
  });

  it("S3 nested prompt: opening and closing a prompt editor over the dialog sends one message", async () => {
    const { sent, ui, toolUi, state } = setup();
    void toolUi.askDialog([QUESTION], askOptions());
    await flush();
    const promptEditor = new HookEditorComponent();
    ui.setFocus(promptEditor);
    await flush();
    ui.setFocus(state.ask);
    await flush();
    expect(sendsOf(sent)).toHaveLength(1);
    expect(sent.filter((entry) => (entry.kind === "edit" || entry.kind === "editText") && entry.text === "Answered in the terminal")).toEqual([]);
  });

  it("S4 settled ask: a prompt opened after the ask was answered is not kept, and opens its own message", async () => {
    const { sent, ui, toolUi, state, focus } = setup();
    void toolUi.askDialog([QUESTION], askOptions());
    await flush();
    const race = focus.entryFor(state.ask as unknown as Record<string, unknown>)?.race;
    expect(race?.settled).toBe(false);
    expect(race?.answer(undefined)).toBe(true);
    expect(race?.settled).toBe(true);
    await flush();
    ui.setFocus(new HookEditorComponent());
    await flush();
    // The guard does not apply once the race is settled: the ask session retires and the prompt opens a message.
    expect(sendsOf(sent)).toHaveLength(2);
  });
});
