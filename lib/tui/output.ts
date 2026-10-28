/**
 * OutputCapture (stage 1): sends the host's own command output back to
 * Telegram. It claims a chat component only while a Telegram-issued command
 * scope is active AND the component is added inside that command's call chain
 * (command-context.ts, v8 §0.2). Agent messages and tool calls run in the agent
 * loop's own context and stay with the existing renderer. Content is read from
 * the component's data fields only; `render()` is never called.
 */
import { existsSync } from "node:fs";
import { escapeHtml } from "../html.ts";
import { markdownToTelegramHtml } from "../markdown.ts";
import { splitTelegramHtml } from "../text-split.ts";
import { stripAnsi } from "../ansi.ts";
import { log, type LogFields } from "../logger.ts";
import type { TelegramTransport } from "../types.ts";
import { hookMethod, isHostObject, onHostState, type HostState } from "./host.ts";
import { installHook, removeOwnerHooks } from "./hooks.ts";
import { currentCommandScope, runAsHistory, runOutsideCommand } from "./command-context.ts";
import type { CommandScope, OriginTracker } from "./origin.ts";
import type { SecretStore } from "./secrets.ts";

const outputLog = log.child("tui-output");

const OUTPUT_DEBOUNCE_MS = 700;
const OUTPUT_EDIT_MS = 1000;
const MAX_COMPONENTS = 20;
/** OMP keeps flushing PTY output asynchronously after `setComplete` returns;
 * render the final frame one beat later so that is what we push (3E). */
const BASH_SETTLE_MS = 300;
/** Host methods that rebuild the transcript from session history (v8 §0.2):
 * pi 1.4.0 interactive-mode.ts 3960/4060/4177/4229, OMP 18.12.5
 * interactive-mode.ts 4049/8019/8030. Children they add are not command output. */
const HISTORY_REBUILD_METHODS = [
  "renderSessionItems",
  "renderSessionEntries",
  "renderInitialMessages",
  "rebuildChatFromMessages",
  "renderSessionContextIncrementally",
] as const;
/** Container depth read by `contentHtml`: the root plus this many nested levels. */
const CONTENT_MAX_DEPTH = 3;

/** The host's shell-execution component (D3b), claimed only by a "!" scope.
 * Minified host builds rename constructors, so the name match is only the
 * unminified fast path; both pi's and OMP's bash components expose exactly
 * these four methods, which is the rename-proof identity (3E). */
const BASH_EXECUTOR_CTORS = /^BashExecutionComponent$/;
const BASH_EXECUTOR_METHODS = ["setExpanded", "appendOutput", "setComplete", "getOutput"] as const;

export type OutputTelegram = {
  chatId: number;
  messageThreadId?: number;
  messageId: number;
  /** Header already sent by the gateway; the first edit keeps it. */
  ackHtml: string;
};

type OutputTransport = Pick<TelegramTransport, "sendText" | "editText" | "sendDocument">;

type Binding = {
  scope: CommandScope;
  telegram: OutputTelegram;
  entries: string[];
  dropped: number;
  /** BashExecutionComponents claimed by a "!" scope (D3b); final render once. */
  bashComponents: Record<string, unknown>[];
  /** Output already rendered into the ack message (non-overflow case). */
  outputHtml: string;
  /** True once the ack message could not hold the output and tails were sent. */
  overflowed: boolean;
  lastText?: string;
  lastEditAt: number;
  timer?: NodeJS.Timeout;
  flushing: boolean;
  finalPending: boolean;
  finished: boolean;
};

export class OutputCapture {
  private binding?: Binding;
  private readonly attached = new WeakSet<object>();
  /** Objects that already carry the command-context stages (prompt, history). */
  private readonly chainHooked = new WeakSet<object>();
  private statusDepth = 0;
  private unsubscribe?: () => void;
  /** Prototypes whose `exportToHtml`/`exportToJsonl` already carry the
   * T4.4 file-send wrapper. */
  private readonly exportProtos = new WeakSet<object>();
  /** `attached` already holds `mode` from the status-hook loop; report hooks
   * need their own dedupe set. */
  private readonly reportHooked = new WeakSet<object>();
  /** D3b: bash components claimed by the "!" scope, and the ones whose final
   * render already went out. */
  private readonly bashTracked = new WeakSet<object>();
  private readonly bashPushed = new WeakSet<object>();
  /** Components whose `setComplete` has fired; only these may owe a final
   * render at scope end (F2: an unfinished one never pushes its running frame). */
  private readonly bashCompleted = new WeakSet<object>();

  constructor(
    private readonly transport: OutputTransport,
    private readonly origin: OriginTracker,
    private readonly secrets?: SecretStore,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onHostState((state) => this.attach(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.finish();
    removeOwnerHooks(this);
  }

  bind(scope: CommandScope, telegram: OutputTelegram): void {
    this.finish();
    this.binding = {
      scope,
      telegram,
      entries: [],
      dropped: 0,
      bashComponents: [],
      outputHtml: "",
      overflowed: false,
      lastEditAt: 0,
      flushing: false,
      finalPending: false,
      finished: false,
    };
  }

  /** True while the active binding claims a host bash component whose
   * `setComplete` has not fired yet. `OriginTracker.holdOpen` keeps the
   * scope alive while this holds, so the idle end never cuts the command's
   * final output short. */
  hasRunningBash(): boolean {
    const binding = this.binding;
    if (!binding) return false;
    return binding.bashComponents.some((child) => !this.bashCompleted.has(child));
  }

  /** Flush the active binding and stop claiming output for it. */
  finish(): void {
    const binding = this.binding;
    if (!binding || binding.finished) return;
    // D3b: only a completed component still owes its final render to the ack
    // message. A still-running one means the scope ended by timeout or
    // replacement; its "running" frame is not output, so drop it (F2).
    for (const child of binding.bashComponents) {
      if (this.bashCompleted.has(child)) this.emitBashOutput(child, binding, true);
      else outputLog.debug("bash component unfinished at scope end; running frame dropped", { scope: binding.scope.id });
    }
    binding.finished = true;
    if (binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    void this.flush(binding, true).finally(() => {
      if (this.binding === binding) this.binding = undefined;
    });
  }

  /** D3b: claim a BashExecutionComponent for the "!" scope. Its final render
   * goes out exactly once: `BASH_SETTLE_MS` after the host calls
   * `setComplete`, or at scope end when the component finished but the scope
   * ends first (the `finish` fallback). An unfinished component is dropped. */
  private trackBashComponent(child: Record<string, unknown>): void {
    const binding = this.binding;
    if (!binding || binding.finished || this.bashPushed.has(child)) return;
    if (!binding.bashComponents.includes(child)) binding.bashComponents.push(child);
    if (this.bashTracked.has(child)) return;
    this.bashTracked.add(child);
    hookMethod(child, "setComplete", "output-bash-complete", undefined, () => {
      this.bashCompleted.add(child);
      // Postpone the idle end past the settle delay so `finish` cannot beat
      // the timer and render before the host's async output flush landed.
      this.origin.touch(binding.scope);
      const timer = setTimeout(() => this.emitBashOutput(child, binding, false), BASH_SETTLE_MS);
      timer.unref?.();
    }, this);
  }

  private emitBashOutput(child: Record<string, unknown>, binding: Binding, final: boolean): void {
    if (this.bashPushed.has(child)) return;
    this.bashPushed.add(child);
    const html = bashOutputHtml(child, (raw) => this.redact(raw));
    this.logCaptured(child, html);
    if (!html || this.binding !== binding || binding.finished) return;
    // At scope end `push` refuses (the scope no longer owns output), so the
    // final render goes straight into the entries the final flush drains.
    if (final || binding.scope.ended) binding.entries.push(html);
    else this.push(html);
  }

  /** Secrets never ride the output path (§4.7.4): raw text is masked first. */
  private redact(text: string): string {
    const binding = this.binding;
    if (!binding || !this.secrets) return text;
    const { chatId, messageThreadId } = binding.telegram;
    return this.secrets.redact(`${chatId}:${messageThreadId ?? "main"}`, text);
  }

  /** Debug trace of one claimed component: what it was and what the render
   * produced. The sample is ANSI-free and redacted, first 80 chars only; the
   * full content never lands in the log. A `lines: 0` record is the blank-ack
   * signature: a claimed component whose render produced nothing. */
  private logCaptured(child: Record<string, unknown>, html: string | undefined): void {
    const fields: LogFields = {
      ctor: ctorName(child),
      lines: html ? html.split("\n").length : 0,
      sample: this.sample(html),
    };
    const children = child.children;
    if (Array.isArray(children)) fields.children = children.length;
    outputLog.debug("captured component", fields);
  }

  /** The sample is redacted here as well, so the no-secret guarantee holds
   * locally even if a render path ever hands back raw text. */
  private sample(html: string | undefined): string {
    if (!html) return "";
    return stripAnsi(this.redact(html)).slice(0, 80);
  }

  private attach(state: HostState): void {
    for (const target of [state.mode, state.ui]) {
      if (!isHostObject(target) || this.attached.has(target)) continue;
      this.attached.add(target);
      for (const name of ["showStatus", "showError", "showWarning"]) {
        hookMethod(target, name, `output-${name}`, () => { this.statusDepth += 1; }, (args) => {
          this.statusDepth = Math.max(0, this.statusDepth - 1);
          const message = args[0];
          if (typeof message !== "string" || message.trim().length === 0) return;
          const prefix = name === "showError" ? "❌ " : name === "showWarning" ? "⚠️ " : "";
          this.push(`${prefix}${escapeHtml(this.redact(stripAnsi(message)))}`);
        }, this);
      }
    }
    // OMP reports (`/mcp` and friends) draw a titled block on the main screen
    // instead of opening a dialog: `showCommandReport({ title, body })`. It is
    // command output (T3.1).
    const mode = state.mode;
    if (isHostObject(mode) && !this.reportHooked.has(mode)) {
      this.reportHooked.add(mode);
      hookMethod(mode, "showCommandReport", "output-command-report", undefined, (args) => {
        const report = args[0] as { title?: unknown; body?: unknown } | undefined;
        const title = typeof report?.title === "string" ? report.title.trim() : "";
        const body = isHostObject(report?.body)
          ? contentHtml(report.body, (raw) => this.redact(raw))
          : undefined;
        if (!title && !body) return;
        this.push(title ? `<b>${escapeHtml(this.redact(title))}</b>\n${body ?? ""}` : body!);
      }, this);
    }

    const chat = state.chat;
    if (isHostObject(chat) && !this.attached.has(chat)) {
      this.attached.add(chat);
      hookMethod(chat, "addChild", "output-add-child", undefined, (args) => {
        if (this.statusDepth > 0) return;
        // Only a child added inside the call chain of this binding's command is
        // its output. Agent events, history rebuilds and the turn a command
        // starts run in other contexts (command-context.ts), so they never match.
        const binding = this.binding;
        if (!binding || currentCommandScope() !== binding.scope) return;
        const child = args[0];
        if (!isHostObject(child)) return;
        // A bash component claimed from the pending area (H34) moves into the
        // chat on the next user submit; it is already owned, so it is neither
        // tracked nor pushed a second time from here.
        if (this.bashTracked.has(child) || this.bashPushed.has(child)) return;
        // D3b: inside a "!" scope the host's bash executor is the command's
        // own output; its final text comes from getOutput().
        if (binding.scope.label === "!" && isBashExecutor(child)) {
          this.trackBashComponent(child);
          return;
        }
        const html = contentHtml(child, (raw) => this.redact(raw));
        this.logCaptured(child, html);
        if (!html) return;
        this.push(html);
      }, this);
    }
    this.attachCommandChain(state);
    // H34: a `!` command run while the agent streams is parked in the host's
    // pending area (pi interactive-mode.js 5866, OMP command-controller.ts
    // #executeBashCommand) until the next submit moves it to the chat. Claim
    // its bash executor here too, so its result still reaches Telegram. Other
    // pending children (queued user messages) are not command output.
    const pending = isHostObject(mode) ? mode.pendingMessagesContainer : undefined;
    if (isHostObject(pending) && !this.attached.has(pending)) {
      this.attached.add(pending);
      hookMethod(pending, "addChild", "output-pending-add-child", undefined, (args) => {
        const child = args[0];
        if (!isHostObject(child)) return;
        if (this.binding?.scope.label !== "!" || !isBashExecutor(child)) return;
        this.trackBashComponent(child);
      }, this);
    }
    // T4.4: `/export` ends with a file on disk; the terminal prints its path,
    // the Telegram user gets the file itself (decision 20). The wrapper goes on
    // the *prototype*: both hosts call the method on the session object
    // (pi 1.4.0 interactive-mode.ts 6501 -> agent-session.ts 4348, OMP 18.12.5
    // command-controller.ts 354 -> agent-session.ts 13714), and OMP may hand us
    // a freshly focused sub-session of the same class.
    const session = state.session;
    if (isHostObject(session)) {
      const proto = Object.getPrototypeOf(session);
      if (isHostObject(proto) && !this.exportProtos.has(proto)) {
        this.exportProtos.add(proto);
        // pi's `/export foo.jsonl` takes the sibling sync method instead
        // (interactive-mode.js 5408), so both names share one wrapper.
        for (const name of ["exportToHtml", "exportToJsonl"]) {
          // With PITG_PROBE on, the probe already shadowed the method with an
          // instance wrapper before any capture listener ran (tui-bridge.ts
          // 212), so a prototype wrapper would be unreachable for this object;
          // such an instance gets the wrapper on itself instead - exactly one
          // path ever fires, so the file is never sent twice.
          const target = Object.prototype.hasOwnProperty.call(session, name) ? session : proto;
          hookMethod(target, name, `output-${name}`, undefined, (_args, result) => {
            this.captureExport(result);
          }, this);
        }
      }
    }
  }

  /** v8 §0.2 cut-offs: the agent turn a command starts (`session.prompt`) and
   * the host's history rebuilds leave the command call chain. Each target gets
   * its stage once; installing the same kind again only replaces it. */
  private attachCommandChain(state: HostState): void {
    const session = state.session;
    if (isHostObject(session)) {
      const proto = Object.getPrototypeOf(session);
      // Same own-property rule as the export wrapper below: a session that
      // carries its own `prompt` (a probe shadow) takes the stage on itself.
      const target = Object.prototype.hasOwnProperty.call(session, "prompt") ? session : proto;
      if (isHostObject(target) && !this.chainHooked.has(target)) {
        this.chainHooked.add(target);
        installHook(target, "prompt", "output-prompt-outside", (next, args) => runOutsideCommand(() => next(args)), {
          priority: 40,
          owner: this,
        });
      }
    }
    const mode = state.mode;
    if (isHostObject(mode) && !this.chainHooked.has(mode)) {
      this.chainHooked.add(mode);
      for (const name of HISTORY_REBUILD_METHODS) {
        installHook(mode, name, "output-history", (next, args) => runAsHistory(() => next(args)), {
          priority: 40,
          owner: this,
        });
      }
    }
  }

  private push(html: string): void {
    outputLog.debug("output push", { length: html.length });
    const binding = this.binding;
    if (!binding || binding.finished) return;
    if (this.origin.active() !== binding.scope || binding.scope.ended) return;
    this.origin.touch(binding.scope);
    const value = html.trim();
    if (!value) return;
    if (binding.entries[binding.entries.length - 1] === value) return;
    if (binding.entries.length >= MAX_COMPONENTS) {
      binding.dropped += 1;
      return;
    }
    binding.entries.push(value);
    this.schedule(binding);
  }

  private schedule(binding: Binding): void {
    if (binding.timer) return;
    const wait = Math.max(0, Math.min(OUTPUT_DEBOUNCE_MS, OUTPUT_EDIT_MS - (Date.now() - binding.lastEditAt)));
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      void this.flush(binding, false);
    }, wait);
    binding.timer.unref?.();
  }

  private async flush(binding: Binding, final: boolean): Promise<void> {
    if (binding.flushing) {
      if (final) binding.finalPending = true;
      return;
    }
    if (binding.entries.length === 0 && !final) return;
    binding.flushing = true;
    try {
      let added = binding.entries.splice(0).join("\n\n").trim();
      const dropped = binding.dropped;
      binding.dropped = 0;
      if (dropped > 0) {
        const tail = `…${dropped} more output entries; see the terminal`;
        added = added ? `${added}\n\n${tail}` : tail;
      }
      const combined = added
        ? (binding.outputHtml ? `${binding.outputHtml}\n\n${added}` : added)
        : binding.outputHtml;
      const header = binding.telegram.ackHtml;
      // Empty output must not append the separator: the final ack would
      // otherwise carry three blank lines before `✓ Done`.
      const single = splitTelegramHtml(combined ? `${header}\n\n${combined}` : header, 3400);
      if (single.length === 1 && !binding.overflowed) {
        let text = single[0];
        if (final && !text.includes("✓ Done")) text += "\n\n<i>✓ Done</i>";
        if (text !== binding.lastText) {
          binding.lastText = text;
          binding.lastEditAt = Date.now();
          await this.transport.editText(binding.telegram.chatId, binding.telegram.messageId, text)
            .catch(outputLog.swallow("debug", "edit command output failed", { chatId: binding.telegram.chatId }));
        }
        binding.outputHtml = combined;
      } else {
        const body = binding.overflowed ? added : combined;
        if (body) {
          for (const chunk of splitTelegramHtml(body, 3400)) {
            await this.transport.sendText(
              binding.telegram.chatId,
              chunk,
              binding.telegram.messageThreadId,
            ).catch(outputLog.swallow("warn", "send command output tail failed", { chatId: binding.telegram.chatId }));
          }
        }
        binding.overflowed = true;
        binding.outputHtml = "";
        if (final) {
          await this.transport.sendText(
            binding.telegram.chatId,
            "<i>✓ Done</i>",
            binding.telegram.messageThreadId,
          ).catch(outputLog.swallow("debug", "send command completion failed", { chatId: binding.telegram.chatId }));
        }
      }
    } finally {
      binding.flushing = false;
      if (binding.finalPending) {
        binding.finalPending = false;
        void this.flush(binding, true);
      }
    }
  }

  /** Send the file an `/export` just produced back to the scope that asked for
   * it. OMP's `/share` writes a temp file through the same method
   * (command-controller.ts 503), so the scope label is the gate: anything that
   * is not an `export` scope sends nothing. */
  private captureExport(result: unknown): void {
    const binding = this.binding;
    if (!binding || binding.finished || binding.scope.ended) return;
    if (binding.scope.label !== "export") return;
    void Promise.resolve(result).then((value) => {
      if (binding.finished || binding.scope.ended) return;
      if (typeof value !== "string" || value.trim().length === 0) return;
      if (!existsSync(value)) return;
      const { chatId, messageThreadId } = binding.telegram;
      void this.transport.sendDocument(
        chatId,
        value,
        "Session export",
        undefined,
        messageThreadId,
        binding.scope.origin.sourceMessageId,
      ).catch(outputLog.swallow("warn", "send exported session failed", { chatId, path: value }));
    }, () => undefined);
  }
}

function ctorName(child: Record<string, unknown>): string {
  try {
    return Object.getPrototypeOf(child)?.constructor?.name ?? child.constructor?.name ?? "";
  } catch {
    return "";
  }
}

/** Rename-proof identification of the host's bash executor: the four methods
 * pi's and OMP's `BashExecutionComponent` share (pi 1.4.0 bash-execution.ts
 * 68/83/101/213, OMP 18.12.5 bash-execution.ts 142/221/342/470). */
function isBashExecutor(child: Record<string, unknown>): boolean {
  if (BASH_EXECUTOR_CTORS.test(ctorName(child))) return true;
  return BASH_EXECUTOR_METHODS.every((name) => typeof child[name] === "function");
}

/** Text of a host bash executor, read through its `getOutput()` (v8 §0.2:
 * `render()` is never called). Redacted and ANSI-free before it is wrapped. */
function bashOutputHtml(child: Record<string, unknown>, redact: (text: string) => string): string | undefined {
  const getOutput = child.getOutput;
  if (typeof getOutput !== "function") return undefined;
  let raw: unknown;
  try {
    raw = (getOutput as () => unknown).call(child);
  } catch {
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const clean = redact(stripAnsi(raw)).trimEnd();
  return clean.trim() ? `<pre>${escapeHtml(clean)}</pre>` : undefined;
}

type ContentPiece = { kind: "markdown" | "text"; value: string };

/** Text of a command's output component, from its data only (v8 §0.2, never `render()`):
 * - `markdown` string field, or a pi `Markdown` (its own `theme` field) `text` field: markdown source;
 * - a pi `ThemedText` (`build` function, which returns the themed string): plain text;
 * - a pi `Text` (`text` string): plain text;
 * - a container's `children`, read in order up to CONTENT_MAX_DEPTH levels;
 * - anything else (Spacer, DynamicBorder, ...) has no content and is skipped.
 * The result is Telegram HTML, redacted; undefined when there is no content. */
export function contentHtml(
  component: Record<string, unknown>,
  redact: (text: string) => string = (text) => text,
): string | undefined {
  const pieces: ContentPiece[] = [];
  collectContent(component, 0, pieces);
  if (pieces.length === 0) {
    if (typeof component.describe === "function") {
      // OMP semantic trees are converted by N-1; until then they are skipped.
      outputLog.debug("component has describe() only; skipped until semantic output is supported", { ctor: ctorName(component) });
    }
    return undefined;
  }
  const html = pieces
    .map((piece) => piece.kind === "markdown"
      ? markdownToTelegramHtml(redact(piece.value))
      : plainHtml(redact(stripAnsi(piece.value))))
    .filter((part) => part.length > 0);
  return html.length > 0 ? html.join("\n\n") : undefined;
}

function plainHtml(clean: string): string {
  if (!clean.trim()) return "";
  return clean.includes("\n") ? `<pre>${escapeHtml(clean)}</pre>` : escapeHtml(clean);
}

function collectContent(node: Record<string, unknown>, depth: number, out: ContentPiece[]): void {
  const markdown = node.markdown;
  if (typeof markdown === "string" && markdown.trim()) {
    out.push({ kind: "markdown", value: markdown });
    return;
  }
  const build = node.build;
  if (typeof build === "function") {
    try {
      const value = (build as () => unknown).call(node);
      if (typeof value === "string" && value.trim()) {
        out.push({ kind: "text", value });
        return;
      }
    } catch {
      // unreadable content: fall through to the other sources
    }
  }
  const text = node.text;
  if (typeof text === "string" && text.trim()) {
    // pi's Markdown and Text both keep their string in `text`; only Markdown
    // carries the `theme` field it renders with (markdown.ts 258-265).
    const isMarkdown = Object.prototype.hasOwnProperty.call(node, "theme");
    out.push({ kind: isMarkdown ? "markdown" : "text", value: text });
    return;
  }
  const children = node.children;
  if (Array.isArray(children) && depth < CONTENT_MAX_DEPTH) {
    for (const child of children) {
      if (isHostObject(child)) collectContent(child, depth + 1, out);
    }
  }
}
