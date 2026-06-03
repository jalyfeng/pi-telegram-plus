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
    return this.parser.parseInline(tokens as unknown[]);
  }
  return escapeHtml(fallback);
}

function blockFromTokens(this: TelegramRendererContext, tokens?: unknown[], fallback = ""): string {
  if (Array.isArray(tokens) && tokens.length > 0) {
    return this.parser.parse(tokens as unknown[]);
  }
  return escapeHtml(fallback);
}

const renderer = {
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
    return `<pre><code${language}>${escapeHtml(text)}\n</code></pre>`;
  },

  table(this: TelegramRendererContext, token: Tokens.Table): string {
    const rows: string[] = [];
    if (token.header.length > 0) {
      rows.push(token.header.map((c) => inlineFromTokens.call(this, c.tokens, c.text)).join(" | "));
      rows.push(token.header.map(() => "---").join("-+-"));
    }
    for (const row of token.rows) {
      rows.push(row.map((c) => inlineFromTokens.call(this, c.tokens, c.text)).join(" | "));
    }
    return `<pre>${rows.join("\n")}</pre>\n`;
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
    return `<blockquote>${this.parser.parse(tokens as unknown[])}</blockquote>`;
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
