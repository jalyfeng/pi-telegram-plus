import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandGateway, type GatewayDeps } from "../tui/gateway.ts";
import { OriginTracker, IDLE_MS } from "../tui/origin.ts";
import { OutputCapture, contentHtml } from "../tui/output.ts";
import { runInCommand } from "../tui/command-context.ts";
import type { CommandScope } from "../tui/origin.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";
import { takePendingNotices } from "../pending-notices.ts";

const checkpointCursor = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../polling.ts", () => ({ checkpointCurrentUpdateCursor: checkpointCursor }));

afterEach(() => {
  vi.useRealTimers();
});

function fakeTransport() {
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const sends: Array<{ chatId: number; text: string }> = [];
  return {
    edits,
    sends,
    sendText: vi.fn(async (chatId: number, text: string) => {
      sends.push({ chatId, text });
      return [{ message_id: sends.length }];
    }),
    editText: vi.fn(async (chatId: number, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
    }),
    sendDocument: vi.fn(async () => undefined),
  };
}

function fakeBridge(result: Promise<unknown>): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [],
    submit: () => true,
    submitResult: () => ({ ok: true, result }),
    readEditorText: () => "",
    writeEditorText: () => true,
    key: () => true,
    write: () => true,
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
  };
}

describe("command gateway", () => {
  it("reads command output from data fields only, never render()", () => {
    expect(contentHtml({ text: "plain" })).toBe("plain");
    expect(contentHtml({ text: "a\nb" })).toBe("<pre>a\nb</pre>");
    expect(contentHtml({ markdown: "**bold**" })).toContain("<b>bold</b>");
    expect(contentHtml({ text: "**x**", theme: {} })).toContain("<b>x</b>");
    expect(contentHtml({ text: "", build: () => "\x1b[36mSession: abc\x1b[0m" })).toBe("Session: abc");
    expect(contentHtml({ children: [{}, { text: "child" }] })).toBe("child");
    expect(contentHtml({})).toBeUndefined();
    const render = vi.fn(() => ["a", "b"]);
    expect(contentHtml({ render })).toBeUndefined();
    expect(render).not.toHaveBeenCalled();
  });

  it("ends an idle scope and restores the saved draft", async () => {
    vi.useFakeTimers();
    let draft = "draft text";
    const writes: string[] = [];
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { writes.push(text); draft = text; return true; },
    });
    const ended: string[] = [];
    origin.onEnd((scope, reason) => ended.push(`${scope.label}:${reason}`));
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "draft text");
    origin.markSubmitDone(scope);
    draft = ""; // host cleared the editor after submission
    await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(ended).toEqual(["session:idle"]);
    expect(writes).toContain("draft text");
  });

  it("holds an idle scope open while holdOpen is true", async () => {
    vi.useFakeTimers();
    let hold = true;
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => "",
      writeDraft: () => true,
      holdOpen: () => hold,
    });
    const ended: string[] = [];
    origin.onEnd((scope, reason) => ended.push(`${scope.label}:${reason}`));
    const scope = origin.begin({ chatId: 1 }, "!", "!sleep 5", "");
    origin.markSubmitDone(scope);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(ended).toEqual([]);
    hold = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(ended).toEqual(["!:idle"]);
  });

  it("does not overwrite text the user typed during the scope", async () => {
    vi.useFakeTimers();
    let draft = "saved";
    const writes: string[] = [];
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { writes.push(text); return true; },
    });
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "saved");
    origin.markSubmitDone(scope);
    draft = "typed by user";
    await vi.advanceTimersByTimeAsync(IDLE_MS + 200);
    expect(scope.localEdited).toBe(true);
    expect(writes).toEqual([]);
  });

  it("submits a host command, captures output and reports completion", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    let draft = "draft text";
    let resolveSubmit: (() => void) | undefined;
    const submitPromise = new Promise<void>((resolve) => { resolveSubmit = resolve; });
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { draft = text; return true; },
    });
    const focus = new FocusTracker();
    const output = new OutputCapture(transport, origin);
    const bridge = fakeBridge(submitPromise);
    const gateway = new CommandGateway({
      bridge,
      origin,
      output,
      focus,
      isEnabled: () => true,
      hostName: () => "pi",
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
      readDraft: () => draft,
    });
    gateway.start();

    const handled = await gateway.run({
      name: "session",
      args: "",
      origin: { chatId: 7 },
      transport,
    });
    expect(handled).toBe(true);
    expect(transport.sends[0]?.text).toContain("/session");
    draft = "";
    resolveSubmit?.();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    await Promise.resolve();

    expect(transport.edits.length).toBeGreaterThan(0);
    expect(transport.edits[transport.edits.length - 1]?.text).toContain("✓ Done");
    expect(draft).toBe("draft text");
    gateway.dispose();
  });

  it("accumulates deferred output without erasing earlier entries", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /session</b>" });
    (output as unknown as { push(html: string): void }).push("first");
    await vi.advanceTimersByTimeAsync(800);
    expect(transport.edits.at(-1)?.text).toContain("first");
    (output as unknown as { push(html: string): void }).push("second");
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("first");
    expect(text).toContain("second");
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    // Done is shown only when there is nothing else to show.
    expect(transport.edits.at(-1)?.text).toContain("second");
    expect(transport.edits.at(-1)?.text).not.toContain("✓ Done");
    origin.end(scope, "idle");
  });

  it("claims every command while enabled, none when disabled", async () => {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const deps: Omit<GatewayDeps, "isEnabled"> = {
      bridge: fakeBridge(Promise.resolve()),
      origin,
      output: new OutputCapture(transport, origin),
      focus: new FocusTracker(),
      hostName: () => "pi" as const,
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
    };
    const gateway = new CommandGateway({ ...deps, isEnabled: () => true });
    expect(gateway.handles("settings")).toBe(true);
    expect(await gateway.run({ name: "settings", args: "", origin: { chatId: 1 }, transport })).toBe(true);
    expect(transport.sends).toHaveLength(1);

    const disabled = new CommandGateway({ ...deps, isEnabled: () => false });
    expect(disabled.handles("settings")).toBe(false);
    expect(await disabled.run({ name: "settings", args: "", origin: { chatId: 1 }, transport })).toBe(false);
    expect(transport.sends).toHaveLength(1);
  });

  it("runText submits raw editor text under its label and refuses without a host", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const submitted: string[] = [];
    const bridge = fakeBridge(Promise.resolve());
    bridge.submitResult = (text: string) => {
      submitted.push(text);
      return { ok: true, result: Promise.resolve() };
    };
    const deps: Omit<GatewayDeps, "isEnabled"> = {
      bridge,
      origin,
      output,
      focus: new FocusTracker(),
      hostName: () => "pi" as const,
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
      readDraft: () => "",
    };
    const gateway = new CommandGateway({ ...deps, isEnabled: () => true });
    gateway.start();

    const handled = await gateway.runText({ text: "!!date", label: "!", origin: { chatId: 7 }, transport });
    expect(handled).toBe(true);
    expect(submitted).toEqual(["!!date"]);
    expect(transport.sends[0]?.text).toContain("!!date");
    expect(origin.active()?.label).toBe("!");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    expect(transport.edits.at(-1)?.text).toContain("✓ Done");
    gateway.dispose();

    const withoutHost = new CommandGateway({ ...deps, isEnabled: () => true, hostState: () => ({ host: "pi" }) });
    expect(await withoutHost.runText({ text: "!date", label: "!", origin: { chatId: 7 }, transport })).toBe(false);
  });

  it("commits the update cursor before submitting to the host", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    checkpointCursor.mockImplementation(async () => { order.push("cursor"); return false; });
    const transport = fakeTransport();
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => "",
      writeDraft: () => true,
    });
    const bridge = fakeBridge(Promise.resolve());
    bridge.submitResult = () => { order.push("submit"); return { ok: true }; };
    const gateway = new CommandGateway({
      bridge,
      origin,
      output: new OutputCapture(transport, origin),
      focus: new FocusTracker(),
      isEnabled: () => true,
      hostName: () => "pi",
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
      readDraft: () => "",
    });
    gateway.start();

    await gateway.run({ name: "fork", args: "", origin: { chatId: 7 }, transport });

    // Session-replacing host commands reactivate the plugin in-process; the
    // cursor must be committed before the editor sees the text.
    expect(order).toEqual(["cursor", "submit"]);
    gateway.dispose();
  });

});

describe("OutputCapture command reports", () => {
  type ReportMode = { showCommandReport(report: unknown): void };
  function attached(mode: ReportMode) {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    // `attach` is private; drive it directly like the `push` cases above.
    const capture = output as unknown as { attach(state: unknown): void };
    capture.attach({ host: "omp", mode });
    return { transport, origin, output };
  }
  const report = {
    title: "MCP Server Management",
    body: { text: "Commands:\n  /mcp add   Add a new MCP server" },
  };

  it("returns a titled report as command output inside the scope", async () => {
    vi.useFakeTimers();
    let hostCalls = 0;
    const mode: ReportMode = { showCommandReport() { hostCalls += 1; } };
    const { transport, origin, output } = attached(mode);
    const scope = origin.begin({ chatId: 1 }, "mcp", "/mcp", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /mcp</b>" });
    runInCommand(scope, () => mode.showCommandReport(report));
    expect(hostCalls).toBe(1);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("MCP Server Management");
    expect(text).toContain("/mcp add");
    origin.end(scope, "idle");
  });

  it("does not claim a report shown outside the command chain while a scope is open", async () => {
    vi.useFakeTimers();
    const mode: ReportMode = { showCommandReport() {} };
    const { transport, origin, output } = attached(mode);
    const scope = origin.begin({ chatId: 1 }, "mcp", "/mcp", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /mcp</b>" });
    mode.showCommandReport(report);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("MCP Server Management"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("drops reports outside a command scope", async () => {
    vi.useFakeTimers();
    const mode: ReportMode = { showCommandReport() {} };
    const { transport, output } = attached(mode);
    mode.showCommandReport(report);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits).toEqual([]);
    expect(transport.sends).toEqual([]);
  });

  it("drops reports with neither title nor rendered body", async () => {
    vi.useFakeTimers();
    const mode: ReportMode = { showCommandReport() {} };
    const { transport, origin, output } = attached(mode);
    const scope = origin.begin({ chatId: 1 }, "mcp", "/mcp", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /mcp</b>" });
    mode.showCommandReport({ title: "", body: { render: () => [] } });
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("MCP"))).toBe(true);
    origin.end(scope, "idle");
  });
});

describe("OutputCapture shell scope", () => {
  // The bash executor is identified by its constructor name or, in minified
  // bundles, by its four methods (isBashExecutor). Its text comes from
  // getOutput(); these mocks have no render(), so a render call would fail.
  class BashExecutionComponent {
    constructor(public lines: string[]) {}
    setExpanded(_expanded: boolean): void {}
    appendOutput(_chunk: string): void {}
    setComplete(_exitCode: number, _cancelled?: boolean): void {}
    getOutput(): string { return this.lines.join("\n"); }
  }

  // OMP's bundle minifies class names; `qs` is also in AGENT_CTORS before the
  // removal, so this pins that the bash claim wins inside a ! scope by shape.
  class qs {
    constructor(public lines: string[]) {}
    setExpanded(_expanded: boolean): void {}
    appendOutput(_chunk: string): void {}
    setComplete(_exitCode: number, _cancelled?: boolean): void {}
    getOutput(): string { return this.lines.join("\n"); }
  }

  function attachedChat() {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const chat = { addChild: (_child: unknown) => undefined };
    // `attach` is private; drive it directly like the report cases above.
    (output as unknown as { attach(state: unknown): void }).attach({ host: "pi", mode: {}, chat });
    return { transport, origin, output, chat };
  }

  // The gateway adds host output inside the command's call chain; the tests do the same.
  function addInScope(chat: { addChild(child: unknown): unknown }, scope: CommandScope, child: unknown) {
    runInCommand(scope, () => chat.addChild(child));
  }

  it("renders the bash component's final output into the ack inside a ! scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new BashExecutionComponent(["bash-line-1", "exit: 0"]);
    addInScope(chat, scope, component);
    component.setComplete(0);
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("<pre>");
    expect(text).toContain("bash-line-1");
    expect(text).toContain("exit: 0");
    output.finish();
    origin.end(scope, "idle");
  });

  it("drops the running frame at scope end when setComplete never fires", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!sleep 5", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !sleep 5</b>" });
    addInScope(chat, scope, new BashExecutionComponent(["⠋ Running…"]));
    expect(output.hasRunningBash()).toBe(true);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    // The scope ended (timeout/replacement) while the command still ran;
    // pushing the spinner frame would strand it as the "final" output.
    expect(transport.edits.every((edit) => !edit.text.includes("Running"))).toBe(true);
    origin.end(scope, "timeout");
  });

  it("pushes the output read after setComplete, not the running one", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new BashExecutionComponent(["⠋ Running…"]);
    expect(output.hasRunningBash()).toBe(false);
    addInScope(chat, scope, component);
    expect(output.hasRunningBash()).toBe(true);
    component.setComplete(0);
    expect(output.hasRunningBash()).toBe(false);
    // OMP flushes the remaining PTY output asynchronously after setComplete;
    // the pushed text is the output read after the settle delay.
    component.lines = ["bash-line-2", "exit: 0"];
    await vi.advanceTimersByTimeAsync(299);
    expect(transport.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(750);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("exit: 0");
    expect(text).not.toContain("Running");
    output.finish();
    origin.end(scope, "idle");
  });

  it("keeps the bash component excluded outside a ! scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /session</b>" });
    const component = new BashExecutionComponent(["nope", "exit: 0"]);
    addInScope(chat, scope, component);
    component.setComplete(0);
    await vi.advanceTimersByTimeAsync(1100);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("exit: 0"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("renders each bash component once even when setComplete repeats", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new BashExecutionComponent(["once", "exit: 0"]);
    addInScope(chat, scope, component);
    component.setComplete(0);
    component.setComplete(0);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text.match(/exit: 0/g)?.length).toBe(1);
    origin.end(scope, "idle");
  });

  it("tracks a minified bash component by its methods, pushing only after setComplete", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new qs(["⠋ Running…"]);
    addInScope(chat, scope, component);
    expect(output.hasRunningBash()).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    // The running frame never reaches the transport while the command runs.
    expect(transport.edits).toEqual([]);
    component.lines = ["bash-line-3", "exit: 0"];
    component.setComplete(0);
    expect(output.hasRunningBash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("exit: 0");
    expect(text).not.toContain("Running");
    output.finish();
    origin.end(scope, "idle");
  });

  // A bash executor that is parked in the host's pending area (not the chat).
  class BashRunner {
    constructor(public lines: string[]) {}
    setExpanded(_expanded: boolean): void {}
    appendOutput(_chunk: string): void {}
    setComplete(_exitCode: number, _cancelled?: boolean): void {}
    getOutput(): string { return this.lines.join("\n"); }
  }

  function attachedPending() {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const chat = { addChild: (_child: unknown) => undefined };
    const pending = { addChild: (_child: unknown) => undefined };
    (output as unknown as { attach(state: unknown): void }).attach({
      host: "pi",
      mode: { pendingMessagesContainer: pending },
      chat,
    });
    return { transport, origin, output, chat, pending };
  }

  it("claims a ! command that is parked in the pending area while a turn runs", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, pending } = attachedPending();
    const scope = origin.begin({ chatId: 1 }, "!", "!ls", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !ls</b>" });
    const component = new BashRunner(["file.txt", "exit: 0"]);
    pending.addChild(component);
    expect(output.hasRunningBash()).toBe(true);
    component.setComplete(0);
    expect(output.hasRunningBash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("file.txt");
    expect(text).toContain("exit: 0");
    output.finish();
    origin.end(scope, "idle");
  });

  it("does not push a pending bash component again when it moves into the chat", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat, pending } = attachedPending();
    const first = origin.begin({ chatId: 1 }, "!", "!ls", "");
    output.bind(first, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !ls</b>" });
    const component = new BashRunner(["once-only"]);
    pending.addChild(component);
    component.setComplete(0);
    output.finish();
    origin.end(first, "idle");
    await vi.advanceTimersByTimeAsync(1100);
    const editsBefore = transport.edits.length;
    // The next submit flushes the pending area into the chat under another scope.
    const later = origin.begin({ chatId: 1 }, "model", "/model", "");
    output.bind(later, { chatId: 1, messageId: 10, ackHtml: "<b>▶️ /model</b>" });
    addInScope(chat, later, component);
    output.finish();
    await vi.advanceTimersByTimeAsync(1100);
    const laterEdits = transport.edits.slice(editsBefore).map((edit) => edit.text);
    expect(laterEdits.every((text) => !text.includes("once-only"))).toBe(true);
    origin.end(later, "idle");
  });

  it("ignores non-bash children in the pending area inside a ! scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, pending } = attachedPending();
    const scope = origin.begin({ chatId: 1 }, "!", "!ls", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !ls</b>" });
    pending.addChild({ text: "queued user message" });
    expect(output.hasRunningBash()).toBe(false);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("queued user message"))).toBe(true);
    expect(transport.sends.every((send) => !send.text.includes("queued user message"))).toBe(true);
    origin.end(scope, "idle");
  });
});

describe("OutputCapture command-chain attribution (v8 §0.2)", () => {
  function attachedChat(extra: Record<string, unknown> = {}) {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const chat = { addChild: (_child: unknown) => undefined };
    (output as unknown as { attach(state: unknown): void }).attach({ host: "pi", mode: {}, chat, ...extra });
    return { transport, origin, output, chat };
  }

  function beginCommand(origin: OriginTracker, output: OutputCapture, label: string) {
    const scope = origin.begin({ chatId: 1 }, label, `/${label}`, "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  }

  it("claims a ThemedText-shaped component added synchronously in the command chain, without ANSI", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "session");
    // pi ThemedText: empty `text`, the themed string comes from `build`.
    runInCommand(scope, () => chat.addChild({ text: "", build: () => "\x1b[36mSession: abc\x1b[0m" }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("Session: abc");
    expect(text).not.toContain("\u001b");
    origin.end(scope, "idle");
  });

  it("claims a Text-shaped component added after an await inside the command chain", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "hotkeys");
    const done = runInCommand(scope, async () => {
      await Promise.resolve();
      chat.addChild({ text: "added after await" });
    });
    await done;
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("added after await");
    origin.end(scope, "idle");
  });

  it("does not claim a tool-call box that agent events add while the command runs (#20)", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "login");
    // Command continuation: awaits inside the command chain (microtasks keep
    // the context under fake timers as well).
    const done = runInCommand(scope, async () => {
      await Promise.resolve();
      await Promise.resolve();
      chat.addChild({ text: "Logged in" });
    });
    // Agent event at the same time: a timer created outside any command chain.
    setTimeout(() => chat.addChild({ text: "$ sed -n '1,2p' a.py" }), 0);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("Logged in");
    expect(text).not.toContain("sed -n");
    origin.end(scope, "idle");
  });

  it("does not claim components added by the agent turn a command starts (session.prompt)", async () => {
    vi.useFakeTimers();
    let chatRef: { addChild(child: unknown): unknown } | undefined;
    class FakeSession {
      prompt(_text: string): Promise<void> {
        chatRef?.addChild({ text: "agent turn output" });
        return Promise.resolve();
      }
    }
    const session = new FakeSession();
    const { transport, origin, output, chat } = attachedChat({ session });
    chatRef = chat;
    const scope = beginCommand(origin, output, "clone");
    await runInCommand(scope, async () => {
      await session.prompt("continue");
      chat.addChild({ text: "command line" });
    });
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("command line");
    expect(text).not.toContain("agent turn output");
    origin.end(scope, "idle");
  });

  it("does not claim rebuilt history inside a command scope, but claims the summary added after it", async () => {
    vi.useFakeTimers();
    let chatRef: { addChild(child: unknown): unknown } | undefined;
    const mode = {
      renderInitialMessages(): void {
        chatRef?.addChild({ text: "old history message" });
      },
    };
    const { transport, origin, output, chat } = attachedChat({ mode });
    chatRef = chat;
    const scope = beginCommand(origin, output, "compact");
    runInCommand(scope, () => {
      mode.renderInitialMessages();
      chat.addChild({ text: "Compacted summary" });
    });
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("Compacted summary");
    expect(text).not.toContain("old history message");
    origin.end(scope, "idle");
  });

  it("keeps the /clear result added in its own command chain", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "clear");
    runInCommand(scope, () => chat.addChild({ text: "✓ Context reset — 0 messages dropped" }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("✓ Context reset — 0 messages dropped");
    origin.end(scope, "idle");
  });

  it("converts a Markdown-shaped component to Telegram HTML", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "report");
    // pi Markdown: its source is in `text`, and only Markdown has the `theme` field.
    runInCommand(scope, () => chat.addChild({ text: "**x**", theme: {} }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("<b>x</b>");
    origin.end(scope, "idle");
  });

  it("produces no output for a Spacer-shaped component", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "x");
    runInCommand(scope, () => chat.addChild({ invalidate(): void {} }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toBe("<b>▶️ /x</b>\n\n<i>✓ Done</i>");
    origin.end(scope, "idle");
  });

  it("never calls render() on a component that only has render()", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "x");
    const render = vi.fn(() => ["rendered picture"]);
    runInCommand(scope, () => chat.addChild({ render }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(render).not.toHaveBeenCalled();
    expect(transport.edits.every((edit) => !edit.text.includes("rendered picture"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("claims a deferred presentCommandOutput component at call time, once, and ignores its later mount", async () => {
    vi.useFakeTimers();
    const queued: unknown[] = [];
    const component = { text: "deferred output" };
    const mode = {
      presentCommandOutput(child: unknown): void {
        queued.push(child);
      },
    };
    const { transport, origin, output, chat } = attachedChat({ mode });
    const scope = beginCommand(origin, output, "usage");
    runInCommand(scope, () => mode.presentCommandOutput(component));
    // The host mounts the queued component later, from agent_end, outside the command chain.
    chat.addChild(queued[0]);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text.split("deferred output").length - 1).toBe(1);
    origin.end(scope, "idle");
  });

  it("pushes a presentCommandOutput component exactly once when the host mounts it synchronously", async () => {
    vi.useFakeTimers();
    const mode = {
      presentCommandOutput(child: unknown): void {
        chatRef?.addChild(child);
      },
    };
    let chatRef: { addChild(child: unknown): unknown } | undefined;
    const { transport, origin, output, chat } = attachedChat({ mode });
    chatRef = chat;
    const scope = beginCommand(origin, output, "usage");
    runInCommand(scope, () => mode.presentCommandOutput({ text: "sync output" }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text.split("sync output").length - 1).toBe(1);
    origin.end(scope, "idle");
  });

  it("reads a describe-only component through its tree and never calls render()", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = beginCommand(origin, output, "jobs");
    const render = vi.fn(() => ["rendered picture"]);
    const describe = vi.fn(() => ({ k: "text", p: { text: "Described line" } }));
    runInCommand(scope, () => chat.addChild({ render, describe }));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(describe).toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(transport.edits.at(-1)?.text).toContain("Described line");
    origin.end(scope, "idle");
  });
});

describe("command gateway /new across a runtime replacement", () => {
  function newSessionGateway(newSession: NonNullable<GatewayDeps["newSession"]>) {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const deps: Omit<GatewayDeps, "isEnabled"> = {
      bridge: fakeBridge(Promise.resolve()),
      origin,
      output: new OutputCapture(transport, origin),
      focus: new FocusTracker(),
      hostName: () => "pi" as const,
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
      readDraft: () => "",
      newSession,
    };
    return { transport, gateway: new CommandGateway({ ...deps, isEnabled: () => true }) };
  }

  it("hands the success result to the pending queue instead of editing the ack", async () => {
    takePendingNotices();
    const { transport, gateway } = newSessionGateway(async () => undefined);

    expect(await gateway.run({ name: "new", args: "", origin: { chatId: 1 }, transport })).toBe(true);

    // The ack is the only send this runtime makes; the result rides the queue,
    // because by then the replacement runtime owns the send lease.
    expect(transport.sends).toHaveLength(1);
    expect(transport.edits).toEqual([]);
    expect(takePendingNotices()).toEqual([expect.objectContaining({
      chatId: 1,
      editMessageId: 1,
      html: "<b>▶️ /new</b>\n\n✅ New session started",
    })]);
  });

  it("edits the ack itself when the user cancels", async () => {
    takePendingNotices();
    const { transport, gateway } = newSessionGateway(async () => ({ cancelled: true }));

    await gateway.run({ name: "new", args: "", origin: { chatId: 1 }, transport });

    expect(transport.edits.at(-1)?.text).toContain("Cancelled");
    expect(takePendingNotices()).toEqual([]);
  });

  it("edits the ack itself when the host rejects the new session", async () => {
    takePendingNotices();
    const { transport, gateway } = newSessionGateway(async () => { throw new Error("host refused"); });

    await gateway.run({ name: "new", args: "", origin: { chatId: 1 }, transport });

    expect(transport.edits.at(-1)?.text).toContain("Could not start a new session");
    expect(takePendingNotices()).toEqual([]);
  });
});
