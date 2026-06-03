import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  return { body: body.filter(Boolean).join("\n"), inlineEvents };
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

function stringifyShort(value: unknown, max = 900): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
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
    sentInlineEvents.clear();
    toolArgs.clear();
    toolUpdateAt.clear();
    const turn = deps.getActiveTurn();
    if (!turn) return;
    if (turn.replaceMessageId !== undefined) await deps.transport.editText(turn.chatId, turn.replaceMessageId, "🤖 <b>Working…</b>");
  });

  pi.on("tool_execution_start", async (event) => {
    const level = renderLevel(deps.getConfig(), "tool");
    if (level === "hidden") return;
    toolArgs.set(event.toolCallId, event.args);
    const inline = level === "brief"
      ? formatToolBrief(event.toolName, event.args)
      : `🔧 ${event.toolName} started
${stringifyShort(event.args, 1200)}`;
    await sendInlineEvent(inline);
  });

  pi.on("tool_execution_update", async (event) => {
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
  });

  pi.on("tool_execution_end", async (event) => {
    const level = renderLevel(deps.getConfig(), "tool");
    toolUpdateAt.delete(event.toolCallId);
    const args = toolArgs.get(event.toolCallId);
    toolArgs.delete(event.toolCallId);
    if (level === "hidden") return;
    const status = event.isError ? "❌ Tool failed" : "✅ Tool finished";
    const result = stringifyShort(event.result, event.isError ? 1800 : 900);
    if (level === "brief") {
      if (!event.isError) return;
      await sendInlineEvent(formatToolFailureBrief(event.toolName, event.result, args));
    } else {
      await sendInlineEvent(result && result !== "{}"
        ? `${status}: ${event.toolName}
${result}`
        : `${status}: ${event.toolName}`);
    }
  });

  pi.on("message_end", async (event) => {
    const message = event.message as AnyMessage;
    if (message.role !== "assistant") return;
    const config = deps.getConfig();
    const thinkingLevel = renderLevel(config, "thinking");
    const toolLevel = renderLevel(config, "tool");
    const rendered = contentToRenderParts(message.content, thinkingLevel, toolLevel);
    await sendInlineEvents(rendered.inlineEvents);
    const body = rendered.body || message.errorMessage || "";
    const images = contentImages(message.content);

    const hasBody = body.trim().length > 0;
    if (hasBody) await sendToTurn(markdownToTelegramHtml(body), { final: true });

    const turn = deps.getActiveTurn();
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
  });

}
