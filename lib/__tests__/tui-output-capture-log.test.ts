/**
 * Every claimed component and every push leaves a debug trace, so a blank
 * Telegram ack is traceable to the render that produced it. These tests pin
 * the two properties the trace must keep: it fires at capture time (also when
 * the render produced nothing - the blank-ack signature), and the sample
 * never carries ANSI or a tracked secret.
 *
 * `outputLog` is a module-level `log.child(...)`, so the spy must be in place
 * before `output.ts` is first evaluated: reset the module registry, patch
 * `child` on a fresh logger instance, then import the capture module.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Logger } from "../logger.ts";

const SECRET = "hunter2-passphrase";

function freshCapture() {
  vi.resetModules();
  return import("../logger.ts").then(async ({ log }) => {
    const debug = vi.fn();
    const fake: Logger = {
      level: "debug",
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => fake,
      swallow: () => () => undefined,
    };
    vi.spyOn(log, "child").mockReturnValue(fake);
    const [{ OutputCapture }, { OriginTracker }, { SecretStore }, { runInCommand }] = await Promise.all([
      import("../tui/output.ts"),
      import("../tui/origin.ts"),
      import("../tui/secrets.ts"),
      import("../tui/command-context.ts"),
    ]);
    const transport = {
      sendText: async () => [],
      editText: async () => undefined,
      sendDocument: async () => undefined,
    };
    const secrets = new SecretStore();
    secrets.remember("42:7", "flow-1", SECRET);
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin, secrets);
    // `attach` is private; drive it directly like the export tests do.
    const capture = output as unknown as { attach(state: unknown): void };
    const attach = (state: unknown) => capture.attach(state);
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
    // Host output is claimed only inside the command's call chain (v8 §0.2).
    const addInScope = (scope: unknown, chat: { addChild(child: unknown): void }, child: unknown) => {
      runInCommand(scope as Parameters<typeof runInCommand>[0], () => chat.addChild(child));
    };
    return { debug, attach, bind, addInScope };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Debug records for one message, fields only. */
function records(debug: Mock, msg: string): Record<string, unknown>[] {
  return debug.mock.calls.filter((call) => call[0] === msg).map((call) => call[1] as Record<string, unknown>);
}

class FakeText {
  text: string;
  children?: unknown[];
  constructor(text: string, children?: unknown[]) {
    this.text = text;
    if (children) this.children = children;
  }
}

/** Claims nothing: no markdown/text/content/render fields. */
class FakeSpacer {
  constructor(public n: number) {}
}

function chatFixture() {
  const chat = {
    children: [] as unknown[],
    clear(): void {
      this.children = [];
    },
    addChild(child: unknown): void {
      this.children.push(child);
    },
  };
  return { chat, state: { mode: {}, ui: {}, chat, session: undefined } };
}

describe("OutputCapture debug trace", () => {
  it("logs the claimed component with ctor, line count and children", async () => {
    const { debug, attach, bind, addInScope } = await freshCapture();
    const { chat, state } = chatFixture();
    attach(state);
    const scope = bind("clear");
    addInScope(scope, chat, new FakeText("reset \u001b[31mred\u001b[0m done", [{}, {}]));
    const captured = records(debug, "captured component");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ctor: "FakeText", lines: 1, children: 2 });
    const pushes = records(debug, "output push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({ length: "reset red done".length });
  });

  it("keeps the sample ANSI-free, redacted and 80 chars at most", async () => {
    const { debug, attach, bind, addInScope } = await freshCapture();
    const { chat, state } = chatFixture();
    attach(state);
    const scope = bind("clear");
    addInScope(scope, chat, new FakeText(`x \u001b[31m${SECRET}\u001b[0m ${"y".repeat(200)}`));
    const [captured] = records(debug, "captured component");
    const sample = String(captured?.sample);
    expect(sample).not.toContain(SECRET);
    expect(sample).toContain("***");
    expect(sample).not.toContain("\u001b");
    expect(sample.length).toBeLessThanOrEqual(80);
  });

  it("still logs when the component has no content, and omits a missing children field", async () => {
    const { debug, attach, bind, addInScope } = await freshCapture();
    const { chat, state } = chatFixture();
    attach(state);
    const scope = bind("clear");
    addInScope(scope, chat, new FakeSpacer(1));
    const captured = records(debug, "captured component");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ ctor: "FakeSpacer", lines: 0, sample: "" });
    expect(captured[0]).not.toHaveProperty("children");
    expect(records(debug, "output push")).toHaveLength(0);
  });
});
