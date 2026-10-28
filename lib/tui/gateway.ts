/**
 * CommandGateway: every host command is executed by the host itself. The
 * gateway submits the command to the host editor (or calls the host control
 * API for pi's /new), OutputCapture returns the output, and the DialogBroker
 * owns any dialog the command raises. The old screen mirror is gone (§0.1 #4):
 * there is no second path for host commands.
 */
import { escapeHtml } from "../html.ts";
import { log } from "../logger.ts";
import type { TelegramTransport } from "../types.ts";
import { checkpointCurrentUpdateCursor } from "../polling.ts";
import { queuePendingNotice } from "../pending-notices.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";
import type { Origin, OriginTracker } from "./origin.ts";
import type { OutputCapture } from "./output.ts";
import type { FocusTracker } from "./focus.ts";
import { currentHostName, currentHostState, installHostCapture, readEditorText, type HostState } from "./host.ts";
import { runInCommand } from "./command-context.ts";
import type { TuiHost } from "../tui-bridge.ts";

const gatewayLog = log.child("tui-gateway");

export type GatewayRequest = {
  name: string;
  args: string;
  origin: Origin;
  transport: Pick<TelegramTransport, "sendText" | "editText">;
};

export type GatewayTextRequest = {
  /** Raw editor text, submitted verbatim (e.g. `!ls`, `!!date`). */
  text: string;
  /** Scope label for the output capture; the shell path passes "!". */
  label: string;
  origin: Origin;
  transport: Pick<TelegramTransport, "sendText" | "editText">;
};

export type GatewayDeps = {
  bridge: TuiBridgeAdapter;
  origin: OriginTracker;
  output: OutputCapture;
  focus: FocusTracker;
  isEnabled(): boolean;
  /** Test seams; production uses the captured host. */
  hostName?: () => TuiHost;
  hostState?: () => HostState;
  readDraft?: () => string;
  writeDraft?: (text: string) => boolean;
  /** Host control API for `/new`; runs in the Telegram turn/UI context. */
  newSession?: (origin: Origin) => Promise<{ cancelled?: boolean } | void>;
};

export class CommandGateway {
  private started = false;
  private sessionWatch?: NodeJS.Timeout;
  private lastSession?: unknown;

  constructor(private readonly deps: GatewayDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void installHostCapture();
    this.deps.focus.start();
    this.deps.output.start();
    this.deps.origin.onEnd((scope) => {
      if (scope.label) this.deps.output.finish();
    });
    // /new replaces the session without letting the old onSubmit promise
    // settle. Watch the captured session identity so its scope can end.
    this.sessionWatch = setInterval(() => {
      const session = (this.deps.hostState?.() ?? currentHostState()).session;
      const scope = this.deps.origin.active();
      if (scope && this.lastSession !== undefined && session !== this.lastSession) {
        this.deps.origin.markSubmitDone(scope);
      }
      this.lastSession = session;
    }, 250);
    this.sessionWatch.unref?.();
  }

  /** All host commands go through the gateway (§0.1 #4); whether a name is a
   * host command is decided by the controller against the host catalog. */
  handles(_name: string): boolean {
    return this.deps.isEnabled();
  }

  /** Returns true when the command was claimed (success or a reported error). */
  async run(request: GatewayRequest): Promise<boolean> {
    if (!this.handles(request.name)) return false;
    const host = this.deps.hostName?.() ?? currentHostName();
    if (request.name === "new" && host === "pi" && this.deps.newSession) {
      return this.runNewSession(request);
    }
    if (!(await this.hostReady(request.name))) return false;
    const commandText = `/${request.name}${request.args.trim() ? ` ${request.args.trim()}` : ""}`;
    return this.submitScoped(commandText, request.name, request.origin, request.transport);
  }

  /** Raw editor text (D3b: the Telegram `!`/`!!` shell path). The host editor
   * decides what the prefix means (its own user_bash pipeline); the gateway
   * only owns the ack, the scope, and the output capture. */
  async runText(request: GatewayTextRequest): Promise<boolean> {
    if (!(await this.hostReady(request.label))) return false;
    return this.submitScoped(request.text, request.label, request.origin, request.transport);
  }

  private async hostReady(name: string): Promise<boolean> {
    const state = this.deps.hostState?.() ?? currentHostState();
    if (!state.mode || !state.editor) {
      gatewayLog.debug("gateway unavailable: host not captured", { name });
      return false;
    }
    await this.deps.bridge.ready().catch(() => undefined);
    if (!this.deps.bridge.isAvailable()) {
      gatewayLog.debug("gateway unavailable: bridge not ready", { name });
      return false;
    }
    return true;
  }

  /** Shared submit path (run/runText): ack the text, open the scope under
   * `label`, bind the output, submit to the editor, and let the scope settle
   * on its own. */
  private async submitScoped(
    commandText: string,
    label: string,
    origin: Origin,
    transport: GatewayRequest["transport"],
  ): Promise<boolean> {
    const draft = (this.deps.readDraft ?? readEditorText)();
    const ackHtml = `<b>▶️ ${escapeHtml(commandText)}</b>`;
    const sent = await transport.sendText(
      origin.chatId,
      ackHtml,
      origin.messageThreadId,
      origin.sourceMessageId,
    ).catch((err) => {
      gatewayLog.debug("send gateway ack failed", { err, name: label });
      return undefined;
    });
    const messageId = sent?.[0]?.message_id;
    if (messageId === undefined) return true;

    const scope = this.deps.origin.begin(origin, label, commandText, draft);
    this.deps.output.bind(scope, {
      chatId: origin.chatId,
      messageThreadId: origin.messageThreadId,
      messageId,
      ackHtml,
    });

    // Session-replacing commands (/fork, /clone, /resume, ...) reactivate the
    // plugin in-process; the replacement runtime re-reads the on-disk cursor and
    // Telegram re-serves this update while it is still unconfirmed, re-running the
    // command. Commit the cursor before submitting. No-op outside an update.
    await checkpointCurrentUpdateCursor();
    const submit = this.deps.bridge.submitResult ?? ((text: string) => ({ ok: this.deps.bridge.submit(text) }));
    let result: { ok: boolean; result?: unknown };
    try {
      result = runInCommand(scope, () => submit.call(this.deps.bridge, commandText));
    } catch (err) {
      result = { ok: false };
      gatewayLog.debug("gateway submit threw", { err, name: label });
    }
    if (!result.ok) {
      this.deps.output.finish();
      this.deps.origin.end(scope, "error");
      await transport.editText(origin.chatId, messageId, `${ackHtml}\n\n❌ The host did not accept this command`).catch(() => undefined);
      return true;
    }
    const value = result.result;
    if (value && typeof value === "object" && "then" in value && typeof value.then === "function") {
      void Promise.resolve(value as Promise<unknown>).finally(() => {
        this.deps.origin.markSubmitDone(scope);
      });
      // A host-side session replacement can orphan the promise.
      this.deps.origin.markSubmitFallback(scope);
    } else {
      this.deps.origin.markSubmitDone(scope);
    }
    return true;
  }

  private async runNewSession(request: GatewayRequest): Promise<boolean> {
    const commandText = "/new";
    const ackHtml = `<b>▶️ ${escapeHtml(commandText)}</b>`;
    const sent = await request.transport.sendText(
      request.origin.chatId,
      ackHtml,
      request.origin.messageThreadId,
      request.origin.sourceMessageId,
    ).catch((err) => {
      gatewayLog.debug("send /new ack failed", { err });
      return undefined;
    });
    const messageId = sent?.[0]?.message_id;
    if (messageId === undefined) return true;
    const draft = (this.deps.readDraft ?? readEditorText)();
    try {
      // /new replaces the session in-process; the replacement runtime re-reads
      // the cursor, so commit this update before the destructive call or the
      // unconfirmed /new is re-served and run a second time.
      await checkpointCurrentUpdateCursor();
      const result = await this.deps.newSession!(request.origin);
      if (result && "cancelled" in result && result.cancelled) {
        await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n<i>Cancelled</i>`).catch(() => undefined);
        return true;
      }
      // The session replacement swapped the extension runtime, so this runtime's
      // transport drops any send it queues now: hand the result to the pending
      // queue and let the replacement runtime edit this message.
      queuePendingNotice({
        chatId: request.origin.chatId,
        messageThreadId: request.origin.messageThreadId,
        editMessageId: messageId,
        html: `${ackHtml}\n\n✅ New session started`,
        createdAt: Date.now(),
      });
      if (draft.length > 0 && this.deps.writeDraft) {
        const timer = setTimeout(() => { this.deps.writeDraft?.(draft); }, 150);
        timer.unref?.();
      }
    } catch (err) {
      gatewayLog.debug("new session failed", { err });
      await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n❌ Could not start a new session`).catch(() => undefined);
    }
    return true;
  }

  dispose(): void {
    if (this.sessionWatch) clearInterval(this.sessionWatch);
    this.sessionWatch = undefined;
    this.deps.output.stop();
    this.deps.focus.stop();
    this.deps.origin.dispose();
  }
}
