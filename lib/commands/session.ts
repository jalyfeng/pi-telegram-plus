import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionNameDeps, CommandRegistry } from "./register.ts";
import { escapeHtml } from "../html.ts";
import type { CapturedAgentSession } from "../types.ts";
import { log } from "../logger.ts";

const sessionLog = log.child("session");

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { type: "message"; message: { role: string; content?: unknown } } {
  return entry.type === "message";
}

function getEntryText(entry: { role: string; content?: unknown }): string {
  if (!entry.content || !Array.isArray(entry.content)) return "(empty)";
  return (entry.content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join(" ")
    .replace(/\n/g, " ") || "(empty)";
}

function stripMatchingQuotes(input: string): string {
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1);
  }
  return input;
}

function resolveTargetCwd(input: string, cwd: string): string {
  const unquoted = stripMatchingQuotes(input.trim());
  const expanded = unquoted === "~" || unquoted.startsWith("~/")
    ? resolve(homedir(), unquoted.slice(2))
    : unquoted;
  return resolve(cwd, expanded);
}

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * See model.ts for explanation.
 */
export function registerSessionCommands(
  registry: CommandRegistry,
  deps: SessionNameDeps,
): void {
  // ── /new ──────────────────────────────────────────────────────────────
  registry.registerCommand("new", {
    description: "Start a new session",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const confirmed = await ui.confirm("New session", "Start a new session? Current session will be saved.");
      if (!confirmed) return;
      const result = await ctx.newSession({
        withSession: async () => {
          ui.notify("✅ New session started.", "info");
        },
      });
      if (result.cancelled) ui.notify("Cancelled.", "info");
    },
  });

  // ── /fork ────────────────────────────────────────────────────────────
  registry.registerCommand("fork", {
    description: "Fork from a previous user message",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (args) {
        await ctx.fork(args, { position: "before" });
        ui.notify("✅ Forked session.", "info");
        return;
      }

      const entries = session.sessionManager.getEntries();
      const userEntries = entries.filter(isMessageEntry).filter((e) => e.message.role === "user");
      if (userEntries.length === 0) {
        ui.notify("No user messages to fork from.", "info");
        return;
      }

      const shown = userEntries;
      const labels = shown.map((e) => truncate(getEntryText(e.message), 50));
      const choice = await ui.select("Fork from message", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0) return;
      await ctx.fork(shown[index].id, { position: "before" });
      ui.notify("✅ Forked session.", "info");
    },
  });

  // ── /clone ────────────────────────────────────────────────────────────
  registry.registerCommand("clone", {
    description: "Clone at a previous user message",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (args) {
        await ctx.fork(args, { position: "at" });
        ui.notify("✅ Cloned session.", "info");
        return;
      }

      const entries = session.sessionManager.getEntries();
      const userEntries = entries.filter(isMessageEntry).filter((e) => e.message.role === "user");
      if (userEntries.length === 0) {
        ui.notify("No user messages to clone from.", "info");
        return;
      }

      const shown = userEntries;
      const labels = shown.map((e) => truncate(getEntryText(e.message), 50));
      const choice = await ui.select("Clone at message", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0) return;
      await ctx.fork(shown[index].id, { position: "at" });
      ui.notify("✅ Cloned session.", "info");
    },
  });

  // ── /tree ─────────────────────────────────────────────────────────────
  registry.registerCommand("tree", {
    description: "Navigate session tree to a previous message",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (args) {
        const wantsSummary = await ui.confirm("Navigate", "Summarize the abandoned branch?");
        await ctx.navigateTree(args, { summarize: wantsSummary });
        ui.notify("✅ Navigated to selected point.", "info");
        return;
      }

      const entries = session.sessionManager.getEntries();
      const userEntries = entries.filter(isMessageEntry).filter((e) => e.message.role === "user");
      if (userEntries.length === 0) {
        ui.notify("No entries to navigate to.", "info");
        return;
      }

      const shown = userEntries;
      const labels = shown.map((e) => truncate(getEntryText(e.message), 50));
      const choice = await ui.select("Navigate to message", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0) return;
      const entry = shown[index];
      const wantsSummary = await ui.confirm("Navigate", "Summarize the abandoned branch?");
      await ctx.navigateTree(entry.id, { summarize: wantsSummary });
      ui.notify("✅ Navigated to selected point.", "info");
    },
  });

  // ── /cwd ──────────────────────────────────────────────────────────────
  registry.registerCommand("cwd", {
    description: "Show current working directory",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`cwd: ${escapeHtml(ctx.cwd)}`, "info");
    },
  });

  // ── /cd ───────────────────────────────────────────────────────────────
  registry.registerCommand("cd", {
    description: "Switch pi working directory",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const rawPath = args.trim() || await ui.input("Working directory", ctx.cwd);
      if (!rawPath) return;

      const targetCwd = resolveTargetCwd(rawPath, ctx.cwd);
      const info = await stat(targetCwd).catch(sessionLog.swallow("debug", "stat target cwd failed (treated as not-a-directory)", { targetCwd }));
      if (!info?.isDirectory()) {
        ui.notify(`Not a directory: ${escapeHtml(targetCwd)}`, "error");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const sessionManager = SessionManager.create(targetCwd, undefined, {
        ...(currentSessionFile ? { parentSession: currentSessionFile } : {}),
      });
      // Ensure the header-only session file exists before switchSession opens it.
      (sessionManager as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
      const sessionPath = sessionManager.getSessionFile();
      if (!sessionPath) {
        ui.notify("Cannot switch cwd from an ephemeral session.", "error");
        return;
      }

      const result = await ctx.switchSession(sessionPath, {
        withSession: async (nextCtx: { ui: import("@earendil-works/pi-coding-agent").ExtensionUIContext }) => {
          nextCtx.ui.notify(`✅ Switched cwd:\n${escapeHtml(targetCwd)}`, "info");
        },
      });
      if (result.cancelled) ui.notify("Cwd switch cancelled.", "info");
    },
  });

  // ── /resume ───────────────────────────────────────────────────────────
  registry.registerCommand("resume", {
    description: "Resume a previous session",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const sessions = await SessionManager.list(ctx.cwd);
      if (sessions.length === 0) {
        ui.notify("No sessions found.", "info");
        return;
      }

      const shown = sessions;
      const labels = shown.map((s) => truncate(s.name ?? s.id, 50));
      const choice = await ui.select("Resume session", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0) return;
      await ctx.switchSession(shown[index].path);
      ui.notify("✅ Switched session.", "info");
    },
  });

  // ── /name ──────────────────────────────────────────────────────────────
  registry.registerCommand("name", {
    description: "Set or show session name",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      if (args) {
        deps.setSessionName(args);
        ui.notify(`Session name set: ${args}`, "info");
        return;
      }
      const name = deps.getSessionName();
      ui.notify(name ? `Session name: ${name}` : "No session name set. Use /name <name> to set one.", "info");
    },
  });

  // ── /session ──────────────────────────────────────────────────────────
  registry.registerCommand("session", {
    description: "Show session statistics",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      const stats = session.getSessionStats();
      const usage = session.getContextUsage();
      const lines = [
        `Session Info`,
        `id: ${escapeHtml(stats.sessionId)}`,
        `file: ${escapeHtml(stats.sessionFile ?? "ephemeral")}`,
        `messages: ${stats.userMessages}u / ${stats.assistantMessages}a`,
        `tool calls: ${stats.toolCalls}`,
        `tokens: ${stats.tokens.total}`,
        `cost: ${stats.cost.toFixed(4)}`,
      ];
      if (usage) {
        lines.push(`context: ${usage.tokens ?? "?"} / ${usage.contextWindow}`);
      }
      ui.notify(lines.join("\n"), "info");
    },
  });
}