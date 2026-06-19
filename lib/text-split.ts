/**
 * Split text for Telegram's 4096-byte message limit.
 * Handles UTF-8 boundaries safely and prefers word/newline breaks.
 *
 * `splitTelegramText` is the legacy byte-level splitter (kept for the
 * single-chunk `[0]` path used by edit/buttons). `splitTelegramHtml` is the
 * semantic splitter used for multi-message sends: it cuts at block boundaries
 * so every chunk is independently valid Telegram HTML (no unbalanced
 * <pre>/<blockquote> that would force a plain-text fallback).
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

// ── Semantic HTML splitter ───────────────────────────────────────────────────
// Protects atomic blocks (<pre>, <blockquote>) so a cut never lands inside
// one and produces unbalanced tags. Oversized atomic blocks are split along
// their internal line boundaries into multiple complete blocks.

/** Split rendered Telegram HTML into <= maxBytes chunks, each valid HTML. */
export function splitTelegramHtml(html: string, maxBytes: number = SAFE_TEXT_CHUNK): string[] {
  if (byteLength(html) <= maxBytes) return [html];
  const blocks = splitHtmlBlocks(html);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const block of blocks) {
    if (byteLength(block) > maxBytes) {
      flush();
      for (const piece of splitOversizedBlock(block, maxBytes)) chunks.push(piece);
      continue;
    }
    if (byteLength(cur) + 2 + byteLength(block) > maxBytes) flush();
    cur = cur ? `${cur}\n\n${block}` : block;
  }
  flush();
  return chunks.length ? chunks : [html];
}

/** Tokenize HTML into top-level blocks (atomic tags stay intact). */
function splitHtmlBlocks(html: string): string[] {
  const atoms: string[] = [];
  const placeholder = (atom: string) => {
    atoms.push(atom);
    return `\x00ATOM${atoms.length - 1}\x00`;
  };
  // Wrap each atomic block in blank lines so \n\n splitting isolates it.
  // <pre> never contains a literal </pre> (code content is HTML-escaped),
  // and our blockquotes don't nest, so non-greedy match is safe.
  const protectedHtml = html
    .replace(/<pre>[\s\S]*?<\/pre>/g, (m) => `\n\n${placeholder(m)}\n\n`)
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/g, (m) => `\n\n${placeholder(m)}\n\n`);
  const blocks: string[] = [];
  for (const part of protectedHtml.split(/\n\n+/)) {
    const t = part.trim();
    if (!t) continue;
    blocks.push(t.replace(/\x00ATOM(\d+)\x00/g, (_m, idx) => atoms[Number(idx)] ?? ""));
  }
  return blocks;
}

/** Split a single oversized block along its internal structure. */
function splitOversizedBlock(block: string, maxBytes: number): string[] {
  // <pre>...</pre> (code or box-table): split content by lines into multiple
  // complete <pre> chunks.
  const preMatch = /^(<pre>)(<code[^>]*>)?([\s\S]*)(<\/code>)?(<\/pre>)$/.exec(block);
  if (preMatch) {
    const [, preOpen, codeOpen, content, codeClose, preClose] = preMatch;
    const open = (preOpen ?? "") + (codeOpen ?? "");
    const close = (codeClose ?? "") + (preClose ?? "");
    return packLines(content.replace(/\n$/, "").split("\n"), maxBytes, open, close);
  }
  // <blockquote...>...</blockquote>: split inner content, re-wrap each piece.
  const bqMatch = /^(<blockquote[^>]*>)([\s\S]*)(<\/blockquote>)$/.exec(block);
  if (bqMatch) {
    const [, open, inner, close] = bqMatch;
    const budget = maxBytes - byteLength(open) - byteLength(close);
    return packLines(inner.replace(/\n$/, "").split("\n"), Math.max(50, budget), open, close);
  }
  // Card table (has a "──" header/row separator): repeat the header in each chunk.
  const lines = block.split("\n");
  const sepIdx = lines.indexOf("──");
  if (sepIdx > 0) {
    const header = lines.slice(0, sepIdx + 1).join("\n");
    const rows = lines.slice(sepIdx + 1);
    const headerOverhead = byteLength(header) + 1;
    const pieces = packLines(rows, Math.max(50, maxBytes - headerOverhead), "", "");
    return pieces.map((p) => `${header}\n${p}`);
  }
  // Plain paragraph / list: byte-split at newline/space boundaries.
  return splitPlainBytes(block, maxBytes);
}

/** Pack string lines into chunks `open + lines + close`, each <= maxBytes. */
function packLines(lines: string[], maxBytes: number, open: string, close: string): string[] {
  const overhead = byteLength(open) + byteLength(close);
  const budget = Math.max(50, maxBytes - overhead);
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (byteLength(candidate) > budget && cur) {
      chunks.push(`${open}${cur}${close}`);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(`${open}${cur}${close}`);
  return chunks.length ? chunks : [`${open}${lines.join("\n")}${close}`];
}

/** Byte-aware split at newline/space; fallback for plain text. */
function splitPlainBytes(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (byteLength(rest) > maxBytes) {
    const { head } = takeUtf8Prefix(rest, maxBytes);
    let cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    if (cut <= 0) cut = head.length;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
