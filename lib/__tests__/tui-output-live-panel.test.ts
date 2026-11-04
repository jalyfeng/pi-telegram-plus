/**
 * The settled result of a live panel (/btw, /omfg, /cleanse; oh-my-pi@v18.14.1) reaches the
 * command's Telegram message. The panel streams in the host's own container, so only its
 * terminal method's result is output, read from that method's arguments and public getters.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInCommand } from "../tui/command-context.ts";
import { OutputCapture } from "../tui/output.ts";
import { OriginTracker, type CommandScope } from "../tui/origin.ts";
import { SecretStore } from "../tui/secrets.ts";

type CaptureTransport = ConstructorParameters<typeof OutputCapture>[0];

/** Mirrors btw-panel.ts: the copy text is readable once the panel is complete. */
class FakeBtwPanel {
  private answer = "";
  private complete = false;
  setAnswer(text: string): void {
    this.answer = text;
  }
  markComplete(): void {
    this.complete = true;
  }
  getCopyText(): string | undefined {
    return this.complete && this.answer.trim() ? this.answer : undefined;
  }
  markError(_message: string): void {}
  markAborted(): void {}
}

/** Mirrors omfg-panel.ts. */
class FakeOmfgPanel {
  markSaved(_path: string): void {}
  markRejected(): void {}
  markAborted(): void {}
  markError(_message: string): void {}
}

/** Mirrors cleanse-panel.ts: `finish` takes a status string. */
class FakeCleansePanel {
  finish(_status: string): void {}
  markError(_message: string): void {}
}

function container() {
  return { children: [] as unknown[], addChild(child: unknown): void { this.children.push(child); } };
}

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
  const mode = { btwContainer: container(), omfgContainer: container(), cleanseContainer: container() };
  capture.attach({ mode, ui: {}, chat: container(), session: undefined });
  const bind = (label: string): CommandScope => {
    const scope = origin.begin({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 }, label, `/${label}`, "");
    output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  };
  /** The command ends by idle: its scope is ended and the output finishes. */
  const endCommand = (scope: CommandScope): void => {
    origin.end(scope, "idle");
    output.finish();
  };
  return { editText, mode, bind, endCommand, output };
}

/** Let the debounced flush (700 ms) and the edit run. */
async function settleOutput(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1500);
}

function lastEdit(editText: ReturnType<typeof vi.fn>): string {
  const calls = editText.mock.calls as unknown as unknown[][];
  return String(calls.at(-1)?.[2] ?? "");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutputCapture live panels", () => {
  it("puts the /btw answer on the command message after the command has ended", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("btw");
    const panel = new FakeBtwPanel();
    runInCommand(scope, () => mode.btwContainer.addChild(panel));
    endCommand(scope);
    await settleOutput();
    expect(lastEdit(editText)).toContain("✓ Done");

    panel.setAnswer("4");
    panel.markComplete();
    await settleOutput();

    const text = lastEdit(editText);
    expect(text).toContain("4");
    expect(text).not.toContain("✓ Done");
  });

  it("puts a /btw error on the command message", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("btw");
    const panel = new FakeBtwPanel();
    runInCommand(scope, () => mode.btwContainer.addChild(panel));
    endCommand(scope);

    panel.markError("model failed");
    await settleOutput();

    expect(lastEdit(editText)).toContain("❌ model failed");
  });

  it("puts a /btw cancellation on the command message", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("btw");
    const panel = new FakeBtwPanel();
    runInCommand(scope, () => mode.btwContainer.addChild(panel));
    endCommand(scope);

    panel.markAborted();
    await settleOutput();

    expect(lastEdit(editText)).toContain("✖ Cancelled");
  });

  it("puts the saved /omfg rule path on the command message", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("omfg");
    const panel = new FakeOmfgPanel();
    runInCommand(scope, () => mode.omfgContainer.addChild(panel));
    endCommand(scope);

    panel.markSaved("/x/rule.md");
    await settleOutput();

    expect(lastEdit(editText)).toContain("Rule saved");
    expect(lastEdit(editText)).toContain("/x/rule.md");
  });

  it("puts the /cleanse status on the command message", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("cleanse");
    const panel = new FakeCleansePanel();
    runInCommand(scope, () => mode.cleanseContainer.addChild(panel));
    endCommand(scope);

    panel.finish("unresolved");
    await settleOutput();

    expect(lastEdit(editText)).toContain("Cleanse unresolved");
  });

  it("delivers a panel result once, even if a second terminal method runs", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("btw");
    const panel = new FakeBtwPanel();
    runInCommand(scope, () => mode.btwContainer.addChild(panel));
    endCommand(scope);

    panel.markError("first");
    panel.markError("second");
    await settleOutput();

    const text = lastEdit(editText);
    expect(text).toContain("❌ first");
    expect(text).not.toContain("second");
  });

  it("does not claim a panel added outside a command's call chain", async () => {
    vi.useFakeTimers();
    const { editText, mode, bind, endCommand } = fixture();
    const scope = bind("btw");
    const panel = new FakeBtwPanel();
    mode.btwContainer.addChild(panel);
    endCommand(scope);

    panel.setAnswer("4");
    panel.markComplete();
    await settleOutput();

    const text = lastEdit(editText);
    expect(text).not.toContain("4");
    expect(text).toContain("✓ Done");
  });
});
