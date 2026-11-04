/**
 * Session Capture & Handler Patching
 *
 * Two hosts are supported, and the plugin never knows which one it runs in:
 *
 * 1. Upstream pi (`@earendil-works/pi-coding-agent`). The mode calls
 *    `session.bindExtensions()` at startup, so the patched prototype records the
 *    session there (see below for the details that only apply to this host).
 *
 * 2. OMP (`@oh-my-pi/pi-coding-agent`). Its `AgentSession` has no
 *    `bindExtensions()` at all — the extension runner is built before the
 *    session and handed to `new AgentSession(...)`. Upstream's prototype hook
 *    therefore never fires and every Telegram prompt answered "π session is not
 *    ready yet." OMP instead keeps a process-global `AgentRegistry` whose
 *    `"Main"` ref points at the live top-level session (`ref.session`), is
 *    re-attached whenever a new main session is created (`/new`, session
 *    switch), and is detached to `null` on dispose. That registry is the capture
 *    source there: `getActiveSession()` resolves it on every call, so capture
 *    also works when the extension loads after the session already exists
 *    (`/reload`, an installed plugin picked up mid-run).
 *
 * Upstream host notes:
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

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import type { CapturedAgentSession } from "./types.ts";

const sessionCaptureLog = log.child("session-capture");

/**
 * `AgentSession` must be resolved lazily rather than statically imported.
 *
 * pi >= 1.0.0 re-exports `createCodemodeExtension` from its package root, pulling in
 * `@earendil-works/pi-codemode/declarations`. The `MCP_TYPESCRIPT_PREAMBLE` export that
 * pi reads was removed in pi-codemode 1.2.0, while pi declares the dependency with a
 * caret range — so a lockfile-less install can float past what pi supports and make a
 * static package-root import throw at load time. The pi CLI hides this behind its
 * virtual-module alias table, but plain Node consumers do not, so resolution is done
 * here with a guard and degrades to a no-op instead of crashing the extension.
 */
type AgentSessionConstructor = { prototype: CapturedAgentSession & { bindExtensions?: unknown } };

/** Minimal shape of an `AgentRef` entry in the OMP agent registry. */
type AgentRefLike = {
  id: string;
  kind?: string;
  session?: unknown;
};

type AgentRegistryLike = {
  global(): {
    get(id: string): AgentRefLike | undefined;
    list(): AgentRefLike[];
  };
};

type HostModule = {
  AgentSession?: AgentSessionConstructor;
  AgentRegistry?: AgentRegistryLike;
  MAIN_AGENT_ID?: string;
};

function isAgentSessionConstructor(value: unknown): value is AgentSessionConstructor {
  return typeof value === "function" && "prototype" in value && typeof value.prototype === "object" && value.prototype !== null;
}

function isAgentRegistry(value: unknown): value is AgentRegistryLike {
  // OMP exports the registry as a class (typeof "function"), not an instance.
  const isContainer = typeof value === "function" || (typeof value === "object" && value !== null);
  return isContainer && "global" in value && typeof value.global === "function";
}

async function loadHost(): Promise<HostModule> {
  try {
    // Dynamic, not static: the specifier is host-provided. On OMP it is remapped
    // to the host's own bundled module, and a pi >= 1.0.0 package-root import can
    // throw at load time (see the note above), which a static import would turn
    // into an extension load failure.
    const loaded: unknown = await import("@earendil-works/pi-coding-agent");
    const host: HostModule = {};
    if (typeof loaded === "object" && loaded !== null) {
      if ("AgentSession" in loaded && isAgentSessionConstructor(loaded.AgentSession)) host.AgentSession = loaded.AgentSession;
      if ("AgentRegistry" in loaded && isAgentRegistry(loaded.AgentRegistry)) host.AgentRegistry = loaded.AgentRegistry;
      if ("MAIN_AGENT_ID" in loaded && typeof loaded.MAIN_AGENT_ID === "string") host.MAIN_AGENT_ID = loaded.MAIN_AGENT_ID;
    }
    return host;
  } catch (error) {
    sessionCaptureLog.warn("host pi module unavailable; session capture disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

const HOST: HostModule = await loadHost();

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

// A registry whose lookup throws (host without a usable registry) must be
// reported once, not on every status-line refresh.
let registryLookupFailed = false;

/**
 * Resolve the live top-level session from OMP's process-global agent registry.
 *
 * `"Main"` is registered for the CLI's root session; `list()` is only consulted
 * when that id is missing, so embedded hosts that pass a custom `agentId` still
 * resolve through the ref's `kind === "main"`.
 */
function resolveSessionFromRegistry(): CapturedAgentSession | undefined {
  const registry = HOST.AgentRegistry;
  if (!registry || registryLookupFailed) return undefined;
  try {
    const global = registry.global();
    const mainId = HOST.MAIN_AGENT_ID ?? "Main";
    const ref: AgentRefLike | undefined = global.get(mainId) ?? global.list().find((entry) => entry.kind === "main");
    const session = ref?.session;
    return typeof session === "object" && session !== null ? session as CapturedAgentSession : undefined;
  } catch (error) {
    registryLookupFailed = true;
    sessionCaptureLog.warn("agent registry lookup failed; falling back to prototype capture", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function getActiveSession(): CapturedAgentSession | undefined {
  // Registry first: on OMP it is authoritative and stays correct across session
  // replacement, while `state.activeSession` is only ever written by the
  // upstream prototype hook.
  return resolveSessionFromRegistry() ?? getState().activeSession;
}

/**
 * True when the host module exposes OMP's agent registry (pi exports none).
 * Used to gate commands whose context API only exists on one of the hosts —
 * e.g. `ctx.fork` is present on pi but absent on OMP, which offers
 * `ctx.branch` / `session.fork` instead.
 */
export function isOmpHost(): boolean {
  return HOST.AgentRegistry !== undefined;
}

/** The host's name as users see it in its own UI and commands. */
export function hostCommandName(): "omp" | "pi" {
  return isOmpHost() ? "omp" : "pi";
}

export function installAgentSessionCapture(): boolean {
  const state = getState();
  if (state.installed) return true;

  const AgentSession = HOST.AgentSession;
  if (!AgentSession) return false;

  const proto = AgentSession.prototype;
  const originalBindExtensions = proto.bindExtensions;
  if (typeof originalBindExtensions !== "function") {
    // OMP host: session capture rides the agent registry (see getActiveSession).
    // Nothing to patch — an absent registry just means capture stays empty.
    state.installed = true;
    if (!HOST.AgentRegistry) {
      sessionCaptureLog.warn("AgentSession has no bindExtensions() and no agent registry; session capture disabled");
      return false;
    }
    return true;
  }
  state.installed = true;

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
  return true;
}
