/**
 * Split text for Telegram's 4096-byte message limit.
 * Handles UTF-8 boundaries safely and prefers word/newline breaks.
 */

const TELEGRAM_TEXT_LIMIT = 4096;
const SAFE_TEXT_CHUNK = 3600;

export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function takeUtf8Prefix(text: string, maxBytes: number): { head: string; tail: string } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const next = bytes + Buffer.byteLength(char, "utf8");
    if (next > maxBytes) break;
    bytes = next;
    end += char.length;
  }
  return { head: text.slice(0, end), tail: text.slice(end) };
}

export function splitTelegramText(text: string): string[] {
  if (byteLength(text) <= TELEGRAM_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;

  while (byteLength(rest) > TELEGRAM_TEXT_LIMIT) {
    const { head: safeHead } = takeUtf8Prefix(rest, SAFE_TEXT_CHUNK);
    let cut = Math.max(safeHead.lastIndexOf("\n"), safeHead.lastIndexOf(" "));
    if (cut < 500) cut = safeHead.length;

    let head = rest.slice(0, cut);
    let tail = rest.slice(cut);
    // Final guard: even after choosing a delimiter, keep the chunk byte-safe.
    if (byteLength(head) > TELEGRAM_TEXT_LIMIT) {
      const split = takeUtf8Prefix(rest, SAFE_TEXT_CHUNK);
      head = split.head;
      tail = split.tail;
    }
    chunks.push(head);
    // Preserve exact content across chunks; do not trim leading whitespace/newlines.
    rest = tail;
  }
  if (rest) chunks.push(rest);
  return chunks;
}