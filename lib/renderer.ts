import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "./html.ts";
import { markdownToTelegramHtml } from "./markdown.ts";
import { richMarkdownForTables } from "./rich-message.ts";
import type { TelegramConfig, TelegramRenderLevel, TelegramTransport, TelegramTurn } from "./types.ts";
import type { SecretStore } from "./tui/secrets.ts";
import { RENDER_LEVELS } from "./types.ts";
import { log } from "./logger.ts";

const renderLog = log.child("renderer");

type AnyMessage = {
  role?: string;
  content?: unknown;
  errorMessage?: string;
  stopReason?: string;
  usage?: { cost?: { total?: number }; totalTokens?: number };
  model?: string;
  provider?: string;
};

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

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

export function contentToRenderParts(
  content: unknown,
  thinkingLevel: TelegramRenderLevel = "brief",
  toolLevel: TelegramRenderLevel = "brief",
  options: { includeToolCalls?: boolean } = {},
): { body: string; inlineEvents: string[] } {
  if (typeof content === "string") return { body: content, inlineEvents: [] };
  if (!Array.isArray(content)) return { body: "", inlineEvents: [] };
  const includeToolCalls = options.includeToolCalls ?? true;
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
      if (!includeToolCalls || toolLevel === "hidden") continue;
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

export function contentImages(content: unknown): Array<{ data: string; mimeType?: string }> {
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

type ToolArgs = Record<string, unknown>;

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Hashline patch headers: `[<path>#<TAG>]` at the start of a line. */
const EDIT_FILE_HEADER = /^\[([^\]\n]+?)#[^\]\n]+\]/gm;

/** Up to three file names, then a count of the rest. */
function summarizeFileNames(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} (+${names.length - 3} more)` : shown;
}

function summarizeEditPatch(input: string): string {
  const files = [...new Set([...input.matchAll(EDIT_FILE_HEADER)].map((match) => basename(match[1])))];
  if (files.length === 0) return "patch";
  return summarizeFileNames(files);
}

/** A non-empty array whose items are all non-blank strings, or undefined. */
function stringListArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => typeof item === "string" && item.trim().length > 0) ? value as string[] : undefined;
}

function summarizeTodo(a: ToolArgs): string {
  const op = typeof a.op === "string" ? a.op : "";
  if (!op) return "";
  if (op === "init") {
    const phases = Array.isArray(a.list) ? (a.list as Array<{ items?: unknown }>) : [];
    const itemCount = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.items) ? phase.items.length : 0), 0)
      + (Array.isArray(a.items) ? a.items.length : 0);
    return `init (${phases.length} ${phases.length === 1 ? "phase" : "phases"}, ${itemCount} ${itemCount === 1 ? "item" : "items"})`;
  }
  if (op === "append") {
    const count = Array.isArray(a.items) ? a.items.length : 0;
    return `append ${count} ${count === 1 ? "item" : "items"}`;
  }
  const task = typeof a.task === "string" ? firstLine(a.task) : "";
  return task ? `${op}: ${task}` : op;
}

function summarizeAsk(a: ToolArgs): string {
  const questions = Array.isArray(a.questions) ? (a.questions as Array<{ question?: unknown }>) : [];
  const first = typeof questions[0]?.question === "string" ? firstLine(questions[0].question) : "";
  if (!first) return "";
  return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first;
}

function summarizeTask(a: ToolArgs): string {
  const tasks = Array.isArray(a.tasks) ? (a.tasks as Array<{ name?: unknown; task?: unknown }>) : [];
  if (tasks.length === 0) return "";
  const first = tasks[0];
  const label = firstLine(
    typeof first.name === "string" && first.name.trim()
      ? first.name
      : typeof first.task === "string" ? first.task : "",
  );
  const count = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  return label ? `${count}: ${label}` : count;
}

/** First string argument, skipping the intent field `i`. Used for unknown tools. */
function firstStringArg(a: ToolArgs): string {
  for (const [key, value] of Object.entries(a)) {
    if (key === "i") continue;
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  return "";
}

function toolArgsText(toolName: string, a: ToolArgs): string {
  const str = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
  switch (toolName) {
    case "read": {
      const path = str("path");
      if (!path) return "";
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (offset === undefined && limit === undefined) return path;
      const start = offset ?? 1;
      const end = limit !== undefined ? start + limit - 1 : "";
      return `${path}:${start}${end ? `-${end}` : ""}`;
    }
    case "write":
      return str("path");
    case "edit": {
      // pi edit: { path, edits }. OMP edit: hashline patch in `input`.
      const path = str("path");
      if (!path) return summarizeEditPatch(str("input"));
      const edits = Array.isArray(a.edits) ? a.edits.length : 0;
      return edits > 1 ? `${path} (${edits} edits)` : path;
    }
    case "tg_attach": {
      const paths = stringListArg(a.paths);
      return paths ? summarizeFileNames(paths.map(basename)) : "";
    }
    case "bash":
      return firstLine(str("command"));
    case "eval": {
      const title = firstLine(str("title"));
      if (title) return title;
      const code = firstLine(str("code"));
      const language = str("language").trim();
      if (language && code) return `${language}: ${code}`;
      return language || code;
    }
    case "glob":
      return str("path") || str("pattern");
    case "grep":
    case "find": {
      const pattern = firstLine(str("pattern"));
      const path = str("path");
      if (!pattern) return path;
      return path ? `"${pattern}" in ${path}` : `"${pattern}"`;
    }
    case "ls":
      return str("path");
    case "todo":
      return summarizeTodo(a);
    case "wait":
      return "";
    case "ask":
      return summarizeAsk(a);
    case "web_search":
      return firstLine(str("query"));
    case "task":
      return summarizeTask(a);
    default: {
      const first = firstStringArg(a);
      if (first) return first;
      for (const [key, value] of Object.entries(a)) {
        if (key === "i") continue;
        const list = stringListArg(value);
        if (list) return summarizeFileNames(list.map(basename));
      }
      return "";
    }
  }
}

export function summarizeToolArgs(toolName: string, args: unknown, max = 96): string {
  if (!args || typeof args !== "object") return "";
  return shortenSummary(toolArgsText(toolName, args as ToolArgs), max);
}

function formatToolBrief(toolName: string, args: unknown): string {
  const summary = summarizeToolArgs(toolName, args);
  return summary ? `🔧 ${toolName}: ${summary}` : `🔧 ${toolName}`;
}

function summarizeFailureText(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const diagnostic = [...lines].reverse().find((line) => /\b(aborted|cancelled|canceled|failed|error)\b/i.test(line));
  return diagnostic ?? lines[0];
}

function summarizeToolResult(result: unknown, max = 96): string {
  if (typeof result === "string") return shortenSummary(summarizeFailureText(result.trim()), max);
  if (!result || typeof result !== "object") return stringifyShort(result, max);
  const r = result as Record<string, unknown>;
  const candidates = [r.errorMessage, r.message, r.error, r.stderr, r.stdout, r.text, r.output, r.result];
  const found = candidates.find((value) => typeof value === "string" && value.trim());
  if (typeof found === "string") return shortenSummary(summarizeFailureText(found), max);

  const parts = extractToolResultParts(result);
  if (parts.body.trim()) return shortenSummary(summarizeFailureText(parts.body), max);

  return shortenSummary(stringifyShort(result, max), max);
}

export function formatToolFailureBrief(toolName: string, result: unknown, args?: unknown): string {
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
    getActiveTurn: (chatId?: number, messageThreadId?: number) => TelegramTurn | undefined;
    hasActiveTurns?: () => boolean;
    /** True on OMP; only used to name the host in debug logs. */
    isOmp?: boolean;
    /**
     * The live AgentSession whose subscription carries auto-retry events and failed attempts.
     * Neither host delivers those through extension handlers (P2-5).
     */
    getRetrySession?: () => { subscribe?: (listener: (event: any) => void) => () => void } | undefined;
    /** `subscribe` carries the host's session events, including auto-retry start/end (P2-5). */
    getSession?: () => {
      isStreaming: boolean;
      extensionRunner: { createCommandContext(): unknown };
      subscribe?: (listener: (event: any) => void) => () => void;
    } | undefined;
    /** Shared secret store, so assistant replies are redacted too (§4.7.4). */
    secrets?: SecretStore;
  },
): void {
  const sentInlineEvents = new Set<string>();
  const toolUpdateAt = new Map<string, number>();
  const toolArgs = new Map<string, unknown>();

  /** §4.7.4: replace this chat's tracked secrets before any escaping happens. */
  const redactFor = (turn: TelegramTurn | undefined, text: string): string => {
    if (!turn || !deps.secrets) return text;
    return deps.secrets.redact(`${turn.chatId}:${turn.messageThreadId ?? "main"}`, text);
  };

  // ── Workflow / subagent rendering filter ────────────────────────────────
  // The TUI never shows subagent turns as part of the main conversation —
  // workflow progress lives in its own panel. Mirror that in Telegram:
  // while an agent-spawning tool (subagent/workflow/…) executes, and while
  // background agents keep the session streaming with the main loop idle,
  // suppress their events. The main turn's own messages before/after the
  // workflow window render normally. "full" restores the legacy behavior.
  const AGENT_SPAWNING_TOOLS = new Set([
    "subagent",
    "workflow",
    "workflow_control",
    "subagent_wait",
    "subagent_supervisor",
    "intercom",
  ]);
  let spawningToolDepth = 0;
  let workflowNoticeSent = false;

  const isBackgroundAgentActivity = (): boolean => {
    if (spawningToolDepth > 0) return true;
    const session = deps.getSession?.();
    if (!session || !session.isStreaming) return false;
    try {
      const ctx = session.extensionRunner.createCommandContext();
      const idleFn = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle : undefined;
      return idleFn ? idleFn.call(ctx) === true : false;
    } catch {
      return false;
    }
  };

  const maybeSendWorkflowNotice = async () => {
    if (workflowNoticeSent) return;
    workflowNoticeSent = true;
    // A persistent line per workflow window (not an inline event — those are
    // deduplicated per target and would swallow the next window's notice).
    await sendNewToEventTarget("🤖 <b>Workflow running…</b>");
  };

  const onSpawningWindowClosed = () => {
    workflowNoticeSent = false;
  };

  const defaultChats = () => {
    if (deps.hasActiveTurns?.()) return [];
    const cfg = deps.getConfig();
    return cfg.botToken && cfg.activeChatId !== undefined ? [cfg.activeChatId] : [];
  };

  const eventChatIds = () => {
    const turn = deps.getActiveTurn();
    return turn ? [turn.chatId] : defaultChats();
  };

  const eventTargetKey = () => {
    const turn = deps.getActiveTurn();
    if (turn) return `chat:${turn.chatId}:${turn.messageThreadId ?? "main"}`;
    const chatIds = defaultChats();
    return chatIds.length === 0 ? undefined : `default:${chatIds.join(",")}`;
  };

  const sendDefault = async (html: string, richMarkdown?: string) => {
    const chatIds = defaultChats();
    if (chatIds.length === 0) return [];
    return [await deps.transport.sendText(chatIds[0], html, undefined, undefined, richMarkdown)];
  };

  const sendNewToEventTarget = async (html: string) => {
    const turn = deps.getActiveTurn();
    if (turn) return [await deps.transport.sendText(turn.chatId, html, turn.messageThreadId, turn.sourceMessageId)];
    return sendDefault(html);
  };

  const sendToTurn = async (html: string, options: { final?: boolean; richMarkdown?: string } = {}) => {
    const richMarkdown = options.richMarkdown;
    const turn = deps.getActiveTurn();
    if (!turn) {
      await sendDefault(html, richMarkdown);
      return;
    }
    if (turn.replaceMessageId === undefined) {
      await deps.transport.sendText(turn.chatId, html, turn.messageThreadId, turn.sourceMessageId, richMarkdown);
      return;
    }
    // The placeholder cannot hold an HTML answer that large, but one Rich
    // Message can (up to ~30k), so a table answer still lands in place.
    if (options.final && !richMarkdown && Buffer.byteLength(html, "utf8") > EDIT_LIMIT) {
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, "🤖 <b>Assistant</b>\n\nFinal answer follows in separate message(s).").catch(renderLog.swallow("warn", "editText final-answer pointer failed", { chatId: turn.chatId, messageId: turn.replaceMessageId }));
      turn.replaceMessageId = undefined;
      await deps.transport.sendText(turn.chatId, html, turn.messageThreadId, turn.sourceMessageId, richMarkdown);
      return;
    }
    try {
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, html, richMarkdown);
    } catch (err) {
      // Edit failed (message deleted / too many edits). Fall back to a new message.
      renderLog.debug("editText failed; falling back to sendText", { chatId: turn.chatId, messageId: turn.replaceMessageId, err });
      turn.replaceMessageId = undefined;
      await deps.transport.sendText(turn.chatId, html, turn.messageThreadId, turn.sourceMessageId, richMarkdown);
    }
  };

  const sendInlineEvent = async (event: string) => {
    const keyPrefix = eventTargetKey();
    if (!event || !keyPrefix) return;
    // Inline events quote tool arguments and thinking text — exactly where a
    // pasted key reappears, so redact before `escapeHtml` (§4.7.4).
    const text = redactFor(deps.getActiveTurn(), event);
    const key = `${keyPrefix}:${text}`;
    if (sentInlineEvents.has(key)) return;
    sentInlineEvents.add(key);
    await sendToTurn(`<blockquote>${escapeHtml(text)}</blockquote>`);
  };

  const sendInlineEvents = async (events: string[]) => {
    for (const event of events) await sendInlineEvent(event);
  };

  // ── Provider error and auto-retry status (P2-5) ─────────────────────────
  // A failed attempt is not sent as a message of its own. One status message
  // per turn shows what became of it: retrying, recovered, or one final ❌.
  // All of these come from the session subscription, the one source on both hosts:
  // the failed assistant message_end, then auto_retry_start if it is retried, then
  // auto_retry_end, and agent_end (with willRetry on pi) when the run settles.
  const hostName = deps.isOmp === true ? "omp" : "pi";
  type RetryStatus = { messageId?: number; lastError?: string; queue: Promise<void> };
  const retryStatuses = new WeakMap<TelegramTurn, RetryStatus>();
  const noTurnRetryStatus: RetryStatus = { queue: Promise.resolve() };
  /** Error of a failed attempt not yet retried or settled in the current run. */
  let pendingError: string | undefined;
  let retrySession: { session: unknown; unsubscribe: () => void } | undefined;

  const retryStatusFor = (turn: TelegramTurn | undefined): RetryStatus => {
    if (!turn) return noTurnRetryStatus;
    let status = retryStatuses.get(turn);
    if (!status) {
      status = { queue: Promise.resolve() };
      retryStatuses.set(turn, status);
    }
    return status;
  };

  /** Sends the turn's status message once, then edits it in place. Writes run in order. */
  const writeRetryStatus = (turn: TelegramTurn | undefined, html: string): Promise<void> => {
    const status = retryStatusFor(turn);
    status.queue = status.queue.then(async () => {
      if (!turn) {
        await sendDefault(html);
        return;
      }
      if (status.messageId === undefined && turn.replaceMessageId !== undefined) {
        status.messageId = turn.replaceMessageId;
        turn.replaceMessageId = undefined;
      }
      if (status.messageId !== undefined) {
        try {
          await deps.transport.editText(turn.chatId, status.messageId, html);
          renderLog.debug("retry status edited", { host: hostName, messageId: status.messageId });
          return;
        } catch (err) {
          renderLog.debug("retry status edit failed; sending a new message", { host: hostName, err });
          status.messageId = undefined;
        }
      }
      const sent = await deps.transport.sendText(turn.chatId, html, turn.messageThreadId, turn.sourceMessageId);
      status.messageId = sent[0]?.message_id;
      renderLog.debug("retry status sent", { host: hostName, messageId: status.messageId });
    }).catch(renderLog.swallow("warn", "retry status write failed"));
    return status.queue;
  };

  const headline = (text: string, max: number): string => shortenSummary(firstLine(text), max);

  /** Redacts, then escapes: the one way a retry-status text reaches Telegram. */
  const retryHtml = (turn: TelegramTurn | undefined, text: string): string => escapeHtml(redactFor(turn, text));

  const showFinalError = (turn: TelegramTurn | undefined, error: string, fromRetryNotice: boolean): void => {
    // Recorded synchronously: the host's own "Retry failed" notice is forwarded in the same emit.
    if (turn && fromRetryNotice) turn.finalErrorShown = redactFor(turn, error);
    void writeRetryStatus(turn, `❌ ${retryHtml(turn, headline(error, 1000))}`);
  };

  const onRetryStart = (event: { attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }): void => {
    const turn = deps.getActiveTurn();
    const error = headline(event.errorMessage ?? "", 200) || "Unknown error";
    retryStatusFor(turn).lastError = error;
    pendingError = undefined;
    const seconds = Math.round(event.delayMs / 1000);
    void writeRetryStatus(turn, `⚠️ ${retryHtml(turn, error)}\nRetrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s…`);
  };

  const onRetryEnd = (event: { success: boolean; attempt: number; finalError?: string }): void => {
    const turn = deps.getActiveTurn();
    const status = retryStatusFor(turn);
    pendingError = undefined;
    if (event.success) {
      const retries = event.attempt;
      const lastError = status.lastError ?? "Unknown error";
      void writeRetryStatus(turn, `⚠️ ${retryHtml(turn, lastError)}\nRecovered after ${retries} ${retries === 1 ? "retry" : "retries"}.`);
      return;
    }
    if (event.finalError === "Retry cancelled") {
      void writeRetryStatus(turn, "⏹️ Retry cancelled.");
      return;
    }
    showFinalError(turn, event.finalError || "Unknown error", true);
  };

  /** A failed assistant attempt with no text: held, not sent (see onSessionEvent). */
  const isHeldFailure = (message: AnyMessage): boolean =>
    message.role === "assistant"
    && message.stopReason === "error"
    && contentToRenderParts(message.content, "brief", "brief", { includeToolCalls: false }).body.trim() === ""
    && contentImages(message.content).length === 0;

  const holdFailedAttempt = (message: AnyMessage): void => {
    const error = message.errorMessage || "Unknown error";
    pendingError = error;
    const turn = deps.getActiveTurn();
    // Recorded on the turn before any retry event: TurnNotice judges the host's
    // "Retry failed" notice against it, and that notice always comes after this.
    if (turn) turn.failedAttemptError = redactFor(turn, error);
    renderLog.debug("failed attempt held back", { host: hostName });
  };

  /**
   * The run settled. Without a retry (auto_retry_start has already cleared pendingError when
   * one follows), the held error is final; an aborted run says it was stopped.
   */
  const onRunSettled = (event: { willRetry?: boolean; messages?: unknown[] }): void => {
    if (pendingError === undefined || event.willRetry === true) return;
    const error = pendingError;
    pendingError = undefined;
    const turn = deps.getActiveTurn();
    let lastAssistant: AnyMessage | undefined;
    for (const message of event.messages ?? []) {
      if ((message as AnyMessage)?.role === "assistant") lastAssistant = message as AnyMessage;
    }
    if (lastAssistant?.stopReason === "aborted") {
      renderLog.debug("run stopped after a failed attempt", { host: hostName });
      void writeRetryStatus(turn, `⏹️ Stopped after an error: ${retryHtml(turn, headline(error, 1000))}`);
      return;
    }
    renderLog.debug("run settled with no retry; failed attempt is final", { host: hostName });
    showFinalError(turn, error, false);
  };

  /** Every event of the main session's subscription, in the order the host emits it. */
  const onSessionEvent = (event: any): void => {
    try {
      renderLog.debug("session event", { host: hostName, type: event?.type, attempt: event?.attempt });
      switch (event?.type) {
        case "message_end":
          if (isHeldFailure(event.message)) holdFailedAttempt(event.message);
          break;
        case "auto_retry_start": onRetryStart(event); break;
        case "auto_retry_end": onRetryEnd(event); break;
        case "agent_end": onRunSettled(event); break;
        default: break;
      }
    } catch (err) { renderLog.warn("render retry event failed", { err }); }
  };

  /**
   * Follows the live main session (deps.getRetrySession). The subscription is replaced when
   * the session object changes, and is attached again at each run start.
   */
  const attachRetryEvents = (): void => {
    const session = deps.getRetrySession?.();
    if (retrySession !== undefined && retrySession.session === session) return;
    if (retrySession !== undefined) {
      retrySession.unsubscribe();
      renderLog.debug("retry events unsubscribed from the previous session", { host: hostName });
    }
    retrySession = undefined;
    const hasSubscribe = typeof session?.subscribe === "function";
    if (!session || !hasSubscribe) {
      renderLog.debug("retry events not subscribed", { host: hostName, hasSession: session !== undefined, hasSubscribe });
      return;
    }
    retrySession = { session, unsubscribe: session.subscribe!(onSessionEvent) };
    renderLog.debug("retry events subscribed", {
      host: hostName,
      hasSubscribe,
      sameAsGetSession: session === deps.getSession?.(),
    });
  };

  renderLog.debug("renderer retry source", { host: hostName, hasGetRetrySession: deps.getRetrySession !== undefined });

  pi.on("agent_start", async () => {
    renderLog.debug("handler agent_start", { host: hostName });
    try {
    sentInlineEvents.clear();
    toolArgs.clear();
    toolUpdateAt.clear();
    workflowNoticeSent = false;
    pendingError = undefined;
    attachRetryEvents();
    const turn = deps.getActiveTurn();
    if (!turn) return;
    if (turn.replaceMessageId !== undefined) await deps.transport.editText(turn.chatId, turn.replaceMessageId, "🤖 <b>Working…</b>");
    } catch (err) { renderLog.warn("render status-clear handler failed", { err }); }
  });

  pi.on("tool_execution_start", async (event) => {
    try {
    // Agent-spawning tools: their execution window belongs to subagent
    // activity, not to the main conversation. Suppress the call itself and
    // everything nested inside it (TUI parity: workflow lives in its panel).
    if (AGENT_SPAWNING_TOOLS.has(event.toolName)) {
      spawningToolDepth += 1;
      workflowNoticeSent = false;
      await maybeSendWorkflowNotice();
      return;
    }
    if (isBackgroundAgentActivity()) {
      await maybeSendWorkflowNotice();
      return;
    }
    const level = renderLevel(deps.getConfig(), "tool");
    if (level === "hidden") return;
    toolArgs.set(event.toolCallId, event.args);
    await sendInlineEvent(formatToolBrief(event.toolName, event.args));
    } catch (err) { renderLog.warn("render tool_execution_start handler failed", { err }); }
  });

  pi.on("tool_execution_update", async (event) => {
    try {
    if (isBackgroundAgentActivity()) return;
    const level = renderLevel(deps.getConfig(), "tool");
    if (level !== "full") return;
    const text = extractToolResultParts(event.partialResult).body;
    if (!text.trim()) return;
    const now = Date.now();
    const last = toolUpdateAt.get(event.toolCallId) ?? 0;
    if (now - last < TOOL_UPDATE_MS) return;
    toolUpdateAt.set(event.toolCallId, now);
    await sendInlineEvent(`🔄 ${event.toolName}
${stringifyShort(text, 700)}`);
    } catch (err) { renderLog.warn("render tool_execution_update handler failed", { err }); }
  });

  pi.on("tool_execution_end", async (event) => {
    try {
    if (AGENT_SPAWNING_TOOLS.has(event.toolName)) {
      spawningToolDepth = Math.max(0, spawningToolDepth - 1);
      if (spawningToolDepth === 0) onSpawningWindowClosed();
      return;
    }
    if (isBackgroundAgentActivity()) {
      await maybeSendWorkflowNotice();
      return;
    }
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
      const rendered = markdownToTelegramHtml(redactFor(deps.getActiveTurn(), parts.body));
      const expandable = rendered.length > 600 || rendered.split("\n").length > 8;
      const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
      await sendNewToEventTarget(`${tag}${header}\n${rendered}</blockquote>`);
    } else {
      await sendInlineEvent(`${status}: ${event.toolName}`);
    }
    const eventTurn = deps.getActiveTurn();
    for (const image of parts.images) {
      for (const chatId of eventChatIds()) {
        await deps.transport.sendChatAction(chatId, "upload_photo", eventTurn?.messageThreadId);
        await deps.transport.sendPhoto(chatId, image.data, "image", false, undefined, eventTurn?.messageThreadId, eventTurn?.sourceMessageId).catch(renderLog.swallow("warn", "sendPhoto failed", { chatId }));
      }
    }
    } catch (err) { renderLog.warn("tool-result image upload failed", { err }); }
  });

  // A Telegram message steered or queued into a running turn keeps that turn's
  // sourceMessageId. When the host adds it to the conversation, make the
  // turn's next reply quote that message instead.
  const adoptSteeredReplyTarget = (message: AnyMessage): void => {
    const turn = deps.getActiveTurn();
    const pending = turn?.pendingReplyTargets;
    if (!turn || !pending?.length) return;
    const userText = userMessageText(message.content).trim();
    if (!userText) return;
    const index = pending.findIndex((target) => {
      const targetText = target.text.trim();
      return targetText.length > 0 && userText.includes(targetText);
    });
    if (index < 0) return;
    turn.sourceMessageId = pending[index].messageId;
    pending.splice(0, index + 1);
  };

  pi.on("message_end", async (event) => {
    const messageEndInfo = event.message as AnyMessage;
    renderLog.debug("handler message_end", { host: hostName, role: messageEndInfo?.role, stopReason: messageEndInfo?.stopReason });
    try {
    const message = event.message as AnyMessage;
    if (message.role === "user") {
      adoptSteeredReplyTarget(message);
      return;
    }
    if (message.role !== "assistant") return;
    // Subagent turns emit assistant messages in the same session stream.
    // The TUI never shows them as conversation — suppress them while agent
    // activity is in flight and the main loop is idle.
    if (isBackgroundAgentActivity()) {
      renderLog.debug("message_end skipped: background agent activity", { host: hostName, stopReason: message.stopReason });
      await maybeSendWorkflowNotice();
      return;
    }
    const config = deps.getConfig();
    const thinkingLevel = renderLevel(config, "thinking");
    // Tool calls are rendered by tool_execution_start instead; rendering the
    // toolCall blocks here as well would print every call twice.
    const rendered = contentToRenderParts(message.content, thinkingLevel, "brief", { includeToolCalls: false });
    await sendInlineEvents(rendered.inlineEvents);
    // A failed attempt with no text is not sent as a message of its own: the
    // session subscription holds it, and the retry events decide what it becomes.
    if (isHeldFailure(message)) return;
    // Redact the whole reply (prose *and* the oversized code blocks pulled out
    // of it below) before it is converted to HTML or sent as Markdown (§4.7.4).
    const rawBody = redactFor(deps.getActiveTurn(), rendered.body);
    // Pull oversized code blocks out of the body before rendering: they'd
    // otherwise be split across many <pre> messages (painful on mobile). They
    // are sent as downloadable files after the body.
    const { body, blocks: codeFiles } = extractOversizedCodeBlocks(rawBody);
    const images = contentImages(message.content);

    const hasBody = body.trim().length > 0;
    if (hasBody) {
      // A Markdown table cannot be expressed in Telegram's HTML mode, so the
      // renderer would have to fake one (card / box-drawing / transposed). When
      // the answer contains a real GFM table, prefer a Rich Message: Telegram
      // renders it as a native bordered table. Non-qualifying answers — and any
      // server without Rich Message support — keep the HTML path untouched.
      const richMarkdown = richMarkdownForTables(body);
      await sendToTurn(markdownToTelegramHtml(body), { final: true, richMarkdown });
    }

    const turn = deps.getActiveTurn();
    if (codeFiles.length > 0) {
      const chatIds = turn ? [turn.chatId] : defaultChats();
      for (const chatId of chatIds) {
        for (const block of codeFiles) {
          const filePath = await writeTempCodeFile(block.fileName, block.content).catch(renderLog.swallow("warn", "writeTempCodeFile failed", { fileName: block.fileName }));
          if (!filePath) continue;
          await deps.transport.sendChatAction(chatId, "upload_document", turn?.messageThreadId);
          const lines = block.content.split("\n").length;
          const caption = `📎 ${block.lang || "code"} block (${lines} lines)`;
          await deps.transport.sendDocument(chatId, filePath, caption, undefined, turn?.messageThreadId, turn?.sourceMessageId).catch(renderLog.swallow("warn", "sendDocument code block failed", { chatId, fileName: block.fileName }));
          await rm(filePath, { force: true }).catch(renderLog.swallow("debug", "rm temp code file failed", { filePath }));
        }
      }
    }
    for (const image of images) {
      const chatIds = turn ? [turn.chatId] : defaultChats();
      for (const chatId of chatIds) {
        await deps.transport.sendChatAction(chatId, "upload_photo", turn?.messageThreadId);
        await deps.transport.sendPhoto(chatId, image.data, "image", false, undefined, turn?.messageThreadId, turn?.sourceMessageId).catch(() => deps.transport.sendText(chatId, "[image output could not be sent]", turn?.messageThreadId, turn?.sourceMessageId));
      }
    }
    if (!hasBody && turn?.replaceMessageId !== undefined && images.length > 0) {
      const noun = `${images.length} image${images.length === 1 ? "" : "s"}`;
      await deps.transport.editText(turn.chatId, turn.replaceMessageId, `✅ <b>Output sent.</b>\n${noun}`);
      turn.replaceMessageId = undefined;
    }
    } catch (err) { renderLog.warn("render assistant_message handler failed", { err }); }
  });

}
