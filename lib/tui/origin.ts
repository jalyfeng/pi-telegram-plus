/**
 * OriginTracker: a Telegram-issued command owns the output produced while it
 * runs. A scope ends when the submit completed, focus is back in the editor and
 * no output arrived for IDLE_MS; the draft saved before submission is restored
 * exactly then — not when the host's submit handler returns.
 *
 * §4.3's second completion signal — watch the `session.prompt` the submit caused
 * and keep the scope alive until it returns — is not here yet, and it is not
 * optional: `/goals <topic>` answers through a dialog that appears in a *later*
 * turn, so phase 2 needs it. It comes with the Gateway work (§4.2.3), because the
 * whole point is the submit path that starts a turn.
 *
 * What was removed is an earlier half-version that waited on a prompt for every
 * command. §4.2.3 is explicit that a host-builtin command never calls
 * `session.prompt` (`isHostBuiltin(text) -> promptDone = true`), and nothing
 * installed the hook, so that rule froze every output-only command — the entire
 * point of the gateway — until the 60s cap. When it comes back it must come with
 * the builtin skip, the quiet window and the tests §7.1 asks for.
 */
import { log } from "../logger.ts";

const originLog = log.child("tui-origin");

export const IDLE_MS = 1500;
export const SCOPE_MAX_MS = 30 * 60 * 1000;
const TICK_MS = 250;
const SUBMIT_FALLBACK_MS = 10 * 60 * 1000;

export type Origin = {
  chatId: number;
  messageThreadId?: number;
  sourceMessageId?: number;
};

export type CommandScope = {
  id: string;
  origin: Origin;
  label: string;
  commandText: string;
  draft: string;
  localEdited: boolean;
  submitDone: boolean;
  lastOutputAt: number;
  startedAt: number;
  telegramMessageId?: number;
  ended: boolean;
  endReason?: ScopeEndReason;
};

export type ScopeEndReason = "idle" | "replaced" | "timeout" | "error" | "disposed";

export type ScopeDeps = {
  isEditorFocused(): boolean;
  readDraft(): string;
  writeDraft(text: string): boolean;
  /** Extra hold: while this returns true the idle end is postponed. The
   * shell path uses it to keep a "!" scope alive until the host's bash
   * component has finished; the SCOPE_MAX_MS cap above still applies. */
  holdOpen?(): boolean;
};

type EndListener = (scope: CommandScope, reason: ScopeEndReason) => void;

let scopeSeq = 0;

export class OriginTracker {
  private activeScope?: CommandScope;
  private timer?: NodeJS.Timeout;
  private readonly endListeners = new Set<EndListener>();

  constructor(private readonly deps: ScopeDeps) {}

  active(): CommandScope | undefined {
    return this.activeScope;
  }

  hasActive(): boolean {
    return this.activeScope !== undefined;
  }

  onEnd(listener: EndListener): () => void {
    this.endListeners.add(listener);
    return () => { this.endListeners.delete(listener); };
  }

  begin(origin: Origin, label: string, commandText: string, draft: string): CommandScope {
    if (this.activeScope) this.end(this.activeScope, "replaced");
    scopeSeq += 1;
    const now = Date.now();
    const scope: CommandScope = {
      id: scopeSeq.toString(36),
      origin,
      label,
      commandText,
      draft,
      localEdited: false,
      submitDone: false,
      lastOutputAt: now,
      startedAt: now,
      ended: false,
    };
    this.activeScope = scope;
    this.timer = setInterval(() => this.tick(scope), TICK_MS);
    this.timer.unref?.();
    originLog.debug("scope begin", { id: scope.id, label, chatId: origin.chatId });
    return scope;
  }

  /** Any host output in this scope postpones the idle end. */
  touch(scope?: CommandScope): void {
    if (!scope || scope.ended) return;
    scope.lastOutputAt = Date.now();
  }

  markSubmitDone(scope: CommandScope): void {
    if (scope.ended) return;
    scope.submitDone = true;
    this.touch(scope);
  }

  /** Called by the gateway when the host did not expose a submit result. */
  markSubmitFallback(scope: CommandScope): void {
    const timer = setTimeout(() => this.markSubmitDone(scope), SUBMIT_FALLBACK_MS);
    timer.unref?.();
  }

  end(scope: CommandScope, reason: ScopeEndReason): void {
    if (scope.ended) return;
    scope.ended = true;
    scope.endReason = reason;
    if (this.activeScope === scope) this.activeScope = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (reason !== "timeout" && reason !== "disposed") this.restoreDraft(scope, reason);
    originLog.debug("scope end", { id: scope.id, label: scope.label, reason });
    for (const listener of this.endListeners) {
      try { listener(scope, reason); } catch (err) { originLog.debug("scope end listener failed", { err }); }
    }
  }

  dispose(): void {
    if (this.activeScope) this.end(this.activeScope, "disposed");
    this.timer = undefined;
  }

  private tick(scope: CommandScope): void {
    if (scope.ended || this.activeScope !== scope) return;
    const now = Date.now();
    if (now - scope.startedAt >= SCOPE_MAX_MS) {
      // A dialog may still be open; the plan keeps the scope alive in that
      // case. Stage 1 has no Broker, so a non-editor focus is the proxy.
      if (this.deps.isEditorFocused()) {
        this.end(scope, "timeout");
        return;
      }
      scope.startedAt = now;
      return;
    }
    if (!scope.submitDone) return;
    if (!this.deps.isEditorFocused()) return;
    if (now - scope.lastOutputAt < IDLE_MS) return;
    // Output the command still owes (e.g. a running bash component's final
    // render) postpones the idle end; SCOPE_MAX_MS still caps the scope.
    if (this.deps.holdOpen?.()) return;
    this.end(scope, "idle");
  }

  private restoreDraft(scope: CommandScope, reason: ScopeEndReason): void {
    const current = this.deps.readDraft();
    // The user typed while the command ran: do not overwrite their input.
    if (current.trim().length > 0 && current !== scope.draft && current !== scope.commandText) {
      scope.localEdited = true;
      originLog.debug("draft kept (local edit)", { id: scope.id, reason });
      return;
    }
    // The editor still holds the command text (or nothing): put back the draft
    // as it was before submit, including an empty one — an empty draft means
    // the input must end up empty, not keep the command text.
    if (current.trim().length === 0 || current === scope.commandText) {
      this.deps.writeDraft(scope.draft);
    }
  }
}
