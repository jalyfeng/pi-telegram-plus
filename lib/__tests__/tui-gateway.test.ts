import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandGateway, type GatewayDeps } from "../tui/gateway.ts";
import { OriginTracker, IDLE_MS } from "../tui/origin.ts";
import { OutputCapture, renderComponent } from "../tui/output.ts";
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
    snapshot: () => undefined,
    key: () => true,
    write: () => true,
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
    onLocalSubmit: () => () => undefined,
  };
}

describe("command gateway", () => {
  it("renders text, markdown and arbitrary components", () => {
    expect(renderComponent({ text: "plain" })).toBe("plain");
    expect(renderComponent({ text: "a\nb" })).toBe("<pre>a\nb</pre>");
    expect(renderComponent({ markdown: "**bold**" })).toContain("<b>bold</b>");
    expect(renderComponent({ render: () => ["a", "b"] })).toBe("<pre>a\nb</pre>");
    expect(renderComponent({ render: () => [] })).toBeUndefined();
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
    expect(transport.edits.at(-1)?.text).toContain("✓ Done");
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
    body: { render: () => ["Commands:", "  /mcp add   Add a new MCP server"] },
  };

  it("returns a titled report as command output inside the scope", async () => {
    vi.useFakeTimers();
    let hostCalls = 0;
    const mode: ReportMode = { showCommandReport() { hostCalls += 1; } };
    const { transport, origin, output } = attached(mode);
    const scope = origin.begin({ chatId: 1 }, "mcp", "/mcp", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /mcp</b>" });
    mode.showCommandReport(report);
    expect(hostCalls).toBe(1);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("MCP Server Management");
    expect(text).toContain("/mcp add");
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
  // The capture identifies the host's component by constructor name
  // (BASH_EXECUTOR_CTORS) or, when the bundle minifies names, by its four
  // bash methods (isBashExecutor).
  class BashExecutionComponent {
    constructor(public lines: string[]) {}
    render() { return ["$ echo hi", ...this.lines, "exit: 0"]; }
    setComplete(_exitCode: number, _cancelled?: boolean): void {}
  }

  // OMP's bundle minifies class names; `qs` is also in AGENT_CTORS, so this
  // pins that the bash claim runs before the agent gate and wins inside a
  // ! scope (3E: the running frame used to be pushed as plain output).
  class qs {
    constructor(public lines: string[]) {}
    render() { return ["$ echo hi", ...this.lines, "exit: 0"]; }
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

  it("renders the bash component's final output into the ack inside a ! scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new BashExecutionComponent(["hi"]);
    chat.addChild(component);
    component.setComplete(0);
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("<pre>");
    expect(text).toContain("$ echo hi");
    expect(text).toContain("exit: 0");
    output.finish();
    origin.end(scope, "idle");
  });

  it("drops the running frame at scope end when setComplete never fires", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!sleep 5", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !sleep 5</b>" });
    chat.addChild(new BashExecutionComponent(["⠋ Running…"]));
    expect(output.hasRunningBash()).toBe(true);
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    // The scope ended (timeout/replacement) while the command still ran;
    // pushing the spinner frame would strand it as the "final" output.
    expect(transport.edits.every((edit) => !edit.text.includes("exit: 0"))).toBe(true);
    origin.end(scope, "timeout");
  });

  it("pushes the frame rendered after setComplete, not the running one", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "!", "!echo hi", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ !echo hi</b>" });
    const component = new BashExecutionComponent(["⠋ Running…"]);
    expect(output.hasRunningBash()).toBe(false);
    chat.addChild(component);
    expect(output.hasRunningBash()).toBe(true);
    component.setComplete(0);
    expect(output.hasRunningBash()).toBe(false);
    // OMP flushes the remaining PTY output asynchronously after setComplete;
    // the pushed frame is the render taken after the settle delay.
    component.lines = ["hi", "exit: 0"];
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
    const component = new BashExecutionComponent(["nope"]);
    chat.addChild(component);
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
    const component = new BashExecutionComponent(["once"]);
    chat.addChild(component);
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
    chat.addChild(component);
    expect(output.hasRunningBash()).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    // The running frame never reaches the transport while the command runs.
    expect(transport.edits).toEqual([]);
    component.lines = ["hi", "exit: 0"];
    component.setComplete(0);
    expect(output.hasRunningBash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("exit: 0");
    expect(text).not.toContain("Running");
    output.finish();
    origin.end(scope, "idle");
  });

  // A bash executor whose name is not an agent ctor and that is not in the
  // chat's agent gate: only the pending-area claim or the dedup can decide it.
  class BashRunner {
    constructor(public lines: string[]) {}
    render() { return ["$ ls", ...this.lines, "exit: 0"]; }
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
    const component = new BashRunner(["file.txt"]);
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
    chat.addChild(component);
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

describe("OutputCapture transcript-reset scopes", () => {
  // OMP's /clear and /delete reset the transcript, then present their result
  // component in the same task (command-controller.ts 1349/1380). The `clear`
  // hook marks the chat as rebuilding until the next tick, so
  // REBUILD_OUTPUT_LABELS must keep claiming children added during it.
  class ResetResultComponent {
    constructor(public line: string) {}
    render() { return [this.line]; }
  }
  // Name matches AGENT_CTORS: rebuilt history stays excluded even inside a
  // reset scope.
  class AssistantMessageComponent {
    render() { return ["old assistant message"]; }
  }

  function attachedChat() {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const chat = {
      clear(): void {},
      addChild: (_child: unknown) => undefined,
    };
    (output as unknown as { attach(state: unknown): void }).attach({ host: "pi", mode: {}, chat });
    return { transport, origin, output, chat };
  }

  function resetScope(origin: OriginTracker, output: OutputCapture, label: string) {
    const scope = origin.begin({ chatId: 1 }, label, `/${label}`, "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  }

  it("keeps the /clear result mounted right after the transcript reset", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = resetScope(origin, output, "clear");
    chat.clear();
    chat.addChild(new ResetResultComponent("\u2713 Context reset \u2014 0 messages dropped"));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("\u2713 Context reset \u2014 0 messages dropped");
    origin.end(scope, "idle");
  });

  it("keeps the /delete result mounted right after the transcript reset", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = resetScope(origin, output, "delete");
    chat.clear();
    chat.addChild(new ResetResultComponent("Session deleted"));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("Session deleted");
    origin.end(scope, "idle");
  });

  it("still skips children added during a reset outside the reset labels", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = resetScope(origin, output, "resume");
    chat.clear();
    chat.addChild(new ResetResultComponent("must not reach the ack"));
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("must not reach the ack"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("excludes rebuilt agent history inside a clear scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = resetScope(origin, output, "clear");
    chat.clear();
    chat.addChild(new AssistantMessageComponent());
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("old assistant message"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("sends the final ack without a blank separator when nothing was captured", async () => {
    vi.useFakeTimers();
    const { transport, origin, output } = attachedChat();
    const scope = resetScope(origin, output, "x");
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toBe("<b>\u25b6\ufe0f /x</b>\n\n<i>\u2713 Done</i>");
    origin.end(scope, "idle");
  });
});

describe("OutputCapture agent tool-call components", () => {
  // OMP's ToolExecutionComponent is minified and keeps toolCallId private, so
  // only its method shape (updateArgs/updateResult/setArgsComplete) marks it.
  class Zx {
    render() { return ["$ sed -n '1,2p' a.py"]; }
    updateArgs(_args: unknown): void {}
    updateResult(_result: unknown): void {}
    setArgsComplete(): void {}
  }
  class ReportBlock {
    render() { return ["Logging in to deepseek…"]; }
  }
  // Only two of the three tool-call methods: not an agent component.
  class PartialToolBlock {
    render() { return ["partial block output"]; }
    updateArgs(_args: unknown): void {}
    updateResult(_result: unknown): void {}
  }

  function attachedChat() {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const chat = { addChild: (_child: unknown) => undefined };
    (output as unknown as { attach(state: unknown): void }).attach({ host: "pi", mode: {}, chat });
    return { transport, origin, output, chat };
  }

  it("does not capture a minified tool-call component running inside a command scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "login", "/login", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /login</b>" });
    chat.addChild(new Zx());
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.every((edit) => !edit.text.includes("sed -n"))).toBe(true);
    origin.end(scope, "idle");
  });

  it("still captures ordinary command output in the same scope", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "login", "/login", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /login</b>" });
    chat.addChild(new Zx());
    chat.addChild(new ReportBlock());
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("Logging in to deepseek…");
    origin.end(scope, "idle");
  });

  it("treats a component with only two of the tool-call methods as command output", async () => {
    vi.useFakeTimers();
    const { transport, origin, output, chat } = attachedChat();
    const scope = origin.begin({ chatId: 1 }, "login", "/login", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /login</b>" });
    chat.addChild(new PartialToolBlock());
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("partial block output");
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
