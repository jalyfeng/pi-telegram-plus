/**
 * An OMP command report (`showCommandReport`, oh-my-pi@v18.14.1) is pushed to
 * Telegram once. The host builds the report panel and adds it to the report
 * container inside the same synchronous `showCommandReport` call, so the
 * container's addChild hook must not push it a second time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInCommand } from "../tui/command-context.ts";
import { OutputCapture } from "../tui/output.ts";
import { OriginTracker } from "../tui/origin.ts";
import { SecretStore } from "../tui/secrets.ts";

type CaptureTransport = ConstructorParameters<typeof OutputCapture>[0];

const BODY = "No MCP servers configured.\n\nUse /mcp add to add a server.";
const BODY_LINE = "No MCP servers configured.";

function fixture() {
  const editText = vi.fn(async () => undefined);
  const transport: CaptureTransport = {
    sendText: async () => [],
    editText,
    sendDocument: async () => undefined,
  };
  const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
  const output = new OutputCapture(transport, origin, new SecretStore());
  const capture = output as unknown as { attach(state: unknown): void };
  const bind = (label: string) => {
    const scope = origin.begin(
      { chatId: 42, messageThreadId: 7, sourceMessageId: 99 },
      label,
      `/${label}`,
      "",
    );
    output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  };
  return { editText, output, capture, bind };
}

/** A host mode in the OMP 18.14.1 shape: the report container is a field of the
 * mode, and `showCommandReport` adds its panel to that container synchronously. */
class FakeMode {
  readonly reportContainer = {
    children: [] as unknown[],
    addChild(child: unknown): void {
      this.children.push(child);
    },
  };
  showCommandReport(report: { title: string; body: unknown }): void {
    const panel = { title: report.title, children: [report.body] };
    this.reportContainer.addChild(panel);
  }
}

function chatFixture() {
  return { children: [] as unknown[], addChild(child: unknown): void { this.children.push(child); } };
}

/** Let the debounced flush (700 ms) and the edit run. */
async function settleOutput(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1500);
}

function lastEdit(editText: ReturnType<typeof vi.fn>): string {
  const calls = editText.mock.calls as unknown as unknown[][];
  return String(calls.at(-1)?.[2] ?? "");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutputCapture OMP command report", () => {
  it("pushes a showCommandReport body once, with its title", async () => {
    vi.useFakeTimers();
    const { editText, capture, bind } = fixture();
    const mode = new FakeMode();
    capture.attach({ mode, ui: {}, chat: chatFixture(), session: undefined });
    const scope = bind("mcp");
    runInCommand(scope, () => mode.showCommandReport({ title: "MCP Servers", body: { markdown: BODY } }));
    await settleOutput();
    const text = lastEdit(editText);
    expect(count(text, BODY_LINE)).toBe(1);
    expect(text).toContain("<b>MCP Servers</b>");
  });

  it("still pushes a report container addChild made outside showCommandReport", async () => {
    vi.useFakeTimers();
    const { editText, capture, bind } = fixture();
    const mode = new FakeMode();
    capture.attach({ mode, ui: {}, chat: chatFixture(), session: undefined });
    const scope = bind("report");
    runInCommand(scope, () => mode.reportContainer.addChild({ children: [{ markdown: "Direct report line" }] }));
    await settleOutput();
    expect(count(lastEdit(editText), "Direct report line")).toBe(1);
  });

  it("drops the suppression when showCommandReport throws", async () => {
    vi.useFakeTimers();
    const { editText, capture, bind } = fixture();
    const mode = new FakeMode();
    mode.showCommandReport = function (report) {
      this.reportContainer.addChild({ children: [report.body] });
      throw new Error("host failed");
    };
    capture.attach({ mode, ui: {}, chat: chatFixture(), session: undefined });
    const scope = bind("report");
    expect(() => runInCommand(scope, () => mode.showCommandReport({ title: "T", body: { markdown: BODY } }))).toThrow("host failed");
    runInCommand(scope, () => mode.reportContainer.addChild({ children: [{ markdown: "After failure" }] }));
    await settleOutput();
    expect(count(lastEdit(editText), "After failure")).toBe(1);
  });
});
