/**
 * OMP's `askDialog` is read from the component's own `describe()` tree and driven
 * with `handleNativeEvent` events. Nothing here infers a cursor from the recommended
 * row and nothing sends keys. The fake below describes the shape the host uses -
 * tabs `omp.ask.questions` in a `head` row, the active question's list `q<index>`
 * (role `omp.ask.options`, `selected` = the highlighted row key, rows `option:<n>`,
 * a chosen row carrying `tone: "accent"`) and the action buttons `omp.btn` with
 * `actions.click` - and records every event it is sent.
 */
import { describe, expect, it } from "vitest";
import { askDialogAdapter } from "../tui/adapters/ask.ts";
import { installRace, takePendingRace, type RaceHandle } from "../tui/race.ts";
import type { AdapterContext, AskQuestion, DialogModel, EntryInfo, Question } from "../tui/model.ts";

type FakeRow = { key: string; label: string; checked?: boolean };

type FakeAsk = {
  /** The active question; `questions.length` stands for the Review tab. */
  active: number;
  /** Rows of each question's list, as the host currently draws them. */
  lists: FakeRow[][];
  /** The highlighted row key of each question's list. */
  selected: string[];
  /** Whether the action bar carries Submit and Skip buttons. */
  buttons: boolean;
  events: unknown[];
  describe(cx: unknown): unknown;
  handleNativeEvent(event: unknown): void;
};

/** A component describing `questions` the way the host does; `selected` starts on row 0. */
function fakeAsk(questions: AskQuestion[]): FakeAsk {
  const fake: FakeAsk = {
    active: 0,
    lists: questions.map((question) => question.options.map((option, index) => ({ key: `option:${index}`, label: option.label }))),
    selected: questions.map(() => "option:0"),
    buttons: true,
    events: [],
    describe() {
      const children: unknown[] = [];
      if (questions.length > 1) {
        const items = [
          ...questions.map((question, index) => ({ id: String(index), label: [{ t: question.question }] })),
          { id: "submit", label: [{ t: "Review" }] },
        ];
        children.push({
          k: "row",
          key: "head",
          p: { role: "omp.ask.head" },
          c: [{ k: "tabs", key: "tabs", p: { items, active: String(fake.active), role: "omp.ask.questions", actions: { click: "select" } } }],
        });
      }
      if (fake.active < questions.length) {
        children.push({
          k: "list",
          key: `q${fake.active}`,
          p: { selected: fake.selected[fake.active], role: "omp.ask.options" },
          c: (fake.lists[fake.active] ?? []).map((row) => ({
            k: "item",
            key: row.key,
            p: { label: [{ t: row.label }], role: "omp.ask.option", ...(row.checked ? { tone: "accent" } : {}) },
          })),
        });
      }
      const buttons = fake.buttons
        ? [
            { k: "row", p: { role: "omp.btn", actions: { click: "cancel" } }, c: [] },
            { k: "row", p: { role: "omp.btn", actions: { click: "submit" } }, c: [] },
          ]
        : [];
      children.push({ k: "row", key: "actions", p: { role: "omp.actions" }, c: buttons });
      return { k: "col", p: { role: "omp.editor.ask" }, c: children };
    },
    handleNativeEvent(event: unknown) {
      fake.events.push(event);
      const record = event as { type?: string; key?: string; item?: string };
      if (record.type === "select" && record.key === "head/tabs") {
        fake.active = record.item === "submit" ? questions.length : Number(record.item);
      }
    },
  };
  return fake;
}

/** A hosted context: the fake component plus the key log the assertions check stays empty. */
function hosted(questions: AskQuestion[]) {
  const keys: string[] = [];
  const entry: EntryInfo = { kind: "ask", method: "askDialog", source: "omp", questions };
  const ctx: AdapterContext = {
    host: "omp",
    entry,
    sendKey: (name: string) => {
      keys.push(name);
      return true;
    },
    requestRender: () => undefined,
  };
  return { component: fakeAsk(questions), ctx, keys };
}

const colour: AskQuestion = {
  id: "colour",
  question: "Pick a color for the acceptance run",
  options: [{ label: "red" }, { label: "green" }, { label: "blue" }],
  recommended: 1,
};

const size: AskQuestion = {
  id: "size",
  question: "How large?",
  options: [{ label: "small" }, { label: "large" }],
  recommended: 1,
};

/** The questionnaire model, asserted as such. */
function questionnaire(model: DialogModel): Question[] {
  if (model.kind !== "questionnaire") throw new Error(`expected a questionnaire, got ${model.kind}`);
  return model.questions;
}

describe("omp ask dialog adapter, hosted", () => {
  it("reads the highlighted row from the host tree, not the recommended one", () => {
    const { component, ctx } = hosted([colour]);
    component.selected[0] = "option:0";
    const model = askDialogAdapter.read(component, ctx);
    const items = questionnaire(model)[0]?.items ?? [];
    expect(items.map((item) => item.focused)).toEqual([true, false, false]);
    expect(items.map((item) => item.current)).toEqual([false, true, false]);
  });

  it("chooses a row with one select event on the list and sends no key", () => {
    const { component, ctx, keys } = hosted([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    expect(component.events).toEqual([{ type: "select", key: "q0", item: "option:2" }]);
    expect(keys).toEqual([]);
  });

  it("sends a multi-choice row as one select event too, since the host toggles on select", () => {
    const { component, ctx, keys } = hosted([flavours]);
    expect(askDialogAdapter.act(component, { type: "toggle", key: "0:chocolate" }, ctx)).toBe(true);
    expect(component.events).toEqual([{ type: "select", key: "q0", item: "option:1" }]);
    expect(keys).toEqual([]);
  });

  it("switches the host's tabs first when the row belongs to another question", () => {
    const { component, ctx, keys } = hosted([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "1:small" }, ctx)).toBe(true);
    expect(component.events).toEqual([
      { type: "select", key: "head/tabs", item: "1" },
      { type: "select", key: "q1", item: "option:0" },
    ]);
    expect(component.active).toBe(1);
    expect(keys).toEqual([]);
  });

  it("refuses a choose when the list lost a row since it was read, instead of sending a wrong row", () => {
    const { component, ctx } = hosted([colour]);
    askDialogAdapter.read(component, ctx);
    component.lists[0] = [component.lists[0]?.[0], component.lists[0]?.[2]].filter((row): row is FakeRow => row !== undefined);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:green" }, ctx)).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("refuses a choose when a row was relabelled since it was read", () => {
    const { component, ctx } = hosted([colour]);
    askDialogAdapter.read(component, ctx);
    const row = component.lists[0]?.[1];
    if (row) row.label = "teal";
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:green" }, ctx)).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("refuses a choose on a list that no longer matches the declared options, even without a read", () => {
    const { component, ctx } = hosted([colour]);
    component.lists[0] = [{ key: "option:0", label: "red" }];
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("cancels through the tree's cancel button, not Esc", () => {
    const { component, ctx, keys } = hosted([colour]);
    expect(askDialogAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "actions/0", act: "cancel" }]);
    expect(keys).toEqual([]);
  });

  it("falls back to Esc only when the tree offers no cancel button", () => {
    const { component, ctx, keys } = hosted([colour]);
    component.buttons = false;
    expect(askDialogAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(component.events).toEqual([]);
    expect(keys).toEqual(["esc"]);
  });

  it("reads the answers the host shows as checked on the active list", () => {
    const { component, ctx } = hosted([colour]);
    component.lists[0] = component.lists[0]?.map((row) => (row.key === "option:2" ? { ...row, checked: true } : row)) ?? [];
    const model = questionnaire(askDialogAdapter.read(component, ctx));
    expect(model[0]?.answered).toBe(true);
    expect(model[0]?.items.map((item) => item.checked)).toEqual([false, false, true]);
    expect(askDialogAdapter.read(component, ctx)).toMatchObject({ canSubmit: true });
  });

  it("keeps the answer submitted for an earlier question when the host shows a later one", () => {
    const { component, ctx } = hosted([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:green" }, ctx)).toBe(true);
    component.active = 1;
    const model = questionnaire(askDialogAdapter.read(component, ctx));
    expect(model[0]?.answered).toBe(true);
    expect(model[0]?.items.map((item) => item.checked)).toEqual([false, true, false]);
    expect(model[1]?.answered).toBe(false);
  });

  it("goes to the Review tab before pressing Submit, and presses the tree's Submit button", () => {
    const { component, ctx, keys } = hosted([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    expect(askDialogAdapter.act(component, { type: "choose", key: "1:small" }, ctx)).toBe(true);
    component.events = [];
    expect(askDialogAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(component.events).toEqual([
      { type: "select", key: "head/tabs", item: "submit" },
      { type: "action", key: "actions/1", act: "submit" },
    ]);
    expect(keys).toEqual([]);
  });

  it("refuses to submit while a question is still unanswered", () => {
    const { component, ctx } = hosted([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    expect(askDialogAdapter.act(component, { type: "submit" }, ctx)).toBe(false);
    expect(component.events).toEqual([{ type: "select", key: "q0", item: "option:2" }]);
  });
});

/** What an extension gets back from `askDialog`; typed loosely for the assertions. */
type AskValue = { kind?: string; results?: Array<Record<string, unknown>> };

/**
 * The raced path (§4.12): `askDialog` is wrapped exactly as it is on OMP's tool
 * UI context, so the handle the adapter answers is the promise the extension
 * awaits, and no keystroke may reach the terminal. OMP's signature is
 * `askDialog(questions, dialogOptions?)`, so the object carrying `signal` sits
 * at index 1 and the question array stays at index 0.
 */
function raceContext(questions: AskQuestion[]) {
  const keys: string[] = [];
  const seen: Array<{ questions: unknown; opts: { signal?: AbortSignal } | undefined; handle: RaceHandle | undefined }> = [];
  const settle: Array<(value: unknown) => void> = [];
  const target: Record<string, unknown> = {
    askDialog(askQuestions: unknown, opts?: { signal?: AbortSignal }) {
      // The handle only exists while the wrapped call runs: on the real host the
      // entry wrapper takes it here, inside the entry call.
      const handle = takePendingRace();
      seen.push({ questions: askQuestions, opts, handle });
      const { promise, resolve } = Promise.withResolvers<unknown>();
      settle.push(resolve);
      return promise;
    },
  };
  expect(installRace(target, "askDialog")).toBe(true);
  // The wrapped method is a function on a `Record<string, unknown>`: the cast
  // just restores the signature the fake host above implements.
  const ask = target.askDialog as (q: unknown, o?: { signal?: AbortSignal }) => Promise<AskValue>;
  const answered = ask(questions, {});
  const handle = seen[0]?.handle;
  if (!handle) throw new Error("the wrapped askDialog call must carry a race handle");
  const entry: EntryInfo = { kind: "ask", method: "askDialog", source: "omp", questions, race: handle };
  const ctx: AdapterContext = {
    host: "omp",
    entry,
    sendKey: (name: string) => {
      keys.push(name);
      return true;
    },
    requestRender: () => undefined,
  };
  return { component: {} as Record<string, unknown>, ctx, keys, seen, settle, handle, answered };
}

const flavours: AskQuestion = {
  id: "flavours",
  question: "Which flavors?",
  options: [{ label: "vanilla" }, { label: "chocolate" }, { label: "strawberry" }],
  multi: true,
};

const colourResult = (selectedOptions: string[], customInput?: string) => ({
  id: "colour",
  question: colour.question,
  options: ["red", "green", "blue"],
  multi: false,
  selectedOptions,
  ...(customInput === undefined ? {} : { customInput }),
});

describe("omp ask dialog adapter with a race handle", () => {
  it("puts the signal in the options at index 1 and keeps the questions at index 0", () => {
    const questions = [colour];
    const { seen } = raceContext(questions);
    expect(seen[0]?.questions).toBe(questions);
    expect(seen[0]?.opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers the extension's call on the first tap when one question was asked", async () => {
    const { component, ctx, keys, seen, answered } = raceContext([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:green" }, ctx)).toBe(true);
    expect(keys).toEqual([]);
    await expect(answered).resolves.toEqual({ kind: "submit", results: [colourResult(["green"])] });
    // A question nobody typed an answer for carries no `customInput` key at all.
    const value = await answered;
    expect(Object.keys(value.results?.[0] ?? {})).not.toContain("customInput");
    // The host's dialog is closed through the signal, not through a key.
    expect(seen[0]?.opts?.signal?.aborted).toBe(true);
  });

  it("collects a single-choice and a multi-choice answer, then submits once", async () => {
    const { component, ctx, keys, handle, answered } = raceContext([colour, flavours]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    // One question left: the choice moved the dialog along instead of submitting.
    expect(handle.settled).toBe(false);
    expect(askDialogAdapter.act(component, { type: "toggle", key: "1:vanilla" }, ctx)).toBe(true);
    expect(askDialogAdapter.act(component, { type: "toggle", key: "1:strawberry" }, ctx)).toBe(true);
    const model = askDialogAdapter.read(component, ctx);
    expect(model.kind === "questionnaire" && model.active).toBe(1);
    expect(model.kind === "questionnaire" && model.canSubmit).toBe(true);
    expect(askDialogAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(keys).toEqual([]);
    await expect(answered).resolves.toEqual({
      kind: "submit",
      results: [
        colourResult(["blue"]),
        {
          id: "flavours",
          question: flavours.question,
          options: ["vanilla", "chocolate", "strawberry"],
          multi: true,
          selectedOptions: ["vanilla", "strawberry"],
        },
      ],
    });
  });

  it("refuses to submit while a question is still unanswered", () => {
    const { component, ctx, handle } = raceContext([colour, flavours]);
    expect(askDialogAdapter.act(component, { type: "toggle", key: "1:vanilla" }, ctx)).toBe(true);
    expect(askDialogAdapter.act(component, { type: "submit" }, ctx)).toBe(false);
    expect(handle.settled).toBe(false);
  });

  it("turns typed text into customInput and draws it as a checked row", async () => {
    const { component, ctx, keys, answered } = raceContext([colour, flavours]);
    expect(askDialogAdapter.act(component, { type: "submit", text: "magenta" }, ctx)).toBe(true);
    const model = askDialogAdapter.read(component, ctx);
    const first = model.kind === "questionnaire" ? model.questions[0] : undefined;
    expect(first?.answered).toBe(true);
    expect(first?.items[first.items.length - 1]).toMatchObject({ label: "magenta", checked: true });
    // The typed row is not an option, so tapping it does nothing.
    expect(askDialogAdapter.act(component, { type: "choose", key: "custom:0" }, ctx)).toBe(false);
    expect(askDialogAdapter.act(component, { type: "toggle", key: "1:chocolate" }, ctx)).toBe(true);
    expect(askDialogAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(keys).toEqual([]);
    await expect(answered).resolves.toEqual({
      kind: "submit",
      results: [
        colourResult([], "magenta"),
        {
          id: "flavours",
          question: flavours.question,
          options: ["vanilla", "chocolate", "strawberry"],
          multi: true,
          selectedOptions: ["chocolate"],
        },
      ],
    });
  });

  it("submits typed text straight away when one question was asked", async () => {
    const { component, ctx, answered } = raceContext([colour]);
    expect(askDialogAdapter.act(component, { type: "submit", text: "magenta" }, ctx)).toBe(true);
    await expect(answered).resolves.toEqual({ kind: "submit", results: [colourResult([], "magenta")] });
  });

  it("aborts the tool call on cancel, like Esc, without a key", async () => {
    const { component, ctx, keys, answered } = raceContext([colour]);
    expect(askDialogAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(keys).toEqual([]);
    await expect(answered).resolves.toBeUndefined();
  });
});
