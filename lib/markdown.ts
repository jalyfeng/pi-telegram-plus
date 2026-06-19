import { marked } from "marked";
import type { Tokens } from "marked";
import { escapeHtml } from "./html.ts";

interface TelegramRendererContext {
  parser: {
    parse(tokens: unknown[]): string;
    parseInline(tokens: unknown[]): string;
  };
}

function inlineFromTokens(this: TelegramRendererContext, tokens?: unknown[], fallback = ""): string {
  if (Array.isArray(tokens) && tokens.length > 0) {
    // Temporarily disable \\n appending since this is inline context
    const prev = _textAppendNewline;
    _textAppendNewline = false;
    try {
      return this.parser.parseInline(tokens as unknown[]);
    } finally {
      _textAppendNewline = prev;
    }
  }
  return escapeHtml(fallback);
}

function blockFromTokens(this: TelegramRendererContext, tokens?: unknown[], fallback = ""): string {
  if (Array.isArray(tokens) && tokens.length > 0) {
    return this.parser.parse(tokens as unknown[]);
  }
  return escapeHtml(fallback);
}

/**
 * Calculate visible width of text in a monospace environment.
 * ASCII = 1, CJK / fullwidth / emoji = 2.
 */
function visibleWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||   // CJK, Yi, Hangul syllables
      (code >= 0xac00 && code <= 0xd7af) ||   // Hangul
      (code >= 0xf900 && code <= 0xfaff) ||   // CJK compatibility
      (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK compat forms
      (code >= 0xff01 && code <= 0xff60) ||   // fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) ||   // fullwidth signs
      (code >= 0x1f000 && code <= 0x1f9ff) || // emoji
      code >= 0x20000                          // CJK extension B
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Strip HTML tags for visible width calculation. */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Pad cell text (which may contain HTML tags) to the given visible width.
 * Optionally wraps the whole cell in <b> for header styling.
 */
function padCell(text: string, width: number, bold = false): string {
  const currentWidth = visibleWidth(stripHtmlTags(text));
  const padding = Math.max(0, width - currentWidth);
  // Only wrap in <b> if the text doesn't already start with <b>
  const cell = bold && !text.startsWith("<b>") ? `<b>${text}</b>` : text;
  return cell + " ".repeat(padding);
}

/** True if text contains only printable ASCII (width is unambiguous = 1/char). */
function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/** Collapse newlines inside a table cell so each row renders as one line. */
function sanitizeCellHtml(html: string): string {
  return html.replace(/\n+/g, " ").trim();
}

/** Wrap inline HTML in <b> unless it already starts with one (avoids <b><b>). */
function wrapBold(html: string): string {
  return html && !html.startsWith("<b>") ? `<b>${html}</b>` : html;
}

// ── Table strategies (mobile-first) ─────────────────────────────────────────
// Telegram has no <table>; these three layouts trade off density vs. mobile
// readability. See PR-1c plan: card (default) / box (narrow ASCII) / transpose (wide).

/** Box-drawing grid in <pre> — plain text only (no inline tags inside <pre>). */
function renderBoxTable(headerText: string[], rowsText: string[][], colWidths: number[]): string {
  const lines: string[] = [];
  lines.push(`┌─${colWidths.map((w) => "─".repeat(w)).join("─┬─")}─┐`);
  lines.push(`│ ${headerText.map((h, i) => padCell(h, colWidths[i])).join(" │ ")} │`);
  lines.push(`├─${colWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤`);
  for (const row of rowsText) {
    const cells = colWidths.map((_, i) => padCell(i < row.length ? row[i] : "", colWidths[i]));
    lines.push(`│ ${cells.join(" │ ")} │`);
  }
  lines.push(`└─${colWidths.map((w) => "─".repeat(w)).join("─┴─")}─┘`);
  return `<pre>${lines.join("\n")}</pre>\n`;
}

/** Card-style: bold header row, bold first column (primary key), 2-space sep. */
function renderCardTable(headerHtml: string[], rowsHtml: string[][]): string {
  const lines: string[] = [];
  lines.push(headerHtml.map((h) => wrapBold(h)).join("  "));
  lines.push("──");
  for (const row of rowsHtml) {
    const cells = headerHtml.map((_, i) => (i < row.length ? row[i] : ""));
    const first = cells[0] ? wrapBold(cells[0]) : "";
    const rest = cells.slice(1).filter((c) => c.length > 0).join("  ");
    lines.push([first, rest].filter(Boolean).join("  "));
  }
  return lines.join("\n") + "\n\n";
}

/** Transposed: each row becomes a block (first col = bold title, rest = H: v). */
function renderTransposedTable(headerHtml: string[], rowsHtml: string[][]): string {
  // Each data row becomes a block of `label: value` lines (all columns
  // included, labels bolded), blocks separated by a blank line. No orphaned
  // title / no indent / no heavy separator — the most mobile-readable layout
  // for wide tables (many columns, few rows).
  const blocks: string[] = [];
  for (const row of rowsHtml) {
    const cells = headerHtml.map((_, i) => (i < row.length ? row[i] : ""));
    const lines: string[] = [];
    for (let i = 0; i < headerHtml.length; i++) {
      const label = wrapBold(headerHtml[i]) || `col${i + 1}`;
      lines.push(`${label}: ${cells[i]}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n\n";
}

// ── Pseudo-table protection ──────────────────────────────────────────────────
// Detects aligned pipe text that looks like a markdown table but has no
// `| --- |` separator row (e.g. raw `ls`/SQL/CSV-style output an agent pasted
// as prose). marked would tokenize such text as a paragraph and the pipes /
// column alignment would be lost in Telegram's proportional font. We wrap the
// run in a fenced code block so it renders as <pre><code> (monospace, aligned).

function isTableSeparator(line: string): boolean {
  // A markdown table separator row: only spaces, dashes, colons, pipes; must
  // contain at least one dash.
  return /^\s*\|?[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function isPseudoTableRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const pipeCount = (line.match(/\|/g) || []).length;
  if (pipeCount < 2) return false;
  // Must have some real content (not a separator-only line).
  return line.replace(/[\s|:-]/g, "").length > 0;
}

/** Count consecutive pseudo-table rows at `start`; 0 if it's a real table. */
function pseudoTableRun(lines: string[], start: number): number {
  if (!isPseudoTableRow(lines[start])) return 0;
  // If the previous line is a table separator, `start` is the data-row section
  // of a real markdown table (header + separator above) — leave for marked.
  if (start >= 1 && isTableSeparator(lines[start - 1])) return 0;
  // If the next line is a markdown table separator, this is a real table —
  // leave it for marked's table tokenizer.
  if (start + 1 < lines.length && isTableSeparator(lines[start + 1])) return 0;
  let n = 1;
  while (start + n < lines.length && isPseudoTableRow(lines[start + n])) n++;
  return n >= 2 ? n : 0;
}

/**
 * Wrap pseudo-table runs (outside code fences) in fenced code blocks.
 * Code-fence state is tracked so content already inside ``` is untouched.
 */
function protectPseudoTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar) { inFence = false; fenceChar = ""; }
      out.push(line);
      i++;
      continue;
    }
    if (inFence) { out.push(line); i++; continue; }
    const run = pseudoTableRun(lines, i);
    if (run > 1) {
      out.push("```");
      for (let j = i; j < i + run; j++) out.push(lines[j]);
      out.push("```");
      i += run;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/**
 * Track list nesting depth for proper indentation.
 * Resets per top-level markdownToTelegramHtml call.
 */
let _listDepth = 0;

/**
 * Flag: when true, the text renderer appends \\n after content.
 * True during block-level parse (parser.parse), false during inline
 * (parser.parseInline) so inline text tokens don't get spurious newlines.
 */
let _textAppendNewline = true;

const renderer = {
  text(this: TelegramRendererContext, token: Tokens.Text | Tokens.Escape): string {
    if ('tokens' in token && token.tokens && token.tokens.length > 0) {
      // Text with nested inline tokens — parse inline (disable \\n for nested),
      // then add \\n only if we are at block level
      const prev = _textAppendNewline;
      _textAppendNewline = false;
      try {
        return this.parser.parseInline(token.tokens as unknown[]) + (prev ? '\n' : '');
      } finally {
        _textAppendNewline = prev;
      }
    }
    // Plain text / escape token
    return escapeHtml(token.text) + (_textAppendNewline ? '\n' : '');
  },

  checkbox(this: TelegramRendererContext): string {
    // Suppress default <input> rendering; custom [x]/[ ] marker is added by list renderer
    return "";
  },


  heading(this: TelegramRendererContext, token: Tokens.Heading): string {
    const content = inlineFromTokens.call(this, token.tokens);
    // Telegram has a single font/size, so hierarchy is conveyed by bold + a
    // blank line. Drop the pi-tui `###` prefix (noise on mobile) and <u>
    // (which reads like a link). Uniform <b> + trailing blank line for all depths.
    return `<b>${content}</b>\n\n`;
  },

  paragraph(this: TelegramRendererContext, { tokens }: Tokens.Paragraph): string {
    // Double newline after each paragraph so mobile readers get visual
    // breathing room between paragraphs (single \n reads as run-together).
    return `${inlineFromTokens.call(this, tokens)}\n\n`;
  },

  strong(this: TelegramRendererContext, { tokens }: Tokens.Strong): string {
    return `<b>${inlineFromTokens.call(this, tokens)}</b>`;
  },

  em(this: TelegramRendererContext, { tokens }: Tokens.Em): string {
    return `<i>${inlineFromTokens.call(this, tokens)}</i>`;
  },

  del(this: TelegramRendererContext, { tokens }: Tokens.Del): string {
    return `<s>${inlineFromTokens.call(this, tokens)}</s>`;
  },

  codespan(this: TelegramRendererContext, { text }: Tokens.Codespan): string {
    return `<code>${escapeHtml(text)}</code>`;
  },

  code(this: TelegramRendererContext, { text, lang }: Tokens.Code): string {
    // Drop the literal ``` fences (visual noise + wasted bytes) and emit the
    // language as a Telegram-recognized `class="language-xxx"` attribute.
    // Telegram validates the class value against [a-zA-Z][a-zA-Z0-9_-]*.
    const codeContent = escapeHtml(text.replace(/\n+$/, ""));
    const safeLang = (lang || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const langAttr = safeLang ? ` class="language-${safeLang}"` : "";
    return `<pre><code${langAttr}>${codeContent}\n</code></pre>\n`;
  },

  table(this: TelegramRendererContext, token: Tokens.Table): string {
    const numCols = token.header.length;
    if (numCols === 0) return "";

    // Pre-render every cell to inline HTML (card / transpose strategies).
    // Multi-line cell content is collapsed to a single line so each table
    // row stays one visual line that wraps naturally on mobile.
    const headerHtml = token.header.map((c) =>
      sanitizeCellHtml(inlineFromTokens.call(this, c.tokens, c.text)));
    const rowsHtml = token.rows.map((row) =>
      row.map((c) => sanitizeCellHtml(inlineFromTokens.call(this, c.tokens, c.text))),
    );
    // Plain escaped text for box-drawing (Telegram rejects <b>/<code> nested
    // inside <pre>, so box cells must be tag-free).
    const headerText = token.header.map((c) => escapeHtml(c.text));
    const rowsText = token.rows.map((row) => row.map((c) => escapeHtml(c.text)));

    // Natural column widths for strategy selection + box layout.
    const colWidths: number[] = [];
    let allAscii = true;
    for (let i = 0; i < numCols; i++) {
      let maxW = Math.max(1, visibleWidth(stripHtmlTags(headerHtml[i])));
      for (const row of rowsHtml) {
        if (i < row.length) {
          const w = visibleWidth(stripHtmlTags(row[i]));
          if (w > maxW) maxW = w;
          if (!isAscii(stripHtmlTags(row[i]))) allAscii = false;
        }
      }
      if (!isAscii(stripHtmlTags(headerHtml[i]))) allAscii = false;
      colWidths.push(maxW);
    }
    const naturalWidth = colWidths.reduce((a, b) => a + b, 0) + 3 * numCols + 1;

    // T4: narrow 2-column all-ASCII table that fits a mobile screen -> box-drawing.
    // ASCII width is unambiguous (1 char = 1 cell) in Telegram's monospace font,
    // so the <pre> grid aligns reliably. Bound by total natural width (~40
    // chars fits an iPhone portrait <pre>) so normal command/desc tables qualify;
    // longer cells fall through to card which wraps naturally.
    if (numCols === 2 && allAscii && naturalWidth <= 40) {
      return renderBoxTable(headerText, rowsText, colWidths);
    }
    // T5: wide table -> transpose to vertical cards (one block per row), so a
    //    many-column table never forces horizontal scroll on mobile.
    if (numCols > 4 || naturalWidth > 60) {
      return renderTransposedTable(headerHtml, rowsHtml);
    }
    // T1 default: card-style - bold header + bold first column (primary key),
    // 2-space column separator, wraps naturally, never overflows.
    return renderCardTable(headerHtml, rowsHtml);
  },

  list(this: TelegramRendererContext, token: Tokens.List): string {
    _listDepth++;
    try {
      const start = typeof token.start === "number" ? token.start : 1;
      // Cap indent growth at depth 2: deeper levels add no base indent of
      // their own and switch to a `› ` bullet (unordered), so deep nesting
      // grows only ~2 cols/level (parent continuation indent) instead of 4.
      // Ordered lists keep their numbering at every depth.
      const baseIndent = _listDepth <= 2
        ? "  ".repeat(Math.max(0, _listDepth - 1))
        : "";
      const lines = token.items.map((item, index) => {
        const bullet = token.ordered
          ? `${start + index}. `
          : (_listDepth >= 3 ? "› " : "- ");
        const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
        const marker = bullet + taskMarker;
        const content = blockFromTokens.call(this, item.tokens, item.text);
        const contentLines = content.trimEnd().split("\n");
        const contIndent = " ".repeat(visibleWidth(marker));
        return contentLines.map((line, i) => {
          const prefix = i === 0 ? baseIndent + marker : baseIndent + contIndent;
          return prefix + line;
        }).join("\n");
      });
      return lines.join("\n") + "\n";
    } finally {
      _listDepth--;
    }
  },

  listitem(this: TelegramRendererContext, token: Tokens.ListItem): string {
    // Used when a list item contains block-level children (e.g. nested lists).
    // blockFromTokens will re-enter `list` for nested lists via parser.parse().
    return blockFromTokens.call(this, token.tokens, token.text);
  },

  blockquote(this: TelegramRendererContext, { tokens }: Tokens.Blockquote): string {
    const content = this.parser.parse(tokens as unknown[]).trim();
    // Only wrap in <i> if content doesn't start with a block-level / inline-format
    // tag. Wrapping `<b>`/`<pre>`/`<blockquote>` in `<i>` produces nesting that
    // Telegram rejects (bad request), which forces a plain-text fallback for the
    // ENTIRE message chunk — silently dropping all formatting.
    const shouldItalic = !/^<blockquote|^<pre|^<ul|^<ol|^<table|^<b|^<i|^<a/i.test(content);
    const wrapped = shouldItalic ? `<i>${content}</i>` : content;
    return `<blockquote>${wrapped}</blockquote>\n`;
  },

  hr(this: TelegramRendererContext): string {
    // Slim separator: 3 fullwidth dashes, no <pre> (avoids the heavy
    // monospace block that eats a full line on mobile).
    return "━━━\n\n";
  },

  image(this: TelegramRendererContext, { href, text, title }: Tokens.Image): string {
    const alt = text || "image";
    if (href) return `🖼 <a href="${escapeAttr(href)}">${escapeHtml(alt)}</a>`;
    if (title) return `🖼 ${escapeHtml(alt)}: ${escapeHtml(title)}`;
    return `🖼 ${escapeHtml(alt)}`;
  },

  // ── Inline / passthrough tokens previously left to marked's default ──
  // marked's default renderers emit attributes/constructs Telegram's HTML
  // parser rejects (`title=` on <a>, `<br>`, raw HTML, unescaped `&` in href),
  // which causes the whole message chunk to fall back to plain text.
  // Override each so the output is always valid Telegram HTML.

  link(this: TelegramRendererContext, { href, tokens }: Tokens.Link): string {
    const safeHref = escapeAttr(href);
    if (!safeHref) return inlineFromTokens.call(this, tokens);
    return `<a href="${safeHref}">${inlineFromTokens.call(this, tokens)}</a>`;
  },

  html(this: TelegramRendererContext, token: Tokens.HTML | Tokens.Tag): string {
    // pi-tui renders raw HTML as plain text; mirror that here instead of
    // letting it pass through and trip Telegram's parser.
    const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
    return escapeHtml(raw.trim());
  },

  br(this: TelegramRendererContext): string {
    // Telegram HTML has no <br>; a literal newline is the line break.
    return "\n";
  },
};

marked.use({ renderer });

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles tables, lists, code blocks, blockquotes, and all inline
 * formatting within the Telegram supported subset.
 */
export function markdownToTelegramHtml(markdown: string): string {
  _listDepth = 0;
  _textAppendNewline = true;
  // Pre-scan: wrap "pseudo-tables" (aligned pipe text that looks like a
  // markdown table but lacks the `| --- |` separator row) in fenced code so
  // marked renders them as <pre><code> — preserving column alignment in
  // Telegram's monospace font instead of mangling pipes in a proportional-font
  // paragraph. Real markdown tables (with a separator) are left for marked.
  const protected_ = protectPseudoTables(markdown);
  return (marked.parse(protected_, { async: false }) as string).replace(/\n+$/, "");
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Convert inline Markdown to Telegram HTML.
 * Kept for backward compatibility with single-line / simple conversions.
 */
export function inlineMarkdownToHtml(text: string): string {
  const links: Array<{ label: string; url: string }> = [];
  let processed = text.replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const idx = links.length;
    links.push({ label, url });
    return `\x00LINK${idx}\x00`;
  });

  let html = escapeHtml(processed);

  html = html.replace(/\x00LINK(\d+)\x00/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const link = links[idx];
    if (!link) return "";
    return `<a href="${escapeAttr(link.url)}">${escapeHtml(link.label)}</a>`;
  });

  html = html.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_m, bold) => `<b>${bold}</b>`);
  html = html.replace(/__([^_\n]+)__/g, (_m, bold) => `<b>${bold}</b>`);
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_m, italic) => `<i>${italic}</i>`);
  html = html.replace(/_([^_\n]+)_/g, (_m, italic) => `<i>${italic}</i>`);
  return html;
}
