import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionDeps, CommandRegistry } from "./register.ts";
import { escapeHtml } from "../html.ts";
import { log } from "../logger.ts";
import { checkpointCurrentUpdateCursor } from "../polling.ts";
import { isOmpHost } from "../session-capture.ts";

const sessionLog = log.child("session");

/**
 * `SessionManager` is a static class on the pi package root and must be resolved
 * lazily. A package-root import pulls in pi's codemode re-export, which reads
 * `MCP_TYPESCRIPT_PREAMBLE` from `@earendil-works/pi-codemode` — an export removed in
 * pi-codemode 1.2.0 while pi still declares a caret range, so a lockfile-less install
 * can float past what pi supports and throw at load time. The pi CLI masks this via its
 * virtual-module alias table; plain Node consumers do not. Resolution is guarded so a
 * missing class disables /cwd with a clear message instead of breaking the
 * whole extension.
 */
type SessionManagerClass = typeof SessionManager;

async function loadSessionManager(): Promise<SessionManagerClass | undefined> {
  try {
    const module = await import("@earendil-works/pi-coding-agent");
    const candidate = (module as unknown as { SessionManager?: unknown }).SessionManager;
    if (typeof candidate === "function" && typeof (candidate as SessionManagerClass).create === "function") {
      return candidate as SessionManagerClass;
    }
    sessionLog.warn("SessionManager has no create(); /cwd disabled", {
      type: typeof candidate,
    });
  } catch (error) {
    sessionLog.warn("SessionManager unavailable; /cwd disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

const SESSION_MANAGER = await loadSessionManager();

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
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerSessionCommands(
  registry: CommandRegistry,
  deps: SessionDeps,
): void {
  // ── /new ──────────────────────────────────────────────────────────────
  registry.registerCommand("new", {
    description: "Start a new session",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const confirmed = await ui.confirm("New session", "Start a new session? Current session will be saved.");
      if (!confirmed) return;
      // Commit this update's cursor before the in-process session replacement so
      // the replacement runtime cannot re-fetch and re-run the unconfirmed /new.
      await checkpointCurrentUpdateCursor();
      const result = await ctx.newSession(
        typeof deps.getSession()?.extensionRunner?.setUIContext === "function"
          // pi keeps its pre-existing withSession post-replacement hook.
          ? { withSession: async () => { ui.notify("✅ New session started.", "info"); } }
          // OMP has no setUIContext() and ignores withSession; it only implements setup.
          : { setup: async () => { ui.notify("✅ New session started.", "info"); } },
      );
      if (result.cancelled) ui.notify("Cancelled.", "info");
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
  // OMP's `SessionManager.create` takes a SessionStorage where pi takes
  // NewSessionOptions, so the switch below can only fail there with
  // `t.ensureDirSync is not a function`; OMP switches directories with its own
  // /move, which keeps the session and its history. Keep /cd reachable from
  // Telegram to point at /move — registered without a description so it never
  // becomes a TUI slash command.
  if ((deps.isOmpHost ?? isOmpHost)()) {
    registry.registerCommand("cd", {
      handler: async (args, ctx) => {
        const target = args.trim();
        const command = target ? `/move ${escapeHtml(target)}` : "/move <path>";
        ctx.ui.notify(`This host switches directories with ${command}.`, "info");
      },
    });
  } else {
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
        const SessionManagerClass = SESSION_MANAGER;
        if (!SessionManagerClass) {
          ui.notify("Session management is unavailable in this pi build.", "error");
          return;
        }
        const sessionManager = SessionManagerClass.create(targetCwd, undefined, {
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
  }

}