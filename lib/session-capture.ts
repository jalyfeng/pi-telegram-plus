/**
 * Session Capture & Handler Patching
 *
 * When p-tui starts, InteractiveMode calls session.bindExtensions() with
 * command-context handlers (newSession, fork, navigateTree, switchSession, reload)
 * that contain TUI rendering side effects.
 *
 * These handlers are needed for their CORE LOGIC (session lifecycle via runtimeHost).
 * The TUI rendering is harmless (just refreshes the terminal).
 *
 * After bindExtensions, we patch two things:
 *
 * 1. The shutdown handler is replaced to prevent exiting the TUI event loop
 *    from a Telegram command. Instead it just notifies.
 *
 * 2. Other handlers are left as-is. The TUI rendering they contain is harmless,
 *    and Telegram notifications are handled by the command handlers themselves
 *    using a captured ui reference (see below).
 *
 * IMPORTANT: rebindSession triggers a new bindExtensions() call, which re-runs
 * our monkey-patch. Since originalBindExtensions sets FRESH handlers each time
 * (from the new bindings), there is no accumulation of wrappers.
 *
 * IMPORTANT: /reload rebuilds the extension runtime without calling
 * bindExtensions(). Therefore capture state must live on globalThis instead of
 * module-local variables; otherwise the freshly loaded extension instance loses
 * activeSession and Telegram appears disconnected after reload.
 *
 * IMPORTANT: After rebind, runner.uiContext is reset to the TUI UI context.
 * This means ctx.ui (a getter reading runner.uiContext) would return the TUI UI
 * instead of TelegramUi. Command handlers MUST capture ctx.ui at the start
 * and use the captured reference for all Telegram notifications:
 *
 *   handler: async (args, ctx) => {
 *     const ui = ctx.ui;  ← capture before any rebind can occur
 *     ...
 *     ui.notify("✅ Done", "info");  ← always goes to Telegram
 *   };
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CapturedAgentSession } from "./types.ts";

type SessionCaptureState = {
  activeSession?: CapturedAgentSession;
  installed: boolean;
};

const SESSION_CAPTURE_STATE = Symbol.for("pi-telegram-plus.session-capture-state");

function getState(): SessionCaptureState {
  const g = globalThis as typeof globalThis & Record<symbol, SessionCaptureState | undefined>;
  g[SESSION_CAPTURE_STATE] ??= { installed: false };
  return g[SESSION_CAPTURE_STATE];
}

export function installAgentSessionCapture(): void {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const proto = AgentSession.prototype as CapturedAgentSession & {
    bindExtensions: AgentSession["bindExtensions"];
  };
  const originalBindExtensions = proto.bindExtensions;

  proto.bindExtensions = async function patchedBindExtensions(this: CapturedAgentSession, bindings) {
    // Make the replacing session visible before originalBindExtensions emits
    // session_start. Otherwise session_start handlers briefly see the previous
    // session, which is especially visible for lifecycle-driven integrations
    // such as Telegram reconnect/status handling after /new.
    state.activeSession = this;

    const result = await originalBindExtensions.call(this, bindings);

    const runner = this.extensionRunner;

    // ── Replace shutdown handler ───────────────────────────────────────
    // Original exits the TUI event loop — dangerous from a Telegram command.
    // Replace with a safe notification.
    (runner as unknown as { shutdownHandler: () => void }).shutdownHandler = () => {
      const ui = runner.getUIContext();
      ui.notify(
        "⚠️ Shutdown requested. Use Ctrl+C in terminal to stop pi.",
        "info",
      );
    };

    return result;
  };
}

export function getActiveSession(): CapturedAgentSession | undefined {
  return getState().activeSession;
}
