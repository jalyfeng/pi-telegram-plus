/**
 * Adapter #4 — OMP's `askDialog` (§4.6.4).
 *
 * The dialog keeps its state inside its own component and describes it through
 * `describe()`: the question tabs (`omp.ask.questions`, items keyed by question
 * index and `submit` for the Review tab), the active question's option list
 * (`omp.ask.options`, keyed `q<index>`, with `selected` = the highlighted row
 * key and one `item` per row keyed `option:<n>` / `other`, a chosen row carrying
 * `tone: "accent"`) and the action buttons (`omp.btn` with `actions.click`).
 * Reads come from that tree only. Actions are `handleNativeEvent` events shaped
 * the way the host's own backend sends them: `select` on a row or a tab, `action`
 * on a button. No key is simulated and no cursor is inferred.
 *
 * The tree describes only the active question, so answers to the other questions
 * come from this adapter's own record: what it submitted, plus the checked rows
 * of the active list on every read.
 *
 * With a race handle on the entry (§4.12) nothing here reaches the host: the
 * answers collected in this state are turned straight into the `askDialog`
 * result the extension is awaiting, and the abort signal closes the host's dialog.
 */
import type { AdapterContext, AskQuestion, DialogAction, DialogAdapter, DialogItem, DialogModel, Question } from "../model.ts";
import type { RaceHandle } from "../race.ts";
import { describeTree, findDescribedNode, tspText, type DescribedNode, type NativeNodeLike } from "./tsp.ts";

type AskState = {
  /** Signature of the question list, so a reused component starts over. */
  signature: string;
  /** Raced dialogs only: the question the raced answers are collected for. */
  active: number;
  /** Answered option labels per question id: what the host shows for the active list, or what this adapter submitted. */
  answers: Map<string, string[]>;
  /** Free-text answers (raced dialogs only), keyed by question id; replaces that question's `answers`. */
  custom: Map<string, string>;
  /** Row signature of each question's option list as the last read saw it; an act on a list that changed since is refused. */
  rowsSeen: Map<number, string>;
};

const states = new WeakMap<object, AskState>();

const rowKeyOf = (questionIndex: number, label: string) => `${questionIndex}:${label}`;

function stateFor(component: object, questions: AskQuestion[]): AskState {
  const signature = questions.map((question) => `${question.id}|${question.options.length}|${question.multi === true}`).join(";");
  const existing = states.get(component);
  if (existing && existing.signature === signature) return existing;
  const fresh: AskState = {
    signature,
    active: 0,
    answers: new Map(),
    custom: new Map(),
    rowsSeen: new Map(),
  };
  states.set(component, fresh);
  return fresh;
}

/** Split an item key into its question index and option label; undefined for a
 * custom-answer row. */
function optionTarget(key: string): { index: number; label: string } | undefined {
  const separator = key.indexOf(":");
  if (separator < 0) return undefined;
  const index = Number.parseInt(key.slice(0, separator), 10);
  if (!Number.isInteger(index)) return undefined;
  return { index, label: key.slice(separator + 1) };
}

/** The `askDialog` submit result built from what was answered here: one entry
 * per question, in the order the extension asked them. */
function submitResult(questions: AskQuestion[], state: AskState): unknown {
  return {
    kind: "submit",
    results: questions.map((question) => {
      const customInput = state.custom.get(question.id);
      return {
        id: question.id,
        question: question.question,
        options: question.options.map((option) => option.label),
        multi: question.multi === true,
        selectedOptions: state.answers.get(question.id) ?? [],
        ...(customInput === undefined ? {} : { customInput }),
      };
    }),
  };
}

/** Hand the answers to the extension's own call and forget this component's
 * state: the abort signal is already closing the host's dialog. */
function commitAsk(component: object, state: AskState, questions: AskQuestion[], race: RaceHandle): boolean {
  const answered = race.answer(submitResult(questions, state));
  states.delete(component);
  return answered;
}

/** A raced ask dialog (§4.12): every action updates this adapter's answer state
 * and never the terminal; the last one settles the extension's call. Like the
 * hosted path below, `choose`/`toggle` follow the question's `multi` flag rather
 * than the action's type. */
function actRaced(component: object, action: DialogAction, state: AskState, questions: AskQuestion[], race: RaceHandle): boolean {
  if (action.type === "cancel") {
    states.delete(component);
    return race.answer(undefined);
  }
  if (action.type === "question") {
    if (action.index < 0 || action.index >= questions.length) return false;
    state.active = action.index;
    return true;
  }
  const onlyOne = questions.length === 1;
  if (action.type === "choose" || action.type === "toggle") {
    const target = optionTarget(action.key);
    const question = target ? questions[target.index] : undefined;
    if (!target || !question || !question.options.some((option) => option.label === target.label)) return false;
    if (question.multi === true) {
      const chosen = new Set(state.answers.get(question.id) ?? []);
      if (chosen.has(target.label)) chosen.delete(target.label);
      else chosen.add(target.label);
      state.answers.set(question.id, [...chosen]);
      return true;
    }
    state.answers.set(question.id, [target.label]);
    state.custom.delete(question.id);
    // One question asked: picking its option is the whole answer, so there is
    // nothing left to submit. Otherwise move on to the next question.
    if (onlyOne) return commitAsk(component, state, questions, race);
    state.active = Math.min(questions.length - 1, target.index + 1);
    return true;
  }
  if (action.type === "submit") {
    if (action.text !== undefined) {
      const question = questions[state.active];
      if (!question) return false;
      state.custom.set(question.id, action.text);
      state.answers.set(question.id, []);
      if (onlyOne) return commitAsk(component, state, questions, race);
      state.active = Math.min(questions.length - 1, state.active + 1);
      return true;
    }
    // The dialog's own submit: every question has to carry an answer first, and
    // "an answer" is what `read` draws a tick for - a chosen option or a typed one.
    const unanswered = questions.some((question) =>
      (state.answers.get(question.id)?.length ?? 0) === 0 && !state.custom.has(question.id));
    if (unanswered) return false;
    return commitAsk(component, state, questions, race);
  }
  return false;
}

/** The raced questionnaire: the answers this adapter holds, no host cursor. */
function readRaced(questions: AskQuestion[], state: AskState, title: string): DialogModel {
  const model: Question[] = questions.map((question, index) => {
    const chosen = state.answers.get(question.id) ?? [];
    const items: DialogItem[] = question.options.map((option, optionIndex) => ({
      key: rowKeyOf(index, option.label),
      label: option.label,
      description: option.description,
      checked: chosen.includes(option.label),
      current: question.recommended === optionIndex,
    }));
    const typed = state.custom.get(question.id);
    if (typed !== undefined) {
      // A typed answer is drawn as a checked read-only row: the `custom:` prefix
      // is not an option key, so no action points at it - only new text replaces
      // it.
      items.push({ key: `custom:${index}`, label: typed, checked: true });
    }
    return {
      id: question.id,
      prompt: question.question,
      multi: question.multi === true,
      allowCustom: question.allowCustom !== false,
      answered: chosen.length > 0 || typed !== undefined,
      items,
    };
  });
  return questionnaire(title, model, state.active);
}

function questionnaire(title: string, model: Question[], active: number): DialogModel {
  return {
    kind: "questionnaire",
    title,
    questions: model,
    active: Math.min(Math.max(0, active), Math.max(0, model.length - 1)),
    canSubmit: model.length > 0 && model.every((question) => question.answered),
  };
}

// ---- The hosted OMP dialog, read from its `describe()` tree -------------------

const isNode = (value: unknown): value is NativeNodeLike => typeof value === "object" && value !== null;

function propsOf(node: NativeNodeLike): Record<string, unknown> {
  return isNode(node.p) ? (node.p as Record<string, unknown>) : {};
}

const roleOf = (node: NativeNodeLike): string | undefined => {
  const role = propsOf(node).role;
  return typeof role === "string" ? role : undefined;
};

const isOptionsList = (node: NativeNodeLike) => node.k === "list" && roleOf(node) === "omp.ask.options";

const isTabs = (node: NativeNodeLike) => node.k === "tabs" && roleOf(node) === "omp.ask.questions";

/** An action button: the host's `actionButton` row, carrying the act it fires. */
function isButton(node: NativeNodeLike, act: string): boolean {
  if (roleOf(node) !== "omp.btn") return false;
  const actions = propsOf(node).actions;
  return isNode(actions) && (actions as { click?: unknown }).click === act;
}

/** The question index a list belongs to: the host keys each list `q<index>`. */
function questionIndexOf(list: NativeNodeLike): number | undefined {
  const match = /^q(\d+)$/.exec(String(list.key ?? ""));
  return match ? Number(match[1]) : undefined;
}

type LiveRow = { key: string; label: string; checked: boolean };

/** The rows of the active list as the host describes them now. */
function liveRows(list: NativeNodeLike): LiveRow[] {
  const children = Array.isArray(list.c) ? (list.c as unknown[]) : [];
  return children.filter(isNode).map((child) => ({
    key: String(child.key ?? ""),
    label: tspText(propsOf(child).label),
    checked: propsOf(child).tone === "accent",
  }));
}

/** Label-level signature of a list: a change in rows or their labels, not in what is checked. */
function rowsSignature(rows: LiveRow[]): string {
  return rows.map((row) => `${row.key}\t${row.label}`).join("\n");
}

/** The option labels the host shows as checked on a list. */
function checkedLabels(question: AskQuestion, rows: LiveRow[]): string[] {
  const labels: string[] = [];
  for (const row of rows) {
    if (!row.checked || !row.key.startsWith("option:")) continue;
    const label = question.options[Number(row.key.slice("option:".length))]?.label;
    if (label !== undefined) labels.push(label);
  }
  return labels;
}

/** The list still offers exactly the options the extension declared, in order,
 * and (when this adapter read it) the same rows it read. */
function optionRowsMatch(rows: LiveRow[], question: AskQuestion, seen: string | undefined): boolean {
  const optionKeys = rows.map((row) => row.key).filter((key) => key.startsWith("option:"));
  if (optionKeys.length !== question.options.length) return false;
  if (optionKeys.some((key, index) => key !== `option:${index}`)) return false;
  return seen === undefined || seen === rowsSignature(rows);
}

/** Send one host event to the component that owns the node it names. */
function fire(owner: object, event: unknown, ctx: AdapterContext): boolean {
  const handle = (owner as { handleNativeEvent?: unknown }).handleNativeEvent;
  if (typeof handle !== "function") return false;
  try {
    handle.call(owner, event);
  } catch {
    return false;
  }
  // The host repaints on request only; the event already changed its state.
  try {
    ctx.requestRender();
  } catch {
    // A host without a live renderer has nothing to redraw; the event landed.
  }
  return true;
}

/** Switch the host's question tabs to `id` (a question index, or `submit` for Review). */
function gotoTab(component: object, id: string, ctx: AdapterContext): boolean {
  const tabs = findDescribedNode(component, isTabs);
  if (!tabs) return false;
  const items = propsOf(tabs.node).items;
  if (!Array.isArray(items) || !items.some((item) => isNode(item) && (item as { id?: unknown }).id === id)) return false;
  return fire(tabs.owner, { type: "select", key: tabs.keypath, item: id }, ctx);
}

/** Make `index` the active question: nothing if it already is, else one tab event. */
function gotoQuestion(component: object, index: number, ctx: AdapterContext): boolean {
  const list = findDescribedNode(component, isOptionsList);
  if (list && questionIndexOf(list.node) === index) return true;
  return gotoTab(component, String(index), ctx);
}

/** Read the hosted dialog from its described tree. Answers are refreshed from the
 * active list's checked rows, so the record follows what the host shows. */
function readHosted(component: object, questions: AskQuestion[], state: AskState, title: string): DialogModel {
  if (!describeTree(component)) return { kind: "unsupported", what: "OMP ask dialog describes no questions" };
  const list = findDescribedNode(component, isOptionsList);
  const live = list ? questionIndexOf(list.node) : undefined;
  const rows = list ? liveRows(list.node) : [];
  const liveQuestion = live === undefined ? undefined : questions[live];
  if (list && live !== undefined && liveQuestion) {
    state.rowsSeen.set(live, rowsSignature(rows));
    state.answers.set(liveQuestion.id, checkedLabels(liveQuestion, rows));
  }
  const selected = list ? propsOf(list.node).selected : undefined;
  const model: Question[] = questions.map((question, index) => {
    const chosen = state.answers.get(question.id) ?? [];
    const isLive = index === live;
    const typedOnHost = isLive && rows.some((row) => row.checked && !row.key.startsWith("option:"));
    const items: DialogItem[] = question.options.map((option, optionIndex) => ({
      key: rowKeyOf(index, option.label),
      label: option.label,
      description: option.description,
      checked: chosen.includes(option.label),
      current: question.recommended === optionIndex,
      focused: isLive && selected === `option:${optionIndex}`,
    }));
    return {
      id: question.id,
      prompt: question.question,
      multi: question.multi === true,
      allowCustom: question.allowCustom !== false,
      answered: chosen.length > 0 || typedOnHost,
      items,
    };
  });
  return questionnaire(title, model, live ?? 0);
}

/** A hosted dialog act: every event is one the host's own backend would send,
 * refused when the tree no longer matches what the extension asked. */
function actHosted(component: object, action: DialogAction, state: AskState, questions: AskQuestion[], ctx: AdapterContext): boolean {
  if (action.type === "cancel") {
    states.delete(component);
    const cancel = findDescribedNode(component, (node) => isButton(node, "cancel"));
    return cancel ? fire(cancel.owner, { type: "action", key: cancel.keypath, act: "cancel" }, ctx) : ctx.sendKey("esc");
  }

  if (action.type === "question") {
    if (action.index < 0 || action.index >= questions.length) return false;
    return gotoQuestion(component, action.index, ctx);
  }

  if (action.type === "choose" || action.type === "toggle") {
    const target = optionTarget(action.key);
    const question = target ? questions[target.index] : undefined;
    if (!target || !question) return false;
    const optionIndex = question.options.findIndex((option) => option.label === target.label);
    if (optionIndex < 0) return false;
    if (!gotoQuestion(component, target.index, ctx)) return false;
    const list = findDescribedNode(component, isOptionsList);
    if (!list || questionIndexOf(list.node) !== target.index) return false;
    if (!optionRowsMatch(liveRows(list.node), question, state.rowsSeen.get(target.index))) return false;
    // A select on a row is the host's own pick: single-choice commits and moves
    // on, multi-choice toggles (the host reads `select` + `multi` as a toggle).
    if (!fire(list.owner, { type: "select", key: list.keypath, item: `option:${optionIndex}` }, ctx)) return false;
    if (question.multi === true) {
      const chosen = new Set(state.answers.get(question.id) ?? []);
      if (chosen.has(target.label)) chosen.delete(target.label);
      else chosen.add(target.label);
      state.answers.set(question.id, [...chosen]);
    } else {
      state.answers.set(question.id, [target.label]);
    }
    return true;
  }

  if (action.type === "submit") {
    // Typed answers exist only on the raced path (§4.12); the hosted dialog gets
    // them from its own input, which this adapter does not drive.
    if (action.text !== undefined) return false;
    if (!questions.every((question) => (state.answers.get(question.id)?.length ?? 0) > 0)) return false;
    // Submit on a question tab would commit that tab's highlighted row, so go to
    // the Review tab first and press its Submit button there.
    const onReview = findDescribedNode(component, isOptionsList) === undefined;
    if (findDescribedNode(component, isTabs) && !onReview && !gotoTab(component, "submit", ctx)) return false;
    const submit: DescribedNode | undefined = findDescribedNode(component, (node) => isButton(node, "submit"));
    return submit ? fire(submit.owner, { type: "action", key: submit.keypath, act: "submit" }, ctx) : false;
  }

  return false;
}

export const askDialogAdapter: DialogAdapter = {
  id: "omp-ask",

  detect(_component, ctx) {
    return ctx.entry?.kind === "ask" && (ctx.entry?.questions?.length ?? 0) > 0;
  },

  read(component, ctx): DialogModel {
    const questions = ctx.entry?.questions ?? [];
    const state = stateFor(component, questions);
    const title = ctx.entry?.title ?? "Questionnaire";
    // A live race handle means the extension's own `askDialog` call is still
    // open: the answers held here are the dialog (§4.12).
    const race = ctx.entry?.kind === "ask" ? ctx.entry.race : undefined;
    if (race && !race.settled) return readRaced(questions, state, title);
    return readHosted(component, questions, state, title);
  },

  act(component, action, ctx) {
    const questions = ctx.entry?.questions ?? [];
    if (questions.length === 0) return false;
    const state = stateFor(component, questions);
    // A live race handle means the extension's own `askDialog` call is still
    // open: answer it instead of driving the terminal (§4.12).
    const race = ctx.entry?.kind === "ask" ? ctx.entry.race : undefined;
    if (race && !race.settled) return actRaced(component, action, state, questions, race);
    return actHosted(component, action, state, questions, ctx);
  },
};
