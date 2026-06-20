import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "./html.ts";
import { markdownToTelegramHtml } from "./markdown.ts";
import type { TelegramConfig, TelegramRenderLevel, TelegramTransport, TelegramTurn } from "./types.ts";
import { RENDER_LEVELS } from "./types.ts";

type AnyMessage = {
  role?: string;
  content?: unknown;
  errorMessage?: string;
  usage?: { cost?: { total?: number }; totalTokens?: number };
  model?: string;
  provider?: string;
};

const TOOL_UPDATE_MS = 5000;
const EDIT_LIMIT = 3500;

function formatThinkingInline(part: Record<string, any>, level: TelegramRenderLevel): string {
  if (level === "hidden") return "";
  const text = part.redacted ? "[thinking redacted]" : String(part.thinking ?? "");
  if (!text) return "";
  if (level === "brief") {
    const short = text.length > 200 ? text.slice(0, 197) + "…" : text;
    return `💭 ${short}`;
  }
  return `💭 Thinking\n${text}`;
}

function contentToRenderParts(
  content: unknown,
  thinkingLevel: TelegramRenderLevel = "brief",
  toolLevel: TelegramRenderLevel = "brief",
): { body: string; inlineEvents: string[] } {
  if (typeof content === "string") return { body: content, inlineEvents: [] };
  if (!Array.isArray(content)) return { body: "", inlineEvents: [] };
  const body: string[] = [];
  const inlineEvents: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, any>;
    if (p.type === "text") body.push(String(p.text ?? ""));
    else if (p.type === "thinking") {
      const inline = formatThinkingInline(p, thinkingLevel);
      if (inline) inlineEvents.push(inline);
    } else if (p.type === "toolCall") {
      if (toolLevel === "hidden") continue;
      const name = String(p.name ?? "tool");
      inlineEvents.push(toolLevel === "brief"
        ? formatToolBrief(name, p.arguments ?? {})
        : `🔧 ${name}\n${stringifyShort(p.arguments ?? {}, 1200)}`);
    }
  }
  // Multiple text parts (common when a turn interleaves text around tool calls)
  // are separated by a blank line so paragraphs don't run together on mobile.
  return { body: body.filter(Boolean).join("\n\n"), inlineEvents };
}

function contentImages(content: unknown): Array<{ data: string; mimeType?: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const p = part as Record<string, any>;
    return p.type === "image" && typeof p.data === "string"
      ? [{ data: p.data, mimeType: typeof p.mimeType === "string" ? p.mimeType : undefined }]
      : [];
  });
}

/**
 * Extract renderable text + image parts from a tool result. Tools return
 * `{ content: (TextContent | ImageContent)[], details }`; we surface the
 * actual output text (rendered as markdown) and any images, instead of the
 * truncated JSON blob the previous `full` mode emitted.
 *
 * @internal Exported for tests; not part of the public module API.
 */
export function extractToolResultParts(result: unknown): {
  body: string;
  images: Array<{ data: string; mimeType?: string }>;
} {
  const content = (result as Record<string, any> | null | undefined)?.content;
  const images = contentImages(content);
  const body: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        body.push(part.text);
      }
    }
  } else if (typeof result === "string") {
    body.push(result);
  }
  return { body: body.filter(Boolean).join("\n\n"), images };
}

function stringifyShort(value: unknown, max = 900): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// ── Oversized code block → file attachment (C1) ─────────────────────────────
// A single fenced code block that won't fit in one Telegram message is sent
// as a downloadable document instead of being split across many <pre> chunks
// (which are painful to read on mobile). The fence is replaced in-body by a
// short notice so the assistant's prose still reads coherently.

const OVERSIZED_CODE_BYTES = 4000;

const LANG_EXT: Record<string, string> = {
  ts: ".ts", tsx: ".tsx", js: ".js", jsx: ".jsx", mjs: ".mjs", cjs: ".cjs",
  py: ".py", python: ".py", rb: ".rb", ruby: ".rb", go: ".go", rs: ".rs", rust: ".rs", java: ".java", kt: ".kt", kotlin: ".kt",
  c: ".c", h: ".h", cpp: ".cpp", cc: ".cc", hpp: ".hpp", cs: ".cs", php: ".php",
  swift: ".swift", sh: ".sh", bash: ".sh", zsh: ".sh", fish: ".sh", ps1: ".ps1",
  sql: ".sql", json: ".json", yml: ".yml", yaml: ".yaml", toml: ".toml",
  xml: ".xml", html: ".html", htm: ".html", css: ".css", scss: ".scss",
  md: ".md", markdown: ".md", txt: ".txt", text: ".txt", dockerfile: "Dockerfile",
  makefile: "Makefile", graphql: ".graphql", lua: ".lua", r: ".r", dart: ".dart",
  scala: ".scala", clj: ".clj", ex: ".ex", exs: ".exs", erl: ".erl", vim: ".vim",
};

function langToExt(lang: string): string {
  const key = (lang || "").trim().toLowerCase();
  return LANG_EXT[key] ?? ".txt";
}

/**
 * Pull fenced code blocks > OVERSIZED_CODE_BYTES out of the markdown body,
 * replacing each with a one-line notice. Returns the trimmed body and the
 * extracted blocks (lang + raw content) for file attachment.
 *
 * @internal Exported for tests; not part of the public module API.
 */
export function extractOversizedCodeBlocks(body: string): {
  body: string;
  blocks: Array<{ lang: string; content: string; fileName: string }>;
} {
  const blocks: Array<{ lang: string; content: string; fileName: string }> = [];
  const stripped = body.replace(/```([^\n]*)\n([\s\S]*?)\n```/g, (m, langRaw, content) => {
    const lang = String(langRaw || "").trim();
    const code = String(content);
    if (Buffer.byteLength(code, "utf8") <= OVERSIZED_CODE_BYTES) return m;
    const idx = blocks.length + 1;
    const fileName = `code-${idx}${langToExt(lang)}`;
    blocks.push({ lang, content: code, fileName });
    const lines = code.split("\n").length;
    return `\n\n📎 \`${lang || "code"} block (${lines} lines) — attached: ${fileName}\`\n\n`;
  });
  return { body: stripped, blocks };
}

// ── Oversized table → file attachment ────────────────────────────────────────
// A table whose rendered HTML would exceed one Telegram message is sent as a
// downloadable .md file instead of being split across messages. Splitting a
// table can render it inconsistently (box-drawing chunks lose the header row;
// transposed cells get separated from their labels), so for the "same table
// renders consistently as a whole" guarantee, oversized tables stay one unit.

const OVERSIZED_TABLE_RENDERED_BYTES = 3600;

const isTableRow = (line: string) => /^\s*\|/.test(line);
const isTableSeparator = (line: string) =>
  /^\s*\|?[\s:|-]*\|?\s*$/.test(line) && line.includes("-") && line.includes("|");

/**
 * Extract markdown tables whose rendered HTML exceeds one message, replacing
 * each with a notice. Tables that fit inline are left untouched.
 *
 * @internal Exported for tests; not part of the public module API.
 */
export function extractOversizedTables(body: string): {
  body: string;
  blocks: Array<{ content: string; fileName: string; rows: number; cols: number }>;
} {
  const blocks: Array<{ content: string; fileName: string; rows: number; cols: number }> = [];
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const start = i;
      i += 2; // header + separator
      while (i < lines.length && isTableRow(lines[i])) i++;
      const tableMd = lines.slice(start, i).join("\n");
      const rendered = markdownToTelegramHtml(tableMd);
      const cols = Math.max(1, (tableMd.split("\n")[0].match(/\|/g) || []).length - 1);
      const rows = tableMd.split("\n").length - 2;
      if (Buffer.byteLength(rendered, "utf8") > OVERSIZED_TABLE_RENDERED_BYTES) {
        const idx = blocks.length + 1;
        const fileName = `table-${idx}.md`;
        blocks.push({ content: tableMd, fileName, rows, cols });
        out.push(`📎 table (${rows} rows × ${cols} cols) — attached: ${fileName}`);
      } else {
        out.push(tableMd);
      }
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return { body: out.join("\n"), blocks };
}

async function writeTempCodeFile(fileName: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tg-code-"));
  const filePath = join(dir, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function renderLevel(config: TelegramConfig, key: "tool" | "thinking"): TelegramRenderLevel {
  const value = config[key];
  return (RENDER_LEVELS as readonly string[]).includes(value ?? "") ? value! : "brief";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
}

function shortenSummary(text: string, max: number): string {
  if (!text || text === "{}") return "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function summarizeToolArgs(toolName: string, args: unknown, max = 96): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  let text = "";

  if (toolName === "edit" && typeof a.path === "string") text = a.path;
  else if (toolName === "read" && typeof a.path === "string") {
    text = a.path;
    const offset = typeof a.offset === "number" ? a.offset : undefined;
    const limit = typeof a.limit === "number" ? a.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : "";
      text += `:${start}${end ? `-${end}` : ""}`;
    }
  } else if (toolName === "bash" && typeof a.command === "string") text = firstLine(a.command);
  else if (typeof a.path === "string") text = a.path;
  else if (typeof a.url === "string") text = a.url;
  else if (Array.isArray(a.paths)) text = a.paths.map(String).join(", ");
  else if (typeof a.file === "string") text = a.file;
  else if (typeof a.query === "string") text = a.query;
  else text = stringifyShort(args, max);

  return shortenSummary(text, max);
}

function formatToolBrief(toolName: string, args: unknown): string {
  const summary = summarizeToolArgs(toolName, args);
  return summary ? `🔧 ${toolName}: ${summary}` : `🔧 ${toolName}`;
}

function summarizeToolResult(result: unknown, max = 96): string {
  if (typeof result === "string") {
    const text = result.trim();
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
  }
  if (!result || typeof result !== "object") return stringifyShort(result, max);
  const r = result as Record<string, unknown>;
  const candidates = [r.errorMessage, r.message, r.error, r.stderr, r.stdout, r.text, r.output, r.result];
  const found = candidates.find((value) => typeof value === "string" && value.trim());
  const text = typeof found === "string" ? firstLine(found) : stringifyShort(result, max);
  return shortenSummary(text, max);
}

function formatToolFailureBrief(toolName: string, result: unknown, args?: unknown): string {
  const argSummary = summarizeToolArgs(toolName, args, 72);
  const resultSummary = summarizeToolResult(result, 72);
  const summary = argSummary && resultSummary
    ? `${argSummary} — ${resultSummary}`
    : argSummary || resultSummary;
  return summary ? `❌ ${toolName}: ${summary}` : `❌ ${toolName}`;
}

export function registerTelegramRenderer(
  pi: ExtensionAPI,
  deps: {
    getConfig: () => TelegramConfig;
    transport: TelegramTransport;
    getActiveTurn: (chatId?: number) => TelegramTurn | undefined;
  },
): void {
  const sentInlineEvents = new Set<string>();
  const toolUpdateAt = new Map<string, number>();
  const toolArgs = new Map<string, unknown>();

  const currentChats = () => {
    const cfg = deps.getConfig();
    return cfg.botToken && cfg.activeChatId !== undefined ? [cfg.activeChatId] : [];
  };

  const send = async (html: string) => {
    const chatIds = currentChats();
    if (chatIds.length === 0) return [];
    return [await deps.transport.sendText(chatIds[0], html)];
  };

  const sendToTurn = async (html: string, options: { final?: boolean } = {}) => {
    const turn = deps.getActiveTurn();
    if (!turn) {
      await send(html);
      return;
    }
    if (turn.replaceMessageId === undefined) {
      await deps.transport.sendText(turn.chatId, html);
      return;
    }
    if (options.final && Buffer.byteLength(html, "utf8") > EDIT_LIMIT) {
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, "🤖 <b>Assistant</b>\n\nFinal answer follows in separate message(s).").catch(() => undefined);
      turn.replaceMessageId = undefined;
      await deps.transport.sendText(turn.chatId, html);
      return;
    }
    try {
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, html);
    } catch {
      // Edit failed (message deleted / too many edits). Fall back to a new message.
      turn.replaceMessageId = undefined;
      await deps.transport.sendText(turn.chatId, html);
    }
  };

  const sendInlineEvent = async (event: string) => {
    if (!event || sentInlineEvents.has(event)) return;
    sentInlineEvents.add(event);
    await sendToTurn(`<blockquote>${escapeHtml(event)}</blockquote>`);
  };

  const sendInlineEvents = async (events: string[]) => {
    for (const event of events) await sendInlineEvent(event);
  };

  pi.on("agent_start", async () => {
    try {
    sentInlineEvents.clear();
    toolArgs.clear();
    toolUpdateAt.clear();
    const turn = deps.getActiveTurn();
    if (!turn) return;
    if (turn.replaceMessageId !== undefined) await deps.transport.editText(turn.chatId, turn.replaceMessageId, "🤖 <b>Working…</b>");
    } catch { /* suppressed */ }
  });

  pi.on("tool_execution_start", async (event) => {
    try {
    const level = renderLevel(deps.getConfig(), "tool");
    if (level === "hidden") return;
    toolArgs.set(event.toolCallId, event.args);
    const inline = level === "brief"
      ? formatToolBrief(event.toolName, event.args)
      : `🔧 ${event.toolName} started
${stringifyShort(event.args, 1200)}`;
    await sendInlineEvent(inline);
    } catch { /* suppressed */ }
  });

  pi.on("tool_execution_update", async (event) => {
    try {
    const level = renderLevel(deps.getConfig(), "tool");
    if (level !== "full") return;
    const now = Date.now();
    const last = toolUpdateAt.get(event.toolCallId) ?? 0;
    if (now - last < TOOL_UPDATE_MS) return;
    toolUpdateAt.set(event.toolCallId, now);
    const partial = stringifyShort(event.partialResult, 700);
    if (!partial || partial === "{}") return;
    await sendInlineEvent(`🔄 ${event.toolName} update
${partial}`);
    } catch { /* suppressed */ }
  });

  pi.on("tool_execution_end", async (event) => {
    try {
    const level = renderLevel(deps.getConfig(), "tool");
    toolUpdateAt.delete(event.toolCallId);
    const args = toolArgs.get(event.toolCallId);
    toolArgs.delete(event.toolCallId);
    if (level === "hidden") return;
    const status = event.isError ? "❌ Tool failed" : "✅ Tool finished";
    if (level === "brief") {
      if (!event.isError) return;
      await sendInlineEvent(formatToolFailureBrief(event.toolName, event.result, args));
      return;
    }
    // full mode: render the tool's actual output (text + images) as a
    // persistent new message, so users who opt into `full` see complete
    // content instead of a truncated JSON blob. Tool results are excluded
    // from the "never fold" rule, so long ones use an expandable blockquote.
    const parts = extractToolResultParts(event.result);
    const header = `${event.isError ? "❌" : "✅"} <b>${escapeHtml(event.toolName)}</b>`;
    if (parts.body.trim()) {
      const rendered = markdownToTelegramHtml(parts.body);
      const expandable = rendered.length > 600 || rendered.split("\n").length > 8;
      const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
      await send(`${tag}${header}\n${rendered}</blockquote>`);
    } else {
      await sendInlineEvent(`${status}: ${event.toolName}`);
    }
    for (const image of parts.images) {
      const chatIds = currentChats();
      for (const chatId of chatIds) {
        await deps.transport.sendChatAction(chatId, "upload_photo");
        await deps.transport.sendPhoto(chatId, image.data, "image").catch(() => undefined);
      }
    }
    } catch { /* suppressed */ }
  });

  pi.on("message_end", async (event) => {
    try {
    const message = event.message as AnyMessage;
    if (message.role !== "assistant") return;
    const config = deps.getConfig();
    const thinkingLevel = renderLevel(config, "thinking");
    const toolLevel = renderLevel(config, "tool");
    const rendered = contentToRenderParts(message.content, thinkingLevel, toolLevel);
    await sendInlineEvents(rendered.inlineEvents);
    const rawBody = rendered.body || message.errorMessage || "";
    // Pull oversized code blocks out of the body before rendering: they'd
    // otherwise be split across many <pre> messages (painful on mobile). They
    // are sent as downloadable files after the body.
    const { body: bodyNoCode, blocks: codeFiles } = extractOversizedCodeBlocks(rawBody);
    // Pull oversized tables too: a table split across messages can render
    // inconsistently (box chunks lose the header row; transposed cells get
    // separated from their labels), so oversized tables stay one file unit.
    const { body, blocks: tableFiles } = extractOversizedTables(bodyNoCode);
    const images = contentImages(message.content);

    const hasBody = body.trim().length > 0;
    if (hasBody) await sendToTurn(markdownToTelegramHtml(body), { final: true });

    const turn = deps.getActiveTurn();
    const attachChatIds = turn ? [turn.chatId] : currentChats();
    if (codeFiles.length > 0) {
      for (const chatId of attachChatIds) {
        for (const block of codeFiles) {
          const filePath = await writeTempCodeFile(block.fileName, block.content).catch(() => undefined);
          if (!filePath) continue;
          await deps.transport.sendChatAction(chatId, "upload_document");
          const lines = block.content.split("\n").length;
          const caption = `📎 ${block.lang || "code"} block (${lines} lines)`;
          await deps.transport.sendDocument(chatId, filePath, caption).catch(() => undefined);
          await rm(filePath, { force: true }).catch(() => undefined);
        }
      }
    }
    if (tableFiles.length > 0) {
      for (const chatId of attachChatIds) {
        for (const block of tableFiles) {
          const filePath = await writeTempCodeFile(block.fileName, block.content).catch(() => undefined);
          if (!filePath) continue;
          await deps.transport.sendChatAction(chatId, "upload_document");
          const caption = `📎 table (${block.rows} rows × ${block.cols} cols)`;
          await deps.transport.sendDocument(chatId, filePath, caption).catch(() => undefined);
          await rm(filePath, { force: true }).catch(() => undefined);
        }
      }
    }
    for (const image of images) {
      const chatIds = turn ? [turn.chatId] : currentChats();
      for (const chatId of chatIds) {
        await deps.transport.sendChatAction(chatId, "upload_photo");
        await deps.transport.sendPhoto(chatId, image.data, "image").catch(() => deps.transport.sendText(chatId, "[image output could not be sent]"));
      }
    }
    if (!hasBody && turn?.replaceMessageId !== undefined && images.length > 0) {
      const noun = `${images.length} image${images.length === 1 ? "" : "s"}`;
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, `✅ <b>Output sent.</b>\n${noun}`);
      turn.replaceMessageId = undefined;
    }
    } catch { /* suppressed */ }
  });

}
