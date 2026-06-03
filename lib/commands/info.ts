import { existsSync } from "node:fs";
import type { CommandRegistry } from "./register.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { escapeHtml } from "../html.ts";
import type { CapturedAgentSession } from "../types.ts";

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * See model.ts for explanation.
 */
export function registerInfoCommands(
  registry: CommandRegistry,
  deps: { getSession: () => CapturedAgentSession | undefined },
): void {
  // ── /copy ──────────────────────────────────────────────────────────────
  registry.registerCommand("copy", {
    description: "Show last assistant message (for Telegram copy)",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      const text = session.getLastAssistantText();
      ui.notify(text ? text : "No assistant message to copy.", "info");
    },
  });

  // ── /export ────────────────────────────────────────────────────────────
  registry.registerCommand("export", {
    description: "Export session to HTML or JSONL",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      try {
        if (args?.endsWith(".jsonl")) {
          const path = session.exportToJsonl(args);
          ui.notify(`Exported to: ${path}`, "info");
        } else {
          const path = await session.exportToHtml(args || undefined);
          ui.notify(`Exported to: ${escapeHtml(path)}`, "info");
        }
      } catch (error) {
        ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
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

  // ── /share ────────────────────────────────────────────────────────────
  registry.registerCommand("share", {
    description: "Export session for sharing (requires gh CLI on server)",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      try {
        const path = await session.exportToHtml();
        ui.notify(
          [
            `Session exported to: ${escapeHtml(path)}`,
            "",
            "To share via GitHub Gist, run on the server:",
            `gh gist create --public=false "${path}"`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // ── /changelog ────────────────────────────────────────────────────────
  registry.registerCommand("changelog", {
    description: "Show changelog link",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify("Changelog: https://github.com/earendil-works/pi-coding-agent/releases", "info");
    },
  });

  // ── /hotkeys ──────────────────────────────────────────────────────────
  registry.registerCommand("hotkeys", {
    description: "Show keyboard shortcuts (TUI feature list)",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify(
        [
          "Keyboard Shortcuts (TUI)",
          "These are TUI-only. In Telegram, use slash commands.",
          "",
          "Send / to see available commands.",
          "Send /model, /thinking, /compact, /new, etc.",
        ].join("\n"),
        "info",
      );
    },
  });

  // ── /debug ────────────────────────────────────────────────────────────
  registry.registerCommand("debug", {
    description: "Show debug information",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }
      const entries = session.sessionManager.getEntries();
      const model = session.model;
      const lines = [
        `Debug`,
        `model: ${model ? `${model.provider}/${model.id}` : "(none)"}`,
        `thinking: ${session.thinkingLevel}`,
        `streaming: ${session.isStreaming}`,
        `compacting: ${session.isCompacting}`,
        `entries: ${entries.length}`,
        `cwd: ${escapeHtml(ctx.cwd)}`,
      ];
      ui.notify(lines.join("\n"), "info");
    },
  });
}