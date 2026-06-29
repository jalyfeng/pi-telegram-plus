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

  let component: { render(width: number): string[] };
  try {
    component = (await deps.factory(tuiShim, deps.theme, undefined, done)) as { render(width: number): string[] };
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

  // ---- Multi-question questionnaire (goal_questionnaire) → degrade ----
  if (shape === "multi-question") {
    deps.notify("⚠️ Multi-question questionnaire is not supported on Telegram. The agent will ask questions one by one in chat.", "warning");
    return { questions: [], answers: [], cancelled: true } as T;
  }

  // ---- Single-question (goal_question) ----
  // One option per row (Telegram limits rows to 8 buttons), with Prev/Next
  // pagination when options exceed PAGE_SIZE, mirroring telegram-ui.ts `select`.
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
    let page = 0;
    const pageCount = Math.max(1, Math.ceil(options.length / PAGE_SIZE));

    while (true) {
      const start = page * PAGE_SIZE;
      const pageOptions = options.slice(start, start + PAGE_SIZE);
      const rows: ButtonRow[] = pageOptions.map((label, i) =>
        [{ text: truncateLabel(label), value: `s:${start + i}` }],
      );
      const nav: { text: string; value: string }[] = [];
      if (page > 0) nav.push({ text: "◀ Prev", value: `p:${page - 1}` });
      if (page < pageCount - 1) nav.push({ text: "Next ▶", value: `p:${page + 1}` });
      if (allowCustom || options.length === 0) nav.push({ text: "✏️ Type answer", value: "custom" });
      nav.push({ text: "Cancel", value: "cancel" });
      rows.push(nav);

      const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
      try {
        await deps.sendButtons(`${displayText}${suffix}`, rows);
      } catch {
        deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
        return { questions: [], answers: [], cancelled: true } as T;
      }

      let value: string | boolean | undefined;
      try {
        value = await deps.waitInput(false, false);
      } catch {
        deps.notify("⚠️ Dialog input failed; the agent will continue.", "warning");
        return { questions: [], answers: [], cancelled: true } as T;
      }

      if (value === undefined) return { questions: [], answers: [], cancelled: true } as T;

      if (typeof value === "string") {
        if (value === "cancel") return { questions: [], answers: [], cancelled: true } as T;
        if (value.startsWith("p:")) {
          const next = parseInt(value.slice(2), 10);
          if (next >= 0 && next < pageCount) page = next;
          continue;
        }
        if (value.startsWith("s:")) {
          const idx = parseInt(value.slice(2), 10);
          if (idx >= 0 && idx < options.length) {
            return {
              questions: [{ id: "q1", question: questionText, options, allowCustom }],
              answers: [{ id: "q1", question: questionText, answer: options[idx], wasCustom: false }],
              cancelled: false,
            } as T;
          }
        }
        if (value === "custom") {
          // Free-text entry phase
          try {
            await deps.sendButtons(`${displayText}\n\nPlease type your answer:`, [[
              { text: "Cancel", value: "cancel" },
            ]]);
          } catch {
            deps.notify("⚠️ Failed to send dialog buttons; the agent will continue.", "warning");
            return { questions: [], answers: [], cancelled: true } as T;
          }
          let textValue: string | boolean | undefined;
          try {
            textValue = await deps.waitInput(true, false);
          } catch {
            deps.notify("⚠️ Dialog input failed; the agent will continue.", "warning");
            return { questions: [], answers: [], cancelled: true } as T;
          }
          if (typeof textValue === "string" && textValue.trim()) {
            return {
              questions: [{ id: "q1", question: questionText, options, allowCustom }],
              answers: [{ id: "q1", question: questionText, answer: textValue.trim(), wasCustom: true }],
              cancelled: false,
            } as T;
          }
          return { questions: [], answers: [], cancelled: true } as T;
        }
      }
      // Unknown value → cancel
      return { questions: [], answers: [], cancelled: true } as T;
    }
  }

  // ---- Unknown component → safe fallback ----
  deps.notify("⚠️ Terminal-only dialog was auto-dismissed; the agent will continue.", "warning");
  return { questions: [], answers: [], cancelled: true } as T;
}