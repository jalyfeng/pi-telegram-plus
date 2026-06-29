/**
 * Bridge for pi-goal's `custom()` dialogs to Telegram inline buttons.
 *
 * Layer B of the Telegram interaction plan: pi-goal's `ctx.ui.custom(factory)`
 * instantiates a opaque TUI component. We instantiate the factory with a minimal
 * tui shim, render it to text, detect the dialog shape by its rendered output,
 * and drive Telegram inline buttons accordingly.
 *
 * Safety invariant (non-negotiable): any detection failure or transport error
 * returns a cancelled structured result ({ questions: [], answers: [],
 * cancelled: true }), never hangs, never throws, never returns `undefined`.
 * pi-goal's `runGoalQuestionnaire` accesses `result.cancelled` / `result.answers`
 * without an undefined-guard, so returning `undefined` would cause a TypeError.
 */

import { escapeHtml } from "./html.ts";

/** Strip ANSI SGR escape codes from a string (one-line regex, no pi-core deps). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

export type ButtonRow = { text: string; value: string }[];

export interface BridgeCustomDialogDeps {
  /** The opaque factory from `ctx.ui.custom(factory)`. */
  factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown | Promise<unknown>;
  /** The real TUI theme (for factory instantiation — theme.fg/bg must work). */
  theme: unknown;
  /** Render width in columns (default 80). */
  width?: number;
  /** Send an inline-button message to Telegram. Button values are raw (un-encoded). */
  sendButtons: (text: string, rows: ButtonRow[]) => Promise<{ message_id: number }>;
  /** Wait for user input. Returns the raw callback value, typed text, or undefined (cancel/timeout). */
  waitInput: (acceptsText?: boolean, sensitive?: boolean) => Promise<string | boolean | undefined>;
  /** Send a notification to the Telegram chat. */
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

// ---- pi-goal literal strings (from showProposalDialog) ----
const CONFIRM_ANSWER = "Confirm — create this goal now";
const CONTINUE_ANSWER = "Continue chatting — keep refining";

const MAX_BUTTON_TEXT = 60;

type DialogShape = "confirmation" | "single-question" | "multi-question" | "unknown";

/** Minimal tui shim satisfying what pi-goal's Editor needs: requestRender + terminal.rows. */
function buildTuiShim(): { requestRender(): void; terminal: { rows: number } } {
  return { requestRender: () => {}, terminal: { rows: 80 } };
}

function truncateLabel(text: string, max = MAX_BUTTON_TEXT): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// ---- Shape detection (operates on ANSI-stripped render text) ----

function detectShape(text: string): DialogShape {
  // Multi-question questionnaires show a tab bar with "✓ Submit".
  if (text.includes("✓ Submit")) return "multi-question";
  // Confirmation dialog: known header + known trailing options.
  if (/Confirm (Sisyphus )?Goal Draft/.test(text) && text.includes(CONFIRM_ANSWER)) return "confirmation";
  // Single-question: has numbered option lines or a free-text prompt.
  if (/^\s*[>]?\s*\d+\.\s+/m.test(text) || text.includes("Press Enter to write your answer")) return "single-question";
  return "unknown";
}

function extractConfirmationHeader(text: string): string {
  const m = text.match(/Confirm (Sisyphus )?Goal Draft/);
  return m ? m[0] : "Confirm Goal Draft";
}

/** Extract question/context text: content lines between the top dash line and the first option row. */
function extractContentLines(lines: string[]): string[] {
  const content: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^─+$/.test(trimmed)) {
      if (content.length > 0) break; // bottom border
      continue; // skip top border
    }
    if (trimmed === "") {
      if (content.length > 0) break; // blank line after content
      continue;
    }
    if (/navigate.*cancel/.test(trimmed)) continue; // hint line
    if (/Press Enter to write/.test(trimmed)) continue;
    if (/^\s*[>]?\s*\d+\.\s+/.test(trimmed)) break; // option line
    if (/Write your own answer/.test(trimmed)) break;
    content.push(trimmed);
  }
  return content;
}

/** Extract option labels from rendered numbered lines, stripping selection marker and recommended star. */
function extractOptions(lines: string[]): string[] {
  const options: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[>]?\s*\d+\.\s+(.+)$/);
    if (m) {
      const label = m[1].replace(/\s*★$/, "").trim();
      if (label !== "Write your own answer...") options.push(label);
    }
  }
  return options;
}

function hasCustomOption(lines: string[]): boolean {
  return lines.some((l) => l.includes("Write your own answer..."));
}

// ---- Multi-question questionnaire support ----
// pi-goal's goal_questionnaire renders ONE tab at a time (the current question
// + its options) behind an opaque `custom(factory)` component. A single render
// only exposes the first question; the other questions' options are hidden until
// the user switches tabs. To bridge the whole questionnaire to Telegram we drive
// the opaque component ourselves: send a raw Tab byte ("\t", what matchesKey(…,
// Key.tab) accepts) to cycle tabs and render each, extracting every question's
// text/options. We then run a tab-style Telegram flow mirroring the TUI
// (per-question option buttons + Prev/Next tab navigation + Submit) and return a
// constructed GoalQuestionnaireResult — bypassing the component's `done`, the
// same way the confirmation and single-question paths do.

interface ParsedQuestion {
  id: string;
  question: string;
  context: string;
  options: string[];
  allowCustom: boolean;
  recommended: number; // 0-based option index, -1 if none
}

/** Raw terminal byte that matchesKey(…, Key.tab) accepts (pi-tui keys.js). */
const TAB_KEY = "\t";

/** Extract the ordered question ids from the multi-question tab bar line. */
function parseTabBarIds(text: string): string[] {
  const tabLine = text.split("\n").find((l) => l.includes("Submit") && l.includes("←"));
  if (!tabLine) return [];
  const ids: string[] = [];
  for (const m of tabLine.matchAll(/[□■]\s+(\S+)/g)) {
    const id = m[1];
    if (id && id !== "Submit") ids.push(id);
  }
  return ids;
}

/**
 * Extract the current tab's question text + context from a rendered tab.
 * Skips the top border, the tab bar (line with ←/Submit/→), and the hint line;
 * stops at the first option row or the bottom border.
 */
function extractTabContent(lines: string[]): { question: string; context: string } {
  const content: string[] = [];
  let sawTabBar = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^─+$/.test(t)) { if (content.length > 0) break; continue; }
    if (t.includes("Submit") && t.includes("←")) { sawTabBar = true; continue; }
    if (t === "") { if (content.length > 0) break; continue; }
    if (/navigate.*cancel/.test(t)) continue;
    if (/Press Enter to write/.test(t)) continue;
    if (/^\s*[>]?\s*\d+\.\s+/.test(t)) break; // option row
    if (/Write your own answer/.test(t)) break;
    if (!sawTabBar) continue; // pre-tab-bar noise (shouldn't happen)
    content.push(t);
  }
  return { question: content[0] ?? "", context: content.slice(1).join("\n") };
}

/** Parse one rendered tab into a ParsedQuestion (options, recommended, custom flag). */
function parseTabQuestion(lines: string[], id: string): ParsedQuestion {
  const stripped = lines.map(stripAnsi);
  const text = stripped.join("\n");
  const textLines = text.split("\n");
  const { question, context } = extractTabContent(textLines);
  const options: string[] = [];
  let recommended = -1;
  for (const line of textLines) {
    const m = line.match(/^\s*[>]?\s*(\d+)\.\s+(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      let label = m[2];
      const isRec = /\s*★\s*$/.test(label);
      label = label.replace(/\s*★\s*$/, "").trim();
      if (label === "Write your own answer...") continue;
      options.push(label);
      if (isRec) recommended = idx;
    }
  }
  const allowCustom = options.length === 0 ? true : hasCustomOption(textLines);
  return { id, question: question || id, context, options, allowCustom, recommended };
}

/**
 * Per-question selection state for the Telegram multi-select flows.
 *
 * pi-goal's questionnaire model is single-answer-per-question (answer: string),
 * but on Telegram we let the user toggle multiple options for one question and
 * join them into a single string before returning (the pi-goal contract is
 * unchanged — see the goal contract). `selected` holds toggled option indices;
 * `wasCustom` + `custom` hold a free-text answer that replaces the selection.
 */
interface QState {
  selected: Set<number>;
  custom: string | undefined;
  wasCustom: boolean;
}

function newState(): QState {
  return { selected: new Set<number>(), custom: undefined, wasCustom: false };
}

/** A question is answered if it has at least one toggled option or a custom text. */
function qAnswered(s: QState): boolean {
  if (s.wasCustom) return s.custom !== undefined && s.custom.trim().length > 0;
  return s.selected.size > 0;
}

/** Build the single-string answer pi-goal expects: joined options, or custom text. */
function qAnswer(s: QState, options: string[]): string {
  if (s.wasCustom && s.custom !== undefined) return s.custom.trim();
  return [...s.selected].sort((a, b) => a - b).map((i) => options[i]).join(" / ");
}

/** Toggle an option index in a question state, clearing any prior custom answer. */
function toggleOption(s: QState, idx: number): void {
  if (s.wasCustom) { s.wasCustom = false; s.custom = undefined; }
  if (s.selected.has(idx)) s.selected.delete(idx);
  else s.selected.add(idx);
}

/** Set a custom (free-text) answer, replacing any prior option selection. */
function setCustom(s: QState, text: string): void {
  s.wasCustom = true;
  s.custom = text;
  s.selected.clear();
}

/** Join selected option labels for the Telegram message preview. */
function selectedPreview(s: QState, options: string[]): string {
  if (s.wasCustom && s.custom) return `(custom) ${s.custom}`;
  if (s.selected.size === 0) return "";
  return [...s.selected].sort((a, b) => a - b).map((i) => options[i]).join(" / ");
}

const CANCELLED_RESULT = <T,>() => ({ questions: [], answers: [], cancelled: true }) as T;

/**
 * Run a tab-style Telegram flow for a multi-question questionnaire, mirroring
 * the TUI. Per-question options are multi-select toggles (no forced auto-advance
 * on pick); the user navigates tabs freely with ◀ Tab / Tab ▶. The Submit button
 * only appears once every question is answered; before that the message shows a
 * "Still to answer: …" placeholder. Returns a constructed GoalQuestionnaireResult.
 */
async function runMultiQuestionFlow(
  questions: ParsedQuestion[],
  deps: BridgeCustomDialogDeps,
): Promise<{ questions: ParsedQuestion[]; answers: { id: string; question: string; answer: string; wasCustom: boolean }[]; cancelled: boolean }> {
  const n = questions.length;
  const states: QState[] = questions.map(() => newState());
  let current = 0;
  let page = 0;
  const PAGE_SIZE = 8;

  const answeredAll = () => states.every((s) => qAnswered(s));
  const unansweredIds = () => questions.filter((_, i) => !qAnswered(states[i])).map((q) => q.id);

  const buildText = () => {
    const tabsLine = questions
      .map((q, i) => {
        const mark = qAnswered(states[i]) ? "■" : "□";
        const cur = i === current ? "▸" : " ";
        return `${cur}${mark} ${q.id}`;
      })
      .join("  ");
    const q = questions[current];
    if (!q) return `<b>${escapeHtml(tabsLine)}</b>`;
    const ctx = q.context ? `\n${escapeHtml(q.context)}` : "";
    const preview = selectedPreview(states[current], q.options);
    const selLine = preview ? `\nSelected: ${escapeHtml(preview)}` : "";
    const tail = answeredAll() ? "" : `\n⚠️ Still to answer: ${unansweredIds().join(", ")}`;
    return `<b>${escapeHtml(tabsLine)}</b>\n\n<b>${escapeHtml(q.question)}</b>${ctx}${selLine}${tail}\n<i>Question ${current + 1}/${n}</i>`;
  };

  const buildRows = (): ButtonRow[] => {
    const q = questions[current];
    if (!q) return [[{ text: "Cancel", value: "cancel" }]];
    const start = page * PAGE_SIZE;
    const pageOpts = q.options.slice(start, start + PAGE_SIZE);
    const rows: ButtonRow[] = pageOpts.map((label, i) => {
      const absIdx = start + i;
      const sel = states[current].selected.has(absIdx);
      const mark = sel ? "☑" : "☐";
      const rec = absIdx === q.recommended ? " ★" : "";
      return [{ text: truncateLabel(`${mark} ${absIdx + 1}. ${label}${rec}`), value: `o:${absIdx}` }];
    });
    const nav: { text: string; value: string }[] = [];
    const pageCount = Math.max(1, Math.ceil(q.options.length / PAGE_SIZE));
    if (page > 0) nav.push({ text: "◀", value: `op:${page - 1}` });
    if (page < pageCount - 1) nav.push({ text: "▶", value: `op:${page + 1}` });
    if (current > 0) nav.push({ text: "◀ Tab", value: `t:${current - 1}` });
    if (current < n - 1) nav.push({ text: "Tab ▶", value: `t:${current + 1}` });
    if (q.allowCustom || q.options.length === 0) nav.push({ text: "✏️ Type", value: "custom" });
    // Submit only appears once every question is answered (terminal-state gate).
    if (answeredAll()) nav.push({ text: "✓ Submit", value: "submit" });
    nav.push({ text: "Cancel", value: "cancel" });
    rows.push(nav);
    return rows;
  };

  const cancelled = { questions, answers: [], cancelled: true };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await deps.sendButtons(buildText(), buildRows());
    } catch {
      deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
      return cancelled;
    }

    let value: string | boolean | undefined;
    try {
      value = await deps.waitInput(false, false);
    } catch {
      deps.notify("⚠️ Dialog input failed; the agent will continue.", "warning");
      return cancelled;
    }

    if (typeof value !== "string") return cancelled; // undefined (timeout/stop) or unexpected
    if (value === "cancel") return cancelled;

    if (value === "submit") {
      if (answeredAll()) {
        const orderedAnswers = questions.map((q, i) => ({
          id: q.id,
          question: q.question,
          answer: qAnswer(states[i], q.options),
          wasCustom: states[i].wasCustom,
        }));
        return { questions, answers: orderedAnswers, cancelled: false };
      }
      // No Submit button is rendered when not all answered; reaching here means a
      // stale/late callback. Re-show the current state.
      deps.notify(`Still to answer: ${unansweredIds().join(", ")}`, "warning");
      continue;
    }

    if (value === "custom") {
      // Free-text entry for the current question.
      try {
        await deps.sendButtons(`${buildText()}\n\nPlease type your answer:`, [[
          { text: "Cancel", value: "cancel" },
        ]]);
      } catch {
        deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
        return cancelled;
      }
      let typed: string | boolean | undefined;
      try {
        typed = await deps.waitInput(true, false);
      } catch {
        return cancelled;
      }
      if (typed === "cancel" || typed === undefined) return cancelled;
      if (typeof typed === "string" && typed.trim()) {
        setCustom(states[current], typed.trim());
      }
      // Stay on the current tab (no forced auto-advance); user navigates manually.
      continue;
    }

    if (value.startsWith("o:")) {
      const idx = parseInt(value.slice(2), 10);
      const q = questions[current];
      if (q && idx >= 0 && idx < q.options.length) {
        toggleOption(states[current], idx);
      }
      // No auto-advance; stay on the current question.
      continue;
    }
    if (value.startsWith("op:")) {
      page = Math.max(0, parseInt(value.slice(3), 10) || 0);
      continue;
    }
    if (value.startsWith("t:")) {
      const next = parseInt(value.slice(2), 10);
      if (next >= 0 && next < n) { current = next; page = 0; }
      continue;
    }

    // Unknown value → cancel.
    return cancelled;
  }
}

/**
 * Bridge an opaque `custom(factory)` dialog to Telegram inline buttons.
 *
 * Returns `T | undefined`: known shapes produce a `GoalQuestionnaireResult`-shaped
 * object cast to `T`; all failure paths (unknown shape, factory throw, render
 * throw, transport error) produce `{ questions: [], answers: [], cancelled: true }`.
 * The `| undefined` in the return type is kept for `ExtensionUIContext.custom`
 * interface compliance but is never resolved at runtime.
 */
export async function bridgeCustomDialog<T>(deps: BridgeCustomDialogDeps): Promise<T | undefined> {
  const width = deps.width ?? 80;
  const tuiShim = buildTuiShim();

  // If the factory auto-submits (calls done before returning), capture that result.
  let factoryResult: T | undefined;
  let factoryDone = false;
  const done = (result: unknown) => { factoryResult = result as T; factoryDone = true; };

  let component: { render(width: number): string[]; handleInput?(data: string): void };
  try {
    component = (await deps.factory(tuiShim, deps.theme, undefined, done)) as {
      render(width: number): string[];
      handleInput?(data: string): void;
    };
  } catch {
    deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
    return { questions: [], answers: [], cancelled: true } as T;
  }

  // Coerce to a cancelled result if a factory auto-called done(undefined); keeps the
  // "never resolves undefined" invariant universal. Not reachable for pi-goal today.
  if (factoryDone) return (factoryResult ?? ({ questions: [], answers: [], cancelled: true } as T));

  let text: string;
  try {
    text = stripAnsi(component.render(width).join("\n"));
  } catch {
    deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
    return { questions: [], answers: [], cancelled: true } as T;
  }

  const lines = text.split("\n");
  const shape = detectShape(text);

  // ---- Confirmation dialog (pi-goal showProposalDialog) ----
  if (shape === "confirmation") {
    const header = extractConfirmationHeader(text);
    try {
      await deps.sendButtons(`<b>${escapeHtml(header)}</b>`, [[
        { text: "✅ Confirm", value: "confirm" },
        { text: "💬 Continue chatting", value: "continue" },
      ]]);
      const value = await deps.waitInput(false, false);

      if (value === "confirm") {
        return { questions: [], answers: [{ id: "confirm", question: header, answer: CONFIRM_ANSWER, wasCustom: false }], cancelled: false } as T;
      }
      if (value === "continue") {
        return { questions: [], answers: [{ id: "confirm", question: header, answer: CONTINUE_ANSWER, wasCustom: false }], cancelled: false } as T;
      }
      // /stop or timeout → cancel
      return { questions: [], answers: [], cancelled: true } as T;
    } catch {
      deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
      return { questions: [], answers: [], cancelled: true } as T;
    }
  }

  // ---- Multi-question questionnaire (goal_questionnaire) ----
  // Drive the opaque component: cycle tabs with a raw Tab byte and render each
  // tab to extract that question's text/options, then run a tab-style Telegram
  // flow (runMultiQuestionFlow) mirroring the TUI. The component is bypassed
  // for the answer/submit — we return a constructed result, like the other paths.
  if (shape === "multi-question") {
    if (typeof component.handleInput !== "function") {
      deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
      return { questions: [], answers: [], cancelled: true } as T;
    }
    try {
      const initialLines = component.render(width);
      const initialText = stripAnsi(initialLines.join("\n"));
      const ids = parseTabBarIds(initialText);
      if (ids.length < 2) {
        // Not actually multi-question — safe degrade.
        deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
        return { questions: [], answers: [], cancelled: true } as T;
      }
      const questions: ParsedQuestion[] = [parseTabQuestion(initialLines, ids[0])];
      for (let i = 1; i < ids.length; i++) {
        component.handleInput(TAB_KEY);
        questions.push(parseTabQuestion(component.render(width), ids[i]));
      }
      const result = await runMultiQuestionFlow(questions, deps);
      return result as T;
    } catch {
      deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
      return { questions: [], answers: [], cancelled: true } as T;
    }
  }

  // ---- Single-question (goal_question) ----
  // Multi-select toggle: tap an option to toggle it (multiple options may be
  // selected). A ✓ Submit button only appears once at least one option is
  // selected (or a custom text is provided); before that the message shows a
  // "Select one or more options, then Submit." placeholder. Free-text entry via
  // ✏️ Type answer finalizes immediately with wasCustom=true (same as before).
  // The returned answer is the joined string of selected options.
  if (shape === "single-question") {
    const contentLines = extractContentLines(lines);
    const questionText = contentLines[0] ?? "Question";
    const contextText = contentLines.slice(1).join("\n");
    const options = extractOptions(lines);
    const allowCustom = hasCustomOption(lines);

    const displayText = contextText
      ? `<b>${escapeHtml(questionText)}</b>\n${escapeHtml(contextText)}`
      : `<b>${escapeHtml(questionText)}</b>`;

    const PAGE_SIZE = 10;
    const state = newState();
    let page = 0;
    const pageCount = Math.max(1, Math.ceil(options.length / PAGE_SIZE));

    while (true) {
      const start = page * PAGE_SIZE;
      const pageOptions = options.slice(start, start + PAGE_SIZE);
      const rows: ButtonRow[] = pageOptions.map((label, i) => {
        const absIdx = start + i;
        const sel = state.selected.has(absIdx);
        const mark = sel ? "☑" : "☐";
        return [{ text: truncateLabel(`${mark} ${label}`), value: `s:${absIdx}` }];
      });
      const nav: { text: string; value: string }[] = [];
      if (page > 0) nav.push({ text: "◀ Prev", value: `p:${page - 1}` });
      if (page < pageCount - 1) nav.push({ text: "Next ▶", value: `p:${page + 1}` });
      if (allowCustom || options.length === 0) nav.push({ text: "✏️ Type answer", value: "custom" });
      if (qAnswered(state)) nav.push({ text: "✓ Submit", value: "submit" });
      nav.push({ text: "Cancel", value: "cancel" });
      rows.push(nav);

      const preview = selectedPreview(state, options);
      const selLine = preview ? `\nSelected: ${escapeHtml(preview)}` : "";
      const placeholder = options.length > 0 && !qAnswered(state)
        ? "\nSelect one or more options, then Submit."
        : "";
      const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
      try {
        await deps.sendButtons(`${displayText}${selLine}${placeholder}${suffix}`, rows);
      } catch {
        deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
        return CANCELLED_RESULT<T>();
      }

      let value: string | boolean | undefined;
      try {
        value = await deps.waitInput(false, false);
      } catch {
        deps.notify("⚠️ Dialog input failed; the agent will continue.", "warning");
        return CANCELLED_RESULT<T>();
      }

      if (value === undefined) return CANCELLED_RESULT<T>();

      if (typeof value === "string") {
        if (value === "cancel") return CANCELLED_RESULT<T>();
        if (value.startsWith("p:")) {
          const next = parseInt(value.slice(2), 10);
          if (next >= 0 && next < pageCount) page = next;
          continue;
        }
        if (value.startsWith("s:")) {
          const idx = parseInt(value.slice(2), 10);
          if (idx >= 0 && idx < options.length) {
            toggleOption(state, idx);
          }
          continue;
        }
        if (value === "submit") {
          if (qAnswered(state)) {
            return {
              questions: [{ id: "q1", question: questionText, options, allowCustom }],
              answers: [{ id: "q1", question: questionText, answer: qAnswer(state, options), wasCustom: state.wasCustom }],
              cancelled: false,
            } as T;
          }
          // No Submit button is rendered when nothing is selected; reaching here
          // means a stale callback. Re-show the current state.
          continue;
        }
        if (value === "custom") {
          // Free-text entry phase (finalizes immediately, same as before).
          try {
            await deps.sendButtons(`${displayText}\n\nPlease type your answer:`, [[
              { text: "Cancel", value: "cancel" },
            ]]);
          } catch {
            deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
            return CANCELLED_RESULT<T>();
          }
          let textValue: string | boolean | undefined;
          try {
            textValue = await deps.waitInput(true, false);
          } catch {
            deps.notify("⚠️ Dialog input failed; the agent will continue.", "warning");
            return CANCELLED_RESULT<T>();
          }
          if (typeof textValue === "string" && textValue.trim()) {
            return {
              questions: [{ id: "q1", question: questionText, options, allowCustom }],
              answers: [{ id: "q1", question: questionText, answer: textValue.trim(), wasCustom: true }],
              cancelled: false,
            } as T;
          }
          return CANCELLED_RESULT<T>();
        }
      }
      // Unknown value → cancel
      return CANCELLED_RESULT<T>();
    }
  }

  // ---- Unknown component → safe fallback ----
  deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
  return { questions: [], answers: [], cancelled: true } as T;
}