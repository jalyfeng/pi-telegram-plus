import { describe, expect, it, vi } from "vitest";
import { bridgeCustomDialog, stripAnsi, type ButtonRow } from "../custom-dialogs.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";

// ---- Helpers ----

/** Stub factory that returns a component with fixed render lines. */
function stubFactory(renderLines: string[]) {
  return (_tui: unknown, _theme: unknown, _kb: unknown, _done: (result: unknown) => void) => ({
    render: () => renderLines,
    invalidate: () => {},
  });
}

/** Deferred controller for waitInput. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Build deps for bridgeCustomDialog with controllable waitInput. */
function makeDeps(factory: unknown, overrides?: Partial<Parameters<typeof bridgeCustomDialog>[0]>) {
  const notify = vi.fn();
  const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
  const { promise, resolve } = deferred<string | boolean | undefined>();

  return {
    deps: {
      factory: factory as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => {
        sentButtons.push({ text, rows });
        return { message_id: 100 };
      },
      waitInput: () => promise,
      notify,
      ...overrides,
    } as Parameters<typeof bridgeCustomDialog>[0],
    sentButtons,
    resolveWaitInput: resolve,
    notify,
  };
}

// ---- stripAnsi ----

describe("stripAnsi", () => {
  it("removes SGR escape codes", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[22m text")).toBe("bold text");
  });
  it("removes color codes", () => {
    expect(stripAnsi("\x1B[38;5;42mcolored\x1B[39m")).toBe("colored");
  });
  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

// ---- bridgeCustomDialog: confirmation dialog ----

const CONFIRM_RENDER = [
  "────────────────────────────────────────────────────────────────────────────────",
  " Confirm Goal Draft",
  " Draft: implement feature X",
  "",
  "> 1. Confirm — create this goal now ★",
  "  2. Continue chatting — keep refining",
  "",
  " ↑↓ navigate • Enter select • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];

describe("bridgeCustomDialog — confirmation dialog", () => {
  it("Confirm button → answers[0].answer is 'Confirm — create this goal now', cancelled false", async () => {
    const { deps, resolveWaitInput, sentButtons } = makeDeps(stubFactory(CONFIRM_RENDER));
    const resultP = bridgeCustomDialog(deps);
    resolveWaitInput("confirm");
    const result = await resultP;

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Confirm — create this goal now");
    expect((result as any).answers[0].wasCustom).toBe(false);

    // Verify the buttons were sent
    expect(sentButtons).toHaveLength(1);
    expect(sentButtons[0].rows[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "✅ Confirm" }),
        expect.objectContaining({ text: "💬 Continue chatting" }),
      ]),
    );
  });

  it("Continue button → answers[0].answer is 'Continue chatting — keep refining', cancelled false", async () => {
    const { deps, resolveWaitInput } = makeDeps(stubFactory(CONFIRM_RENDER));
    const resultP = bridgeCustomDialog(deps);
    resolveWaitInput("continue");
    const result = await resultP;

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Continue chatting — keep refining");
  });

  it("cancel/timeout → cancelled true", async () => {
    const { deps, resolveWaitInput } = makeDeps(stubFactory(CONFIRM_RENDER));
    const resultP = bridgeCustomDialog(deps);
    resolveWaitInput(undefined);
    const result = await resultP;

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect((result as any).answers).toEqual([]);
  });
});

// ---- bridgeCustomDialog: single-question ----

const SINGLE_QUESTION_RENDER = [
  "────────────────────────────────────────────────────────────────────────────────",
  " What scope should we focus on?",
  "",
  "> 1. Frontend only",
  "  2. Backend only",
  "  3. Write your own answer...",
  "",
  " ↑↓ navigate • Enter select • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];

describe("bridgeCustomDialog — single-question", () => {
  it("option toggle + Submit → answer matches the option, wasCustom false", async () => {
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(SINGLE_QUESTION_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => { sentButtons.push({ text, rows }); return { message_id: 100 }; },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify: vi.fn(),
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    await new Promise((r) => setTimeout(r, 10));
    // Initial render: options use ☐ toggle markers; no Submit yet (nothing selected).
    expect(sentButtons[0].rows[0][0].text).toContain("☐");
    expect(sentButtons[0].rows.some((row) => row.some((b) => b.value === "submit"))).toBe(false);
    waitInputs[0]!("s:0"); // toggle option 0

    await new Promise((r) => setTimeout(r, 10));
    // After toggle: option 0 is ☑ and a Submit button appears.
    expect(sentButtons[1].rows[0][0].text).toContain("☑");
    expect(sentButtons[1].rows.some((row) => row.some((b) => b.value === "submit"))).toBe(true);
    waitInputs[1]!("submit");

    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Frontend only");
    expect((result as any).answers[0].wasCustom).toBe(false);
  });

  it("multi-select: toggle two options → answer is the joined string", async () => {
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(SINGLE_QUESTION_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => { sentButtons.push({ text, rows }); return { message_id: 100 }; },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify: vi.fn(),
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[0]!("s:0"); // toggle option 0 (Frontend only)
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[1]!("s:1"); // toggle option 1 (Backend only)
    await new Promise((r) => setTimeout(r, 10));
    // Both selected now.
    expect(sentButtons[2].text).toContain("Selected: Frontend only / Backend only");
    waitInputs[2]!("submit");

    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Frontend only / Backend only");
    expect((result as any).answers[0].wasCustom).toBe(false);
  });

  it("custom text → answer is the typed text, wasCustom true", async () => {
    // Two-phase waitInput: first returns "custom" (button click), second returns typed text.
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const notify = vi.fn();
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(SINGLE_QUESTION_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => {
        sentButtons.push({ text, rows });
        return { message_id: 100 };
      },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify,
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    // Wait a tick for the first waitInput to be registered
    await new Promise((r) => setTimeout(r, 10));
    expect(waitInputs).toHaveLength(1);
    waitInputs[0]!("custom");

    // Wait a tick for the second sendButtons + waitInput
    await new Promise((r) => setTimeout(r, 10));
    expect(waitInputs).toHaveLength(2);
    waitInputs[1]!("Full stack with tests");

    const result = await resultP;

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Full stack with tests");
    expect((result as any).answers[0].wasCustom).toBe(true);

    // Two sendButtons calls: initial options, then free-text prompt
    expect(sentButtons).toHaveLength(2);
    expect(sentButtons[1].text).toContain("Please type your answer");
  });

  it("cancel → cancelled true", async () => {
    const { deps, resolveWaitInput } = makeDeps(stubFactory(SINGLE_QUESTION_RENDER));
    const resultP = bridgeCustomDialog(deps);
    resolveWaitInput(undefined);
    const result = await resultP;

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
  });
});

// ---- bridgeCustomDialog: multi-question (degrade) ----

const MULTI_QUESTION_RENDER = [
  "────────────────────────────────────────────────────────────────────────────────",
  " ←  ■ q1  □ q2  ✓ Submit →",
  "",
  " What scope should we focus on?",
  "",
  " > 1. Frontend only",
  "   2. Backend only",
  "",
  " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];

describe("bridgeCustomDialog — multi-question degrade (no handleInput)", () => {
  it("degrades to cancelled:true with a notify when component has no handleInput", async () => {
    const { deps, notify } = makeDeps(stubFactory(MULTI_QUESTION_RENDER));
    const result = await bridgeCustomDialog(deps);

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ---- bridgeCustomDialog: multi-question driving ----

/** Stub factory that cycles through per-tab renders on a raw Tab byte ("\t"). */
function multiTabFactory(tabRenders: string[][]) {
  let tab = 0;
  const total = tabRenders.length;
  return (_tui: unknown, _theme: unknown, _kb: unknown, _done: (r: unknown) => void) => ({
    render: () => tabRenders[tab],
    invalidate: () => {},
    handleInput: (data: string) => { if (data === "\t") tab = (tab + 1) % total; },
  });
}

const MQ_TAB0 = [
  "────────────────────────────────────────────────────────────────────────────────",
  " ←  □ q1  □ q2  ✓ Submit →",
  "",
  " What is the deliverable?",
  "",
  " > 1. Report only ★",
  "   2. Report + fix",
  "   3. Write your own answer...",
  "",
  " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];
const MQ_TAB1 = [
  "────────────────────────────────────────────────────────────────────────────────",
  " ←  □ q1  □ q2  ✓ Submit →",
  "",
  " What dimensions to analyze?",
  "",
  "   1. Code only",
  " > 2. Code + tests",
  "   3. Write your own answer...",
  "",
  " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];

/** Deps whose waitInput resolves a queue of scripted values, one per call. */
function scriptedDeps(factory: unknown, script: (string | boolean | undefined)[]) {
  const notify = vi.fn();
  const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
  let i = 0;
  const deps = {
    factory: factory as any,
    theme: {},
    width: 80,
    sendButtons: async (text: string, rows: ButtonRow[]) => { sentButtons.push({ text, rows }); return { message_id: 100 }; },
    waitInput: () =>
      new Promise<string | boolean | undefined>((resolve) => {
        const v = script[i++];
        // microtask delay so the loop awaits before we move on
        setTimeout(() => resolve(v), 0);
      }),
    notify,
  } as Parameters<typeof bridgeCustomDialog>[0];
  return { deps, sentButtons, notify };
}

describe("bridgeCustomDialog — multi-question driving", () => {
  it("extracts both tabs and collects answers on Submit", async () => {
    const { deps, sentButtons } = scriptedDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]), [
      "o:0", // q1 → toggle Report only
      "t:1", // navigate to q2 tab
      "o:1", // q2 → toggle Code + tests
      "submit",
    ]);
    const result = await bridgeCustomDialog(deps);

    expect(result).toBeDefined();
    const r = result as any;
    expect(r.cancelled).toBe(false);
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0].id).toBe("q1");
    expect(r.questions[1].id).toBe("q2");
    expect(r.questions[0].options).toEqual(["Report only", "Report + fix"]);
    expect(r.questions[0].recommended).toBe(0);
    expect(r.answers).toHaveLength(2);
    expect(r.answers[0]).toMatchObject({ id: "q1", answer: "Report only", wasCustom: false });
    expect(r.answers[1]).toMatchObject({ id: "q2", answer: "Code + tests", wasCustom: false });
    // At least 3 button sends: tab0, tab1, tab0-again (after wrap), then submit resolves.
    expect(sentButtons.length).toBeGreaterThanOrEqual(3);
    // First send shows q1 question text.
    expect(sentButtons[0].text).toContain("What is the deliverable?");
    // Tab progress line shows both ids.
    expect(sentButtons[0].text).toContain("q1");
    expect(sentButtons[0].text).toContain("q2");
  });

  it("Submit before all answered → notify Unanswered, re-show, then complete", async () => {
    const { deps, notify } = scriptedDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]), [
      "o:0",   // answer q1
      "submit", // too early → notify Unanswered: q2
      "t:1",   // navigate to q2 tab
      "o:1",   // answer q2
      "submit", // now complete
    ]);
    const result = await bridgeCustomDialog(deps);
    const r = result as any;
    expect(r.cancelled).toBe(false);
    expect(r.answers).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Still to answer.*q2/), "warning");
  });

  it("free-text (custom) answer for a tab → wasCustom true", async () => {
    const { deps } = scriptedDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]), [
      "custom",          // q1 → free-text entry
      "A hybrid report", // typed answer
      "t:1",             // navigate to q2 tab
      "o:1",             // q2 → Code + tests
      "submit",
    ]);
    const result = await bridgeCustomDialog(deps);
    const r = result as any;
    expect(r.cancelled).toBe(false);
    expect(r.answers[0]).toMatchObject({ id: "q1", answer: "A hybrid report", wasCustom: true });
    expect(r.answers[1]).toMatchObject({ id: "q2", answer: "Code + tests", wasCustom: false });
  });

  it("Cancel button → cancelled true", async () => {
    const { deps } = scriptedDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]), ["cancel"]);
    const result = await bridgeCustomDialog(deps);
    expect((result as any).cancelled).toBe(true);
  });

  it("timeout (undefined) → cancelled true", async () => {
    const { deps } = scriptedDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]), [undefined]);
    const result = await bridgeCustomDialog(deps);
    expect((result as any).cancelled).toBe(true);
  });

  it("factory render throws during extraction → safe degrade", async () => {
    let calls = 0;
    const factory = (_tui: unknown, _theme: unknown, _kb: unknown, _done: (r: unknown) => void) => ({
      render: () => { if (++calls === 2) throw new Error("boom"); return MQ_TAB0; },
      invalidate: () => {},
      handleInput: () => {},
    });
    const { deps, notify } = scriptedDeps(factory, []);
    const result = await bridgeCustomDialog(deps);
    expect((result as any).cancelled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ---- bridgeCustomDialog: unknown component ----

const UNKNOWN_RENDER = [
  "Some random component",
  "with no recognizable structure",
];

describe("bridgeCustomDialog — unknown component", () => {
  it("returns cancelled:true result and notify is called once", async () => {
    const { deps, notify } = makeDeps(stubFactory(UNKNOWN_RENDER));
    const result = await bridgeCustomDialog(deps);

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect((result as any).answers).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ---- bridgeCustomDialog: factory throws → safe fallback ----

describe("bridgeCustomDialog — factory throws", () => {
  it("returns cancelled:true result and notify is called when factory throws", async () => {
    const throwingFactory = () => { throw new Error("boom"); };
    const { deps, notify } = makeDeps(throwingFactory);
    const result = await bridgeCustomDialog(deps);

    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ---- telegram-ui: setWidget forwarding to base ----

describe("createTelegramUiRuntime — setWidget forwards to base", () => {
  it("setWidget('goal', factory, opts) calls base.setWidget with the same args", () => {
    const baseSetWidget = vi.fn();
    const baseSetStatus = vi.fn();
    const baseTheme = { fg: (s: string) => s, bg: (s: string) => s, bold: (s: string) => s };

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          setWidget: baseSetWidget,
          setStatus: baseSetStatus,
          theme: baseTheme,
        }),
      },
    } as any;

    const transport = {
      removeInlineKeyboard: async () => undefined,
      sendText: async () => [{ message_id: 1 }],
      sendButtons: async () => ({ message_id: 1 }),
      editText: async () => undefined,
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    } as any;

    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(123);

    const widgetFactory = ((_tui: unknown, _theme: unknown) => ({})) as any;
    const opts = { placement: "aboveEditor" as const };
    ui.setWidget("goal", widgetFactory, opts);

    expect(baseSetWidget).toHaveBeenCalledTimes(1);
    expect(baseSetWidget).toHaveBeenCalledWith("goal", widgetFactory, opts);
  });

  it("setWidget('goal', undefined) calls base.setWidget with undefined content", () => {
    const baseSetWidget = vi.fn();

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          setWidget: baseSetWidget,
          theme: { fg: (s: string) => s },
        }),
      },
    } as any;

    const transport = {
      removeInlineKeyboard: async () => undefined,
      sendText: async () => [{ message_id: 1 }],
      sendButtons: async () => ({ message_id: 1 }),
      editText: async () => undefined,
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    } as any;

    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(456);

    ui.setWidget("goal", undefined);

    expect(baseSetWidget).toHaveBeenCalledWith("goal", undefined, undefined);
  });

  it("editor ops are no-ops (getEditorText returns '', setEditorText does nothing)", () => {
    const session = {
      extensionRunner: {
        getUIContext: () => ({
          theme: { fg: (s: string) => s },
          setWidget: () => {},
        }),
      },
    } as any;

    const transport = {
      removeInlineKeyboard: async () => undefined,
      sendText: async () => [{ message_id: 1 }],
      sendButtons: async () => ({ message_id: 1 }),
      editText: async () => undefined,
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    } as any;

    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(789);

    expect(ui.getEditorText()).toBe("");
    expect(ui.getEditorComponent()).toBeUndefined();
    // These should not throw
    ui.setEditorText("hello");
    ui.pasteToEditor("hello");
    ui.setEditorComponent(undefined);
    ui.addAutocompleteProvider(() => ({} as any));
    const unsub = ui.onTerminalInput(() => undefined);
    expect(typeof unsub).toBe("function");
  });
});

// ---- telegram-ui: stateful UI forwarding to base (plan §6.3) ----

describe("createTelegramUiRuntime — stateful UI methods forward to base", () => {
  // Helper to build a runtime with a spied base UI context.
  function makeRuntimeWithSpiedBase() {
    const spies = {
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      setToolsExpanded: vi.fn(),
      getToolsExpanded: vi.fn(() => true),
      setTheme: vi.fn(() => ({ success: true })),
      getTheme: vi.fn(() => "dark"),
      getAllThemes: vi.fn(() => ["dark", "light"]),
    };

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          ...spies,
          theme: { fg: (s: string) => s },
        }),
      },
    } as any;

    const transport = {
      removeInlineKeyboard: async () => undefined,
      sendText: async () => [{ message_id: 1 }],
      sendButtons: async () => ({ message_id: 1 }),
      editText: async () => undefined,
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    } as any;

    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    return { ui: runtime.create(100), spies };
  }

  it("forwards setStatus to base with same args", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setStatus("goal", "goal: running");
    expect(spies.setStatus).toHaveBeenCalledWith("goal", "goal: running");
    ui.setStatus("goal", undefined);
    expect(spies.setStatus).toHaveBeenCalledWith("goal", undefined);
  });

  it("forwards setWorkingMessage to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setWorkingMessage("Thinking...");
    expect(spies.setWorkingMessage).toHaveBeenCalledWith("Thinking...");
    ui.setWorkingMessage(undefined);
    expect(spies.setWorkingMessage).toHaveBeenCalledWith(undefined);
  });

  it("forwards setTitle to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setTitle("My Title");
    expect(spies.setTitle).toHaveBeenCalledWith("My Title");
  });

  it("forwards setFooter and setHeader to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    const footerFactory = (() => []) as any;
    ui.setFooter(footerFactory);
    expect(spies.setFooter).toHaveBeenCalledWith(footerFactory);
    const headerFactory = (() => []) as any;
    ui.setHeader(headerFactory);
    expect(spies.setHeader).toHaveBeenCalledWith(headerFactory);
  });

  it("forwards setToolsExpanded and getToolsExpanded to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setToolsExpanded(true);
    expect(spies.setToolsExpanded).toHaveBeenCalledWith(true);
    expect(ui.getToolsExpanded()).toBe(true);
    expect(spies.getToolsExpanded).toHaveBeenCalledTimes(1);
  });

  it("forwards getAllThemes and getTheme to base", () => {
    const { ui } = makeRuntimeWithSpiedBase();
    expect(ui.getAllThemes()).toEqual(["dark", "light"]);
    expect(ui.getTheme("dark")).toBe("dark");
  });
});

// ---- bridgeCustomDialog: zero-options single-question (free-text only) ----

const ZERO_OPTIONS_RENDER = [
  "────────────────────────────────────────────────────────────────────────────────",
  " What is your preferred testing framework?",
  "",
  " Press Enter to write your answer",
  "",
  " ↑↓ navigate • Enter select • Esc cancel",
  "────────────────────────────────────────────────────────────────────────────────",
];

describe("bridgeCustomDialog — zero-options single-question", () => {
  it("shows ✏️ Type answer, typed text → wasCustom true, cancelled false", async () => {
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const notify = vi.fn();
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(ZERO_OPTIONS_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => {
        sentButtons.push({ text, rows });
        return { message_id: 100 };
      },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify,
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    await new Promise((r) => setTimeout(r, 10));
    expect(waitInputs).toHaveLength(1);
    // First sendButtons should contain a ✏️ Type answer action (no option rows)
    expect(sentButtons[0].rows).toHaveLength(1); // only the nav/action row
    expect(sentButtons[0].rows[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "✏️ Type answer", value: "custom" }),
        expect.objectContaining({ text: "Cancel", value: "cancel" }),
      ]),
    );
    waitInputs[0]!("custom");

    await new Promise((r) => setTimeout(r, 10));
    expect(waitInputs).toHaveLength(2);
    waitInputs[1]!("Jest with TypeScript");

    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Jest with TypeScript");
    expect((result as any).answers[0].wasCustom).toBe(true);
  });
});

// ---- bridgeCustomDialog: two-phase custom-text abort (/stop on free-text phase) ----

describe("bridgeCustomDialog — two-phase custom-text abort", () => {
  it("first waitInput 'custom', second undefined → cancelled true", async () => {
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const notify = vi.fn();
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(SINGLE_QUESTION_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => {
        sentButtons.push({ text, rows });
        return { message_id: 100 };
      },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify,
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    await new Promise((r) => setTimeout(r, 10));
    waitInputs[0]!("custom");

    await new Promise((r) => setTimeout(r, 10));
    expect(waitInputs).toHaveLength(2);
    // Second sendButtons should contain the free-text prompt
    expect(sentButtons[1].text).toContain("Please type your answer");
    // Abort: second waitInput returns undefined (/stop or timeout)
    waitInputs[1]!(undefined);

    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
  });
});

// ---- bridgeCustomDialog: pagination (Prev/Next) ----

describe("bridgeCustomDialog — pagination", () => {
  it("options > PAGE_SIZE get a Next ▶ nav button and (page/total) suffix", async () => {
    // 12 options → 2 pages (PAGE_SIZE=10). Render mirrors pi-goal's real output
    // (one-per-line numbered, with the leading selected marker on option 1).
    const opts = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const renderLines = [
      "────────────────────────────────────────────────────────────────────────────────",
      " Pick an option",
      "",
      ...opts.map((label, i) => ` ${i === 0 ? ">" : " "} ${i + 1}. ${label}${i === 0 ? " ★" : ""}`),
      "",
      " ↑↓ navigate • Enter select • Esc cancel",
      "────────────────────────────────────────────────────────────────────────────────",
    ];
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(renderLines) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => { sentButtons.push({ text, rows }); return { message_id: 100 }; },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify: vi.fn(),
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    await new Promise((r) => setTimeout(r, 10));

    // First send: page 1 (10 options, one per row) + nav row with Next ▶ + Cancel
    expect(sentButtons).toHaveLength(1);
    const first = sentButtons[0];
    expect(first.text).toContain("(1/2)");
    // 10 option rows + 1 nav row
    expect(first.rows).toHaveLength(11);
    const navRow = first.rows[10];
    expect(navRow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Next ▶" }),
        expect.objectContaining({ text: "Cancel" }),
      ]),
    );
    // No Prev on page 1
    expect(navRow.some((b) => b.text === "◀ Prev")).toBe(false);
    // No Submit yet (nothing toggled)
    expect(first.rows.some((row) => row.some((b) => b.value === "submit"))).toBe(false);

    // Toggle option 0 on page 1, then Submit → answer "Option 1"
    waitInputs[0]!("s:0");
    await new Promise((r) => setTimeout(r, 10));
    expect(sentButtons[1].rows.some((row) => row.some((b) => b.value === "submit"))).toBe(true);
    waitInputs[1]!("submit");
    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Option 1");
    expect((result as any).answers[0].wasCustom).toBe(false);
  });

  it("Prev/Next navigation: page 1 → Next → page 2 shows Prev and (2/2)", async () => {
    const opts = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const renderLines = [
      "────────────────────────────────────────────────────────────────────────────────",
      " Pick an option",
      "",
      ...opts.map((label, i) => ` ${i === 0 ? ">" : " "} ${i + 1}. ${label}${i === 0 ? " ★" : ""}`),
      "",
      " ↑↓ navigate • Enter select • Esc cancel",
      "────────────────────────────────────────────────────────────────────────────────",
    ];
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: stubFactory(renderLines) as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => {
        sentButtons.push({ text, rows });
        return { message_id: 100 };
      },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify: vi.fn(),
    } as Parameters<typeof bridgeCustomDialog>[0];

    const resultP = bridgeCustomDialog(deps);

    await new Promise((r) => setTimeout(r, 10));
    expect(sentButtons[0].text).toContain("(1/2)");
    // Go to page 2
    waitInputs[0]!("p:1");

    await new Promise((r) => setTimeout(r, 10));
    expect(sentButtons).toHaveLength(2);
    const page2 = sentButtons[1];
    expect(page2.text).toContain("(2/2)");
    // Page 2 has 2 option rows (options 11,12) + nav with Prev ◀ + Cancel, no Next
    expect(page2.rows).toHaveLength(3);
    const navRow = page2.rows[2];
    expect(navRow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "◀ Prev" }),
        expect.objectContaining({ text: "Cancel" }),
      ]),
    );
    expect(navRow.some((b) => b.text === "Next ▶")).toBe(false);

    // Toggle option 11 (global index 10 → s:10), then Submit → answer "Option 11"
    waitInputs[1]!("s:10");
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[2]!("submit");
    const result = await resultP;
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Option 11");
  });
});

// ---- bridgeCustomDialog: transport-error degrade ----

describe("bridgeCustomDialog — transport error degrade", () => {
  it("sendButtons rejection → cancelled:true + notify (confirmation branch)", async () => {
    const notify = vi.fn();
    const deps = {
      factory: stubFactory(CONFIRM_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async () => { throw new Error("Telegram 400: too many buttons"); },
      waitInput: () => new Promise<string | boolean | undefined>(() => {}), // never resolves; must not be reached
      notify,
    } as Parameters<typeof bridgeCustomDialog>[0];

    const result = await bridgeCustomDialog(deps);
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect((result as any).questions).toEqual([]);
    expect((result as any).answers).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("sendButtons rejection → cancelled:true + notify (single-question branch)", async () => {
    const notify = vi.fn();
    const deps = {
      factory: stubFactory(SINGLE_QUESTION_RENDER) as any,
      theme: {},
      width: 80,
      sendButtons: async () => { throw new Error("Telegram 400"); },
      waitInput: () => new Promise<string | boolean | undefined>(() => {}),
      notify,
    } as Parameters<typeof bridgeCustomDialog>[0];

    const result = await bridgeCustomDialog(deps);
    expect(result).toBeDefined();
    expect((result as any).cancelled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
// ---- bridgeCustomDialog: multi-question multi-select + Submit gating ----

describe("bridgeCustomDialog — multi-question single-select & Submit gating", () => {
  /** Build deps with a waitInputs queue and captured sentButtons for inspection. */
  function inspectableDeps(factory: unknown) {
    const waitInputs: Array<(v: string | boolean | undefined) => void> = [];
    const sentButtons: { text: string; rows: ButtonRow[] }[] = [];
    const deps = {
      factory: factory as any,
      theme: {},
      width: 80,
      sendButtons: async (text: string, rows: ButtonRow[]) => { sentButtons.push({ text, rows }); return { message_id: 100 }; },
      waitInput: () => new Promise<string | boolean | undefined>((r) => { waitInputs.push(r); }),
      notify: vi.fn(),
    } as Parameters<typeof bridgeCustomDialog>[0];
    return { deps, waitInputs, sentButtons };
  }

  const hasSubmit = (rows: ButtonRow[]) => rows.some((row) => row.some((b) => b.value === "submit"));

  it("single-select: picking another option replaces the prior pick (no join)", async () => {
    const { deps, waitInputs } = inspectableDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]));
    const resultP = bridgeCustomDialog(deps);
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[0]!("o:0"); // q1: pick Report only → auto-advance to q2
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[1]!("t:0"); // go back to q1
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[2]!("o:1"); // q1: change to Report + fix (replaces prior pick)
    await new Promise((r) => setTimeout(r, 10));
    // Auto-advanced back to q2 after re-answering q1; answer q2.
    waitInputs[3]!("o:1"); // q2: pick Code + tests
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[4]!("submit");
    const result = await resultP;
    const r = result as any;
    expect(r.cancelled).toBe(false);
    // Single answer per question — last pick wins, NOT a joined string.
    expect(r.answers[0]).toMatchObject({ id: "q1", answer: "Report + fix", wasCustom: false });
    expect(r.answers[1]).toMatchObject({ id: "q2", answer: "Code + tests", wasCustom: false });
  });

  it("option pick auto-advances to the next unanswered question", async () => {
    const { deps, waitInputs, sentButtons } = inspectableDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]));
    const resultP = bridgeCustomDialog(deps);
    await new Promise((r) => setTimeout(r, 10));
    // sentButtons[0] shows q1 (current question text).
    expect(sentButtons[0].text).toContain("What is the deliverable?");
    waitInputs[0]!("o:0"); // pick q1 option 0
    await new Promise((r) => setTimeout(r, 10));
    // After pick: auto-advanced to q2 (next unanswered) — q2 question text shows.
    expect(sentButtons[1].text).toContain("What dimensions to analyze?");
    expect(sentButtons[1].text).not.toContain("What is the deliverable?");
    // Cancel to end the flow cleanly.
    waitInputs[1]!("cancel");
    const result = await resultP;
    expect((result as any).cancelled).toBe(true);
  });

  it("Submit button only appears after every question is answered; placeholder lists unanswered ids", async () => {
    const { deps, waitInputs, sentButtons } = inspectableDeps(multiTabFactory([MQ_TAB0, MQ_TAB1]));
    const resultP = bridgeCustomDialog(deps);
    await new Promise((r) => setTimeout(r, 10));
    // Initially both unanswered: no Submit button, placeholder lists both.
    expect(hasSubmit(sentButtons[0].rows)).toBe(false);
    expect(sentButtons[0].text).toContain("Still to answer: q1, q2");

    waitInputs[0]!("o:0"); // answer q1
    await new Promise((r) => setTimeout(r, 10));
    // q1 answered, q2 still open: still no Submit, placeholder now only q2.
    expect(hasSubmit(sentButtons[1].rows)).toBe(false);
    expect(sentButtons[1].text).toContain("Still to answer: q2");
    expect(sentButtons[1].text).not.toContain("Still to answer: q1, q2");

    waitInputs[1]!("t:1"); // navigate to q2
    await new Promise((r) => setTimeout(r, 10));
    waitInputs[2]!("o:1"); // answer q2
    await new Promise((r) => setTimeout(r, 10));
    // All answered: no placeholder, Submit button now present.
    expect(hasSubmit(sentButtons[3].rows)).toBe(true);
    expect(sentButtons[3].text).not.toContain("Still to answer");

    waitInputs[3]!("submit");
    const result = await resultP;
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers).toHaveLength(2);
  });
});

// ---- createTelegramUiRuntime: interactive modals are Telegram-only (do NOT forward to base) ----

describe("createTelegramUiRuntime — interactive modals are Telegram-only (no base forwarding)", () => {
  function makeBaseRuntime(base: any) {
    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: async () => [{ message_id: 1 }],
      sendButtons: vi.fn(async () => ({ message_id: 1 })),
      editText: async () => undefined,
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    } as any;
    const theme = base.theme ?? { fg: (s: string) => s };
    const session = { extensionRunner: { getUIContext: () => ({ ...base, theme }) } } as any;
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    return { runtime, transport, chatId: 1 };
  }

  it("confirm: Telegram-only — base.confirm is NOT called; result comes from Telegram callback", async () => {
    const baseConfirm = vi.fn(() => new Promise<boolean>(() => {}));
    const { runtime, transport, chatId } = makeBaseRuntime({ confirm: baseConfirm });
    const ui = runtime.create(chatId);
    const resultP = ui.confirm("Save?", "Overwrite file?");
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    // base.confirm must not be invoked — modals are Telegram-only during a Telegram turn.
    expect(baseConfirm).not.toHaveBeenCalled();
    // Telegram user taps "Yes" (callback_data form: f:<flowId>:<value>).
    runtime.resolveInput(chatId, "f:1:yes", 1, true);
    expect(await resultP).toBe(true);
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("select: Telegram-only — base.select is NOT called; result comes from Telegram callback", async () => {
    const baseSelect = vi.fn(() => new Promise<string | undefined>(() => {}));
    const { runtime, transport, chatId } = makeBaseRuntime({ select: baseSelect });
    const ui = runtime.create(chatId);
    const resultP = ui.select("Pick", ["A", "B", "C"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    expect(baseSelect).not.toHaveBeenCalled();
    // Telegram user taps option B (index 1).
    runtime.resolveInput(chatId, "f:1:s:1", 1, true);
    expect(await resultP).toBe("B");
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("custom: Telegram-only — base.custom is NOT called; result comes from Telegram callback", async () => {
    const baseCustom = vi.fn(() => new Promise<any>(() => {}));
    const { runtime, transport, chatId } = makeBaseRuntime({ custom: baseCustom });
    const ui = runtime.create(chatId);
    const factory = stubFactory(CONFIRM_RENDER);
    const resultP = ui.custom(factory);
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    // base.custom must not be invoked — racing the TUI would leave the local TUI
    // dialog undismissible once Telegram wins (the stuck-selection bug).
    expect(baseCustom).not.toHaveBeenCalled();
    // Telegram user taps Confirm (callback_data form: f:<flowId>:<value>).
    runtime.resolveInput(chatId, "f:1:confirm", 1, true);
    const result = await resultP;
    expect((result as any).cancelled).toBe(false);
    expect((result as any).answers[0].answer).toBe("Confirm — create this goal now");
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("confirm with no base.confirm → falls back to Telegram-only (no crash); cancel resolves false", async () => {
    const { runtime, transport, chatId } = makeBaseRuntime({});
    const ui = runtime.create(chatId);
    const resultP = ui.confirm("Save?", "Overwrite?");
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    // Cancel via /stop semantics (latest flow, raw undefined).
    runtime.resolveInput(chatId, undefined);
    expect(await resultP).toBe(false);
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });
});
