import { existsSync } from "node:fs";
import type { CommandRegistry } from "./register.ts";
import { escapeHtml } from "../html.ts";
import type { CapturedAgentSession, TelegramTransport, TelegramTurn } from "../types.ts";

function formatFooterLikeTokenCount(value: number): string {
  if (value < 1_000) return value.toString();
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

const STATUS_TEXT_LIMIT = 200;

function truncateStatusText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= STATUS_TEXT_LIMIT) return value;
  return `${value.slice(0, STATUS_TEXT_LIMIT - 1)}…`;
}
/**
 * Build the plugin's debug report text. Exposed for the `/tg` menu's
 * "🛠 Debug info" entry (the flat `/debug` command was given back to the host,
 * which ships its own top-level `/debug` in pi and OMP).
 */
export function formatDebugReport(session: CapturedAgentSession, cwd: string): string {
  const entries = session.sessionManager.getEntries();
  const model = session.model;
  return [
    `Plugin debug info`,
    `model: ${model ? `${model.provider}/${model.id}` : "(none)"}`,
    `thinking: ${session.thinkingLevel ?? "off"}`,
    `streaming: ${session.isStreaming}`,
    `compacting: ${session.isCompacting}`,
    `entries: ${entries.length}`,
    `cwd: ${escapeHtml(cwd)}`,
  ].join("\n");
}

/**
 * @internal Exported for tests; not part of the public module API.
 * Keeps the rendered snapshot under Telegram's 4096-byte (and `splitTelegramText`'s
 * 3600-byte single-chunk) limit by capping free-form text fields up front.
 */
export function buildStatusSnapshot(session: CapturedAgentSession): string {
  const stats = session.getSessionStats();
  const usage = session.getContextUsage();
  const model = session.model;
  const safeCwd = truncateStatusText(session.sessionManager.getCwd()) ?? "";
  const safeSessionId = truncateStatusText(stats.sessionId) ?? "";
  const safeSessionFile = truncateStatusText(stats.sessionFile);
  const safeSessionName = truncateStatusText(session.sessionManager.getSessionName());
  const contextWindow = usage?.contextWindow ?? 0;
  const contextPercent = usage?.percent;

  const stateBadge = session.isStreaming
    ? "🟢 active"
    : session.pendingMessageCount > 0
      ? "🟡 queueing"
      : "⚪ idle";

  const contextDisplay = contextPercent === null || contextPercent === undefined
    ? `?/${contextWindow}`
    : `${contextPercent.toFixed(1)}%/${contextWindow}`;

  // Labels are hard-coded, so escaping is unnecessary; only the value is dynamic.
  const line = (label: string, value: string | number | undefined | null): string =>
    `  <b>${label}</b>  ${escapeHtml(value === undefined || value === null ? "—" : String(value))}`;

  return [
    "<b>🛰 TUI Status</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "<b>📂 Workspace</b>",
    line("cwd", safeCwd),
    line("session", safeSessionId + (safeSessionName ? ` • ${safeSessionName}` : "")),
    line("file", safeSessionFile ?? "ephemeral"),
    "",
    "<b>🤖 Model</b>",
    line("model", model ? `${model.provider}/${model.id}` : "(none)"),
    line("thinking", session.thinkingLevel ?? "off"),
    line("state", stateBadge),
    line("queued", String(session.pendingMessageCount)),
    "",
    "<b>📊 Context &amp; Tokens</b>",
    line("context", contextDisplay),
    line("in", formatFooterLikeTokenCount(stats.tokens?.input ?? 0)),
    line("out", formatFooterLikeTokenCount(stats.tokens?.output ?? 0)),
    line("cache R", formatFooterLikeTokenCount(stats.tokens?.cacheRead ?? 0)),
    line("cache W", formatFooterLikeTokenCount(stats.tokens?.cacheWrite ?? 0)),
    line("total", formatFooterLikeTokenCount(stats.tokens?.total ?? 0)),
    line("cost", `$${(stats.cost ?? 0).toFixed(4)}`),
    "",
    "<b>💬 Messages</b>",
    line("user", String(stats.userMessages)),
    line("assistant", String(stats.assistantMessages)),
    line("tool calls", String(stats.toolCalls)),
  ].join("\n");
}

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerInfoCommands(
  registry: CommandRegistry,
  deps: {
    getSession: () => CapturedAgentSession | undefined;
    /** Optional transport for direct sends (bypasses ui.notify wrapping). */
    getTransport?: () => TelegramTransport | undefined;
    /** Optional active chat id used for direct sends. */
    getActiveChatId?: () => number | undefined;
    /** Optional Telegram turn used to preserve thread/source message context. */
    getActiveTurn?: () => TelegramTurn | undefined;
  },
): void {
  // ── /copy ──────────────────────────────────────────────────────────────
  registry.registerCommand("copy", {
    description: "Send the last assistant reply as text",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      const text = session.getLastAssistantText();
      ui.notify(text ? text : "Nothing to copy.", "info");
    },
  });

  // ── /status ───────────────────────────────────────────────────────────
  registry.registerCommand("status", {
    description: "Show runtime snapshot (workspace, model, context, messages)",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      const html = buildStatusSnapshot(session);
      const transport = deps.getTransport?.();
      const turn = deps.getActiveTurn?.();
      const chatId = turn?.chatId ?? deps.getActiveChatId?.();
      if (transport && chatId !== undefined) {
        await transport.sendText(chatId, html, turn?.messageThreadId, turn?.sourceMessageId).catch(() => {
          // Fall back to the standard notify path if the direct send fails.
          ui.notify(html.replace(/<[^>]+>/g, ""), "info");
        });
        return;
      }
      ui.notify(html, "info");
    },
  });

  // ── /import ───────────────────────────────────────────────────────────
  registry.registerCommand("import", {
    description: "Import a session JSONL file (path on server)",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      const path = args || await ui.input("Session file path (JSONL on server)", "/path/to/session.jsonl");
      if (!path) return;
      if (!existsSync(path)) {
        ui.notify(`File not found: ${escapeHtml(path)}`, "error");
        return;
      }
      try {
        const { SessionManager: SM } = await import("@earendil-works/pi-coding-agent");
        const sm = SM.open(path);
        ui.notify(`Imported session: ${sm.getSessionId()}\nUse /resume to switch to it.`, "info");
      } catch (error) {
        ui.notify(`Import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // ── /hotkeys ──────────────────────────────────────────────────────────
  registry.registerCommand("hotkeys", {
    description: "How to use pi from Telegram",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify(
        [
          "Terminal shortcuts only work in the terminal. In Telegram:",
          "• Dialogs appear as buttons; tap to answer, or send a message when text is needed",
          "• /stop: stop the current turn and cancel this chat's open dialog",
          "• !cmd / !!cmd: run a shell command on the host (!! keeps the output out of context)",
          "• /tg: manage bots, project connection and settings",
          "• Other / commands work like the terminal commands of the same name",
        ].join("\n"),
        "info",
      );
    },
  });
}