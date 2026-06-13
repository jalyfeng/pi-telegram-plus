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
    return this.parser.parseInline(tokens);
  }
  return escapeHtml(fallback);
}

function blockFromTokens(this: TelegramRendererContext, tokens?: unknown[], fallback = ""): string {
  if (Array.isArray(tokens) && tokens.length > 0) {
    return this.parser.parse(tokens);
  }
  return escapeHtml(fallback);
}

const renderer = {
  space(): string {
    return '\n';
  },

  heading(this: TelegramRendererContext, { tokens }: Tokens.Heading): string {
    return `<b>${inlineFromTokens.call(this, tokens)}</b>\n`;
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
    const language = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${language}>${escapeHtml(text)}</code></pre>\n`;
  },

  table(this: TelegramRendererContext, token: Tokens.Table): string {
    const headerCells = token.header.map((c) => inlineFromTokens.call(this, c.tokens, c.text));
    const dataRows = token.rows.map((row) =>
      row.map((c) => inlineFromTokens.call(this, c.tokens, c.text)),
    );
    const allRows = [headerCells, ...dataRows];

    // Strip HTML tags when calculating width — <b>, <i>, etc. are invisible in the rendered output
    const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
    // Widest visible cell per column, minimum 3 so the separator line stays readable
    const colWidths = allRows[0].map((_, i) =>
      Math.max(3, ...allRows.map((r) => stripTags(r[i] ?? "").length)),
    );
    // Pad cell text to column width, accounting for inline HTML tags that don't contribute visible width
    const pad = (val: string, width: number) => val + " ".repeat(Math.max(0, width - stripTags(val).length));
    const fmtRow = (cells: string[]) => cells.map((v, i) => pad(v, colWidths[i])).join(" | ");
    const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");

    return `<pre>${fmtRow(headerCells)}\n${sep}\n${dataRows.map(fmtRow).join("\n")}</pre>\n`;
  },

  list(this: TelegramRendererContext, token: Tokens.List): string {
    const start = typeof token.start === "number" ? token.start : 1;
    const lines = token.items.map((item, index) => {
      const bullet = token.ordered ? `${start + index}. ` : "• ";
      return bullet + blockFromTokens.call(this, item.tokens, item.text);
    });
    return lines.join("\n") + "\n";
  },

  listitem(this: TelegramRendererContext, token: Tokens.ListItem): string {
    return blockFromTokens.call(this, token.tokens, token.text);
  },

  blockquote(this: TelegramRendererContext, { tokens }: Tokens.Blockquote): string {
    return `<blockquote>${this.parser.parse(tokens as unknown[])}</blockquote>\n`;
  },

  hr(): string {
    return '---';
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
