/**
 * Plain-text view of a Telegram Rich Message body.
 *
 * Messages sent with `sendRichMessage` (see `lib/rich-message.ts`) carry their
 * content in `rich_message.blocks` instead of `text` / `caption`. When the user
 * replies to such a message, the agent needs that content as plain text, so
 * this module flattens the block tree. Unknown block types are never fatal:
 * they contribute their `text` or nested `blocks` when present and are skipped
 * otherwise.
 */
import type { TelegramRichMessage } from "./types.ts";

/** Nesting limit for blocks and rich text; deeper content is dropped. */
const MAX_RICH_DEPTH = 32;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten a `RichText` value: a string, an array of `RichText`, or an object with a nested `text`. */
function richTextToPlain(value: unknown, depth = 0): string {
  if (depth > MAX_RICH_DEPTH) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => richTextToPlain(item, depth + 1)).join("");
  if (!isObject(value)) return "";
  if (value.text !== undefined) return richTextToPlain(value.text, depth + 1);
  if (typeof value.expression === "string") return value.expression;
  return "";
}

function captionToPlain(caption: unknown, depth: number): string {
  if (!isObject(caption)) return "";
  const text = richTextToPlain(caption.text, depth + 1);
  const credit = richTextToPlain(caption.credit, depth + 1);
  return [text, credit ? `— ${credit}` : ""].filter(Boolean).join(" ");
}

function blocksToPlain(blocks: unknown, depth: number): string {
  if (depth > MAX_RICH_DEPTH || !Array.isArray(blocks)) return "";
  return blocks
    .map((block) => blockToPlain(block, depth + 1))
    .filter((line) => line.length > 0)
    .join("\n");
}

function listToPlain(items: unknown, depth: number): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!isObject(item)) return "";
      const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : "-";
      const checkbox = item.has_checkbox === true ? (item.is_checked === true ? "[x]" : "[ ]") : "";
      const body = blocksToPlain(item.blocks, depth + 1);
      return [label, checkbox, body].filter(Boolean).join(" ");
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function tableToPlain(block: JsonObject, depth: number): string {
  const rows = Array.isArray(block.cells) ? block.cells : [];
  const lines: string[] = [];
  const caption = richTextToPlain(block.caption, depth + 1);
  if (caption) lines.push(caption);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    lines.push(row.map((cell) => (isObject(cell) ? richTextToPlain(cell.text, depth + 1) : "")).join(" | "));
  }
  return lines.join("\n");
}

/** Media blocks have no text of their own; they show a placeholder plus the caption. */
const MEDIA_BLOCK_TYPES = new Set(["animation", "audio", "document", "photo", "video", "voice_note"]);

function blockToPlain(block: unknown, depth: number): string {
  if (depth > MAX_RICH_DEPTH || !isObject(block)) return "";
  const type = typeof block.type === "string" ? block.type : "";
  switch (type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "thinking":
      return richTextToPlain(block.text, depth + 1);
    case "expandable_blockquote":
    case "pullquote": {
      const text = richTextToPlain(block.text, depth + 1);
      const credit = richTextToPlain(block.credit, depth + 1);
      return [text, credit ? `— ${credit}` : ""].filter(Boolean).join("\n");
    }
    case "blockquote": {
      const body = blocksToPlain(block.blocks, depth + 1);
      const credit = richTextToPlain(block.credit, depth + 1);
      return [body, credit ? `— ${credit}` : ""].filter(Boolean).join("\n");
    }
    case "divider":
    case "anchor":
    case "buttons":
      return "";
    case "mathematical_expression":
      return typeof block.expression === "string" ? block.expression : "";
    case "list":
      return listToPlain(block.items, depth + 1);
    case "collage":
    case "slideshow":
      return [blocksToPlain(block.blocks, depth + 1), captionToPlain(block.caption, depth + 1)]
        .filter(Boolean)
        .join("\n");
    case "table":
      return tableToPlain(block, depth);
    case "details": {
      const summary = richTextToPlain(block.summary, depth + 1);
      const body = blocksToPlain(block.blocks, depth + 1);
      return [summary, body].filter(Boolean).join("\n");
    }
    case "map":
      return captionToPlain(block.caption, depth + 1);
    default:
      if (MEDIA_BLOCK_TYPES.has(type)) {
        const caption = captionToPlain(block.caption, depth + 1);
        return [`[${type}]`, caption].filter(Boolean).join(" ");
      }
      // Unknown block type: take whatever text or nested blocks it carries.
      if (block.text !== undefined) return richTextToPlain(block.text, depth + 1);
      return blocksToPlain(block.blocks, depth + 1);
  }
}

/**
 * Flatten a Rich Message to plain text: one line per block, list items prefixed
 * by their label (or `-`) with optional `[x]` / `[ ]` checkboxes, table rows with
 * cells joined by ` | `. Returns an empty string when there is no readable content.
 */
export function richMessageToPlainText(rich: TelegramRichMessage | undefined): string {
  if (!isObject(rich)) return "";
  return blocksToPlain(rich.blocks, 0).trim();
}
