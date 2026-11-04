/**
 * Telegram Rich Messages — used to render Markdown tables natively.
 *
 * Telegram's regular message modes (the `HTML` parse mode this extension sends)
 * have no table element, so the renderer fakes tables as card / box-drawing /
 * transposed text (`lib/markdown.ts`). Bot API 10.1 added *Rich Messages*
 * (`sendRichMessage`, plus a `rich_message` field on `editMessageText`) whose
 * Markdown dialect renders GitHub-style pipe tables as real, bordered tables in
 * the client — the same mechanism `dsh-im` uses.
 *
 * This module is deliberately narrow: it decides *whether* an answer qualifies
 * for the rich path and converts it. Everything that does not qualify keeps the
 * existing HTML pipeline, so no content depends on the newer API.
 */
import { hasGfmTable, protectPseudoTables } from "./markdown.ts";

/**
 * Conservative Rich Message text budget. Telegram allows roughly 32k characters
 * (vs. 4096 for a regular message); staying at 30k keeps a safety margin.
 * Answers above it fall back to the HTML pipeline, which already splits safely.
 */
export const TELEGRAM_RICH_TEXT_LIMIT = 30_000;

/**
 * Escape the two characters that could make model output look like Telegram
 * Rich Markdown markup. Rich Markdown accepts HTML tags, so an unescaped `<`
 * from a tool result or a code sample would be interpreted as markup.
 *
 * Code is left alone: per GFM/CommonMark, fenced code blocks and code spans
 * are literal, so escaping them would show `&lt;` to the reader. Fences and
 * inline code spans are therefore passed through unchanged.
 *
 * `>` is deliberately left alone: it cannot open a tag on its own, and escaping
 * it would turn `> quoted line` into literal text instead of a blockquote.
 */
export function escapeRichMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    if (prose.length) out.push(escapeProse(prose.join("\n")));
    prose = [];
    // An unclosed fence runs to the end of the text, as in CommonMark.
    let end = i + 1;
    while (end < lines.length && !closesFence(lines[end], open[1])) end++;
    end = Math.min(end, lines.length - 1);
    for (let k = i; k <= end; k++) out.push(lines[k]);
    i = end + 1;
  }
  if (prose.length) out.push(escapeProse(prose.join("\n")));
  return out.join("\n");
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

/** True when `line` closes a fence opened with `opener`: same character, at least as long. */
function closesFence(line: string, opener: string): boolean {
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return close !== null && close[1][0] === opener[0] && close[1].length >= opener.length;
}

/** Escape prose outside fenced code, leaving inline code spans untouched. */
function escapeProse(text: string): string {
  // Split on blank lines (kept in the output): a code span cannot cross a paragraph break.
  return text
    .split(/(\n[ \t]*\n)/)
    .map(escapeParagraph)
    .join("");
}

/** Escape one paragraph, skipping backtick code spans (a run closed by an equal-length run). */
function escapeParagraph(text: string): string {
  let out = "";
  let plain = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      plain += text[i];
      i++;
      continue;
    }
    const runEnd = backtickRunEnd(text, i);
    const close = findClosingRun(text, runEnd, runEnd - i);
    if (close === -1) {
      plain += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += escapeRichPlain(plain) + text.slice(i, close + (runEnd - i));
    plain = "";
    i = close + (runEnd - i);
  }
  return out + escapeRichPlain(plain);
}

function escapeRichPlain(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] === "`") end++;
  return end;
}

/** Index of the next backtick run of exactly `length` at or after `from`, or -1. */
function findClosingRun(text: string, from: number, length: number): number {
  let j = from;
  while (j < text.length) {
    if (text[j] !== "`") {
      j++;
      continue;
    }
    const end = backtickRunEnd(text, j);
    if (end - j === length) return j;
    j = end;
  }
  return -1;
}

/** True when every code fence is closed (an unterminated fence swallows the rest). */
function hasBalancedFences(markdown: string): boolean {
  return (markdown.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length % 2 === 0;
}

/**
 * Convert `markdown` into a Telegram `rich_message.markdown` payload, or
 * `undefined` when the answer should stay on the HTML path.
 *
 * Qualifies only when the body contains a real GFM table, fits one Rich
 * Message, and has balanced code fences. Pseudo-tables (aligned pipes without a
 * separator row) are fenced first so they keep their monospace alignment.
 */
export function richMarkdownForTables(markdown: string): string | undefined {
  if (!markdown.trim() || !hasGfmTable(markdown)) return undefined;
  if (!hasBalancedFences(markdown)) return undefined;
  const rich = escapeRichMarkdown(protectPseudoTables(markdown));
  if (Array.from(rich).length > TELEGRAM_RICH_TEXT_LIMIT) return undefined;
  return rich;
}
