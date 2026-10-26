/**
 * OMP's `askDialog` keeps its real state in a closure, so this adapter infers the
 * option cursor it sends keys from (§4.6.4). The inference is what these tests pin:
 * the host parks the cursor on the recommended option when a question opens, so the
 * arrow keys for a tapped row must be counted from there. Counting from the top
 * instead sends the answer back one row away from the row the user pressed.
 */
import { describe, expect, it } from "vitest";
import { askDialogAdapter } from "../tui/adapters/ask.ts";
import { installRace, takePendingRace, type RaceHandle } from "../tui/race.ts";
import type { AdapterContext, AskQuestion, EntryInfo } from "../tui/model.ts";

function context(questions: AskQuestion[]) {
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
  // A fresh component per case: the adapter keeps its guess per component instance.
  return { component: {} as Record<string, unknown>, ctx, keys };
}

const colour: AskQuestion = {
  id: "colour",
  question: "Pick a color for the acceptance run",
  options: [{ label: "red" }, { label: "green" }, { label: "blue" }],
  recommended: 1,
};

describe("omp ask dialog adapter", () => {
  it("marks the recommended row as the row the host is on", () => {
    const { component, ctx } = context([colour]);
    const model = askDialogAdapter.read(component, ctx);
    expect(model.kind).toBe("questionnaire");
    const items = model.kind === "questionnaire" ? model.questions[0]?.items ?? [] : [];
    expect(items.map((item) => item.focused)).toEqual([false, true, false]);
  });

  it("counts arrow keys from the recommended row, not from the top", () => {
    const { component, ctx, keys } = context([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    expect(keys).toEqual(["down", "enter"]);
  });

  it("moves up when the tapped row sits above the recommended one", () => {
    const { component, ctx, keys } = context([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:red" }, ctx)).toBe(true);
    expect(keys).toEqual(["up", "enter"]);
  });

  it("starts the next question on its own recommended row", () => {
    const size: AskQuestion = {
      id: "size",
      question: "How large?",
      options: [{ label: "small" }, { label: "large" }],
      recommended: 1,
    };
    const { component, ctx, keys } = context([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "1:small" }, ctx)).toBe(true);
    // Reaching question two means Tab, then one Up from the row it opens on.
    expect(keys).toEqual(["tab", "up", "enter"]);
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
