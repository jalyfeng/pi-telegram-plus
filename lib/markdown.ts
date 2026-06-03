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
    if (token.depth === 1) {
      // H1: bold + underline, matching TUI style
      return `<b><u>${content}</u></b>\n`;
    }
    if (token.depth >= 3) {
      // H3+: bold with # prefix, matching TUI style
      const prefix = "#".repeat(token.depth) + " ";
      return `<b>${escapeHtml(prefix)}${content}</b>\n`;
    }
    // H2: bold only
    return `<b>${content}</b>\n`;
  },

  paragraph(this: TelegramRendererContext, { tokens }: Tokens.Paragraph): string {
    return `${inlineFromTokens.call(this, tokens)}\n`;
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
    const codeContent = escapeHtml(text);
    const langTag = lang ? escapeHtml(lang) : "";
    const openMarker = langTag ? `\`\`\`${langTag}` : "\`\`\`";
    return `<pre><code>${openMarker}\n${codeContent}\n\`\`\`\n</code></pre>`;
  },

  table(this: TelegramRendererContext, token: Tokens.Table): string {
    const numCols = token.header.length;
    if (numCols === 0) return "";

    // Calculate column widths based on all cells (header + rows)
    const colWidths: number[] = [];
    for (let i = 0; i < numCols; i++) {
      let maxW = 0;
      const hText = stripHtmlTags(inlineFromTokens.call(this, token.header[i].tokens, token.header[i].text));
      maxW = Math.max(maxW, visibleWidth(hText));
      for (const row of token.rows) {
        if (i < row.length) {
          const cText = stripHtmlTags(inlineFromTokens.call(this, row[i].tokens, row[i].text));
          maxW = Math.max(maxW, visibleWidth(cText));
        }
      }
      colWidths.push(Math.max(1, maxW));
    }

    const lines: string[] = [];

    // Top border
    lines.push(`┌─${colWidths.map(w => "─".repeat(w)).join("─┬─")}─┐`);

    // Header (bold)
    const headerCells = token.header.map((c, i) =>
      padCell(inlineFromTokens.call(this, c.tokens, c.text), colWidths[i], true),
    );
    lines.push(`│ ${headerCells.join(" │ ")} │`);

    // Separator
    lines.push(`├─${colWidths.map(w => "─".repeat(w)).join("─┼─")}─┤`);

    // Data rows
    for (const row of token.rows) {
      const cells = row.map((c, i) =>
        padCell(inlineFromTokens.call(this, c.tokens, c.text), colWidths[i], false),
      );
      while (cells.length < numCols) {
        cells.push(" ".repeat(colWidths[cells.length]));
      }
      lines.push(`│ ${cells.join(" │ ")} │`);
    }

    // Bottom border
    lines.push(`└─${colWidths.map(w => "─".repeat(w)).join("─┴─")}─┘`);

    return `<pre>${lines.join("\n")}</pre>\n`;
  },

  list(this: TelegramRendererContext, token: Tokens.List): string {
    _listDepth++;
    try {
      const start = typeof token.start === "number" ? token.start : 1;
      const baseIndent = "  ".repeat(Math.max(0, _listDepth - 1));
      const lines = token.items.map((item, index) => {
        const bullet = token.ordered ? `${start + index}. ` : "- ";
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
    // Only wrap in <i> if content doesn't contain block-level tags
    const shouldItalic = !/^<blockquote|^<pre|^<ul|^<ol|^<table/i.test(content);
    const wrapped = shouldItalic ? `<i>${content}</i>` : content;
    return `<blockquote>${wrapped}</blockquote>\n`;
  },

  hr(this: TelegramRendererContext): string {
    return `<pre>─────────────────────</pre>\n`;
  },

  image(this: TelegramRendererContext, { text, title }: Tokens.Image): string {
    return title ? `[${text}: ${title}]` : `[${text}]`;
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
  return (marked.parse(markdown, { async: false }) as string).replace(/\n+$/, "");
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
