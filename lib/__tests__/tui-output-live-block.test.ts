/**
 * A host transcript block that updates itself (OMP's `McpConnectingBlock`, a
 * `ChatBlock`: a spinner line in a Text child, replaced by `setStatus` when the
 * work ends). Its spinner frame must never be written into the final content:
 * a running block is left out of the final render, a finished one is read
 * again at that point with the same reader that captured it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OriginTracker } from "../tui/origin.ts";
import { OutputCapture } from "../tui/output.ts";
import { runInCommand } from "../tui/command-context.ts";
import type { SecretStore } from "../tui/secrets.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A pi `Text` stand-in: the string it shows is its `text` field. */
class FakeTextLine {
  constructor(public text: string) {}
}

/** A `Spacer` stand-in: no content fields. */
class FakeSpacer {
  constructor(public n: number) {}
}

/** A `ChatBlock` stand-in: a container with a spinner line, `isTranscriptBlockFinalized` true after `finish`. */
class FakeConnectingBlock {
  readonly children: unknown[];
  readonly #line: FakeTextLine;
  #done = false;

  constructor(frame: string, name: string) {
    this.#line = new FakeTextLine(`${frame} Connecting to "${name}"...`);
    this.children = [new FakeSpacer(1), this.#line];
  }

  isTranscriptBlockFinalized(): boolean {
    return this.#done;
  }

  /** The host's `setStatus` replaces the spinner line, then `finish` freezes the block. */
  finish(status: string): void {
    this.#line.text = status;
    this.#done = true;
  }
}

async function setup() {
  const edits: string[] = [];
  const transport = {
    sendText: async () => [],
    editText: async (_chatId: number, _messageId: number, text: string) => {
      edits.push(text);
    },
    sendDocument: async () => undefined,
  };
  const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
  const output = new OutputCapture(transport, origin, undefined);
  const capture = output as unknown as { attach(state: unknown): void };
  const chat = {
    children: [] as unknown[],
    addChild(child: unknown): void {
      this.children.push(child);
    },
  };
  capture.attach({ mode: {}, ui: {}, chat, session: undefined });
  const scope = origin.begin({ chatId: 42, messageThreadId: 7, sourceMessageId: 99 }, "mcp", "/mcp add", "");
  output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: "<b>▶️ /mcp add</b>" });
  const add = (child: unknown) => runInCommand(scope, () => chat.addChild(child));
  return { output, edits, add };
}

/** The final content: the last text written to the ack message. */
async function finalText(output: OutputCapture, edits: string[]): Promise<string> {
  output.finish();
  await vi.waitFor(() => expect(edits.length).toBeGreaterThan(0));
  return edits[edits.length - 1];
}

describe("OutputCapture with a self-updating transcript block", () => {
  it("writes the finished status only, never the spinner frame", async () => {
    const { output, edits, add } = await setup();
    const block = new FakeConnectingBlock("⣾", "localfs");
    add(block);
    block.finish("+ Connected to \"localfs\"");
    const text = await finalText(output, edits);
    expect(text).toContain("Connected to");
    expect(text).not.toContain("⣾");
    expect(text).not.toContain("Connecting");
  });

  it("leaves a block that has not finished out of the final content", async () => {
    const { output, edits, add } = await setup();
    add(new FakeConnectingBlock("⣾", "localfs"));
    add(new FakeTextLine("+ Added server"));
    const text = await finalText(output, edits);
    expect(text).toContain("Added server");
    expect(text).not.toContain("Connecting");
    expect(text).not.toContain("⣾");
  });
});

/** A host user-message bubble (OMP's UserMessageComponent): the echo of a submitted message. */
class FakeUserBubble {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  /** Defined only by the host's user bubble; the structural mark of the echo. */
  setReaction(_emoji: string): void {}
}

describe("a host user-message echo is not command output (#60)", () => {
  it("leaves the echoed goal text off the command message, keeps the command's own lines", async () => {
    const { output, edits, add } = await setup();
    add(new FakeUserBubble("tiny goal"));
    add(new FakeTextLine("Goal set"));
    const text = await finalText(output, edits);
    expect(text).toContain("Goal set");
    expect(text).not.toContain("tiny goal");
  });
});
