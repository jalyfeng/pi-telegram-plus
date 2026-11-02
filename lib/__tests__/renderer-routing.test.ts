import { describe, expect, it, vi } from "vitest";
import { registerTelegramRenderer } from "../renderer.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "../turn-context.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

function createRendererHarness(options: { tool?: "hidden" | "brief" | "full" } = {}) {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const sent: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number; richMarkdown?: string }> = [];
  const actions: Array<{ chatId: number; action: string; messageThreadId?: number }> = [];
  const photos: Array<{ chatId: number; data: string; messageThreadId?: number; replyToMessageId?: number }> = [];
  const transport: TelegramTransport = {
    removeInlineKeyboard: async () => undefined,
    sendText: async (chatId, text, messageThreadId, replyToMessageId, richMarkdown) => {
      sent.push({ chatId, text, messageThreadId, replyToMessageId, richMarkdown });
      return [{ message_id: sent.length }];
    },
    sendButtons: async () => ({ message_id: 1 }),
    editText: async (chatId, _messageId, text, richMarkdown) => {
      sent.push({ chatId, text, richMarkdown });
    },
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async (chatId, data, _caption, _isPath, _signal, messageThreadId, replyToMessageId) => {
      photos.push({ chatId, data, messageThreadId, replyToMessageId });
    },
    sendChatAction: async (chatId, action, messageThreadId) => {
      actions.push({ chatId, action, messageThreadId });
    },
  };
  const pi = {
    on: (event: string, handler: (event: any) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  registerTelegramRenderer(pi as any, {
    getConfig: () => ({ botToken: "token", activeChatId: 111, tool: options.tool ?? "full", thinking: "brief" }),
    transport,
    getActiveTurn: () => getCurrentTelegramTurn(),
    hasActiveTurns: () => true,
  });

  const emit = async (event: string, payload: any) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };

  return { emit, sent, actions, photos };
}

describe("Telegram renderer turn routing", () => {
  it("routes interleaved assistant messages to their own Telegram chat", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 222, queuedAttachments: [] };

    await Promise.all([
      runWithTelegramTurn(turnA, () => emit("message_end", { message: { role: "assistant", content: "answer for A" } })),
      runWithTelegramTurn(turnB, () => emit("message_end", { message: { role: "assistant", content: "answer for B" } })),
    ]);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, text: expect.stringContaining("answer for A") }),
      expect.objectContaining({ chatId: 222, text: expect.stringContaining("answer for B") }),
    ]));
    expect(sent.find((item) => item.chatId === 111 && item.text.includes("answer for B"))).toBeUndefined();
    expect(sent.find((item) => item.chatId === 222 && item.text.includes("answer for A"))).toBeUndefined();
  });

  it("routes same-chat different-thread assistant messages to their own Telegram topic", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, messageThreadId: 10, sourceMessageId: 1001, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 111, messageThreadId: 20, sourceMessageId: 2001, queuedAttachments: [] };

    await Promise.all([
      runWithTelegramTurn(turnA, () => emit("message_end", { message: { role: "assistant", content: "topic A answer" } })),
      runWithTelegramTurn(turnB, () => emit("message_end", { message: { role: "assistant", content: "topic B answer" } })),
    ]);

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 111, messageThreadId: 10, replyToMessageId: 1001, text: expect.stringContaining("topic A answer") }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20, replyToMessageId: 2001, text: expect.stringContaining("topic B answer") }),
    ]));
    expect(sent.find((item) => item.messageThreadId === 10 && item.text.includes("topic B"))).toBeUndefined();
    expect(sent.find((item) => item.messageThreadId === 20 && item.text.includes("topic A"))).toBeUndefined();
  });

  it("deduplicates inline tool events per chat/thread instead of globally", async () => {
    const { emit, sent } = createRendererHarness();
    const turnA: TelegramTurn = { chatId: 111, messageThreadId: 10, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 111, messageThreadId: 20, queuedAttachments: [] };
    const event = { toolCallId: "call", toolName: "read", args: { path: "README.md" } };

    await runWithTelegramTurn(turnA, () => emit("tool_execution_start", event));
    await runWithTelegramTurn(turnB, () => emit("tool_execution_start", event));

    expect(sent.filter((item) => item.text.includes("read"))).toEqual([
      expect.objectContaining({ chatId: 111, messageThreadId: 10 }),
      expect.objectContaining({ chatId: 111, messageThreadId: 20 }),
    ]);
  });

  it("does not fall back to activeChatId when active turns exist but the event has no turn context", async () => {
    const { emit, sent } = createRendererHarness();

    await emit("message_end", { message: { role: "assistant", content: "ambiguous output" } });

    expect(sent).toHaveLength(0);
  });

  it("routes full tool output images and text to the current turn chat", async () => {
    const { emit, sent, actions, photos } = createRendererHarness();
    const turnB: TelegramTurn = { chatId: 222, messageThreadId: 77, sourceMessageId: 7701, queuedAttachments: [] };

    await runWithTelegramTurn(turnB, () => emit("tool_execution_end", {
      toolCallId: "image-call",
      toolName: "image_tool",
      isError: false,
      result: {
        content: [
          { type: "text", text: "tool text for B" },
          { type: "image", data: "base64-image", mimeType: "image/png" },
        ],
      },
    }));

    expect(sent).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, replyToMessageId: 7701, text: expect.stringContaining("tool text for B") })]);
    expect(actions).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, action: "upload_photo" })]);
    expect(photos).toEqual([expect.objectContaining({ chatId: 222, messageThreadId: 77, replyToMessageId: 7701, data: "base64-image" })]);
  });

  it("renders brief failed tool results as a human summary instead of raw JSON", async () => {
    const { emit, sent } = createRendererHarness({ tool: "brief" });
    const turn: TelegramTurn = { chatId: 222, messageThreadId: 77, sourceMessageId: 7701, queuedAttachments: [] };
    const args = { command: 'for i in $(seq 1 20); do echo "tick $i"; sleep 1; done' };

    await runWithTelegramTurn(turn, async () => {
      await emit("tool_execution_start", { toolCallId: "bash-call", toolName: "bash", args });
      await emit("tool_execution_end", {
        toolCallId: "bash-call",
        toolName: "bash",
        isError: true,
        result: {
          content: [{ type: "text", text: "tick 1\ntick 2\n\nCommand aborted" }],
          details: {},
        },
      });
    });

    const failure = sent.find((item) => item.text.includes("❌ bash"));
    expect(failure?.text).toContain("Command aborted");
    expect(failure?.text).not.toContain('"content"');
  });

  it("sends Markdown tables as a Rich Message and keeps the HTML fallback alongside", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = { chatId: 111, messageThreadId: 10, queuedAttachments: [] };
    const table = "| Project | Status |\n| --- | --- |\n| dsh-im | Installed |";

    await runWithTelegramTurn(turn, () => emit("message_end", { message: { role: "assistant", content: table } }));

    expect(sent).toHaveLength(1);
    expect(sent[0].richMarkdown).toBe(table);
    // The HTML rendering of the same content still travels with the send so the
    // transport can fall back to Telegram's HTML mode when Rich is rejected.
    expect(sent[0].text).toContain("Project");
    expect(sent[0].text).not.toContain("| --- |");
  });

  it("edits the placeholder with the Rich payload for a table answer", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = { chatId: 111, replaceMessageId: 4242, queuedAttachments: [] };
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";

    await runWithTelegramTurn(turn, () => emit("message_end", { message: { role: "assistant", content: table } }));

    expect(sent).toEqual([expect.objectContaining({ chatId: 111, richMarkdown: table })]);
  });

  it("keeps answers without a real table on the plain HTML path", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = { chatId: 111, queuedAttachments: [] };

    await runWithTelegramTurn(turn, () => emit("message_end", {
      message: { role: "assistant", content: "just prose with a | pipe and\nanother | pipe line" },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].richMarkdown).toBeUndefined();
  });
});

describe("Telegram reply target for steered or queued messages", () => {
  it("replies to a steered Telegram message once the host has taken it into the conversation", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = {
      chatId: 111,
      sourceMessageId: 1,
      pendingReplyTargets: [{ text: "second", messageId: 2 }],
      queuedAttachments: [],
    };

    await runWithTelegramTurn(turn, async () => {
      await emit("message_end", { message: { role: "user", content: "second" } });
      await emit("message_end", { message: { role: "assistant", content: "answer to second" } });
    });

    expect(sent).toEqual([expect.objectContaining({ chatId: 111, replyToMessageId: 2, text: expect.stringContaining("answer to second") })]);
  });

  it("matches a host-decorated user message (text inside a system-reminder block) and array content", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = {
      chatId: 111,
      sourceMessageId: 1,
      pendingReplyTargets: [{ text: "second", messageId: 2 }],
      queuedAttachments: [],
    };

    await runWithTelegramTurn(turn, async () => {
      await emit("message_end", {
        message: { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>\nsecond" }] },
      });
      await emit("message_end", { message: { role: "assistant", content: "answer" } });
    });

    expect(sent).toEqual([expect.objectContaining({ replyToMessageId: 2 })]);
  });

  it("keeps replying to the turn's first message when no pending target matches", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = {
      chatId: 111,
      sourceMessageId: 1,
      pendingReplyTargets: [{ text: "second", messageId: 2 }],
      queuedAttachments: [],
    };

    await runWithTelegramTurn(turn, async () => {
      await emit("message_end", { message: { role: "user", content: "something else entirely" } });
      await emit("message_end", { message: { role: "assistant", content: "answer" } });
    });

    expect(sent).toEqual([expect.objectContaining({ replyToMessageId: 1 })]);
    expect(turn.pendingReplyTargets).toEqual([{ text: "second", messageId: 2 }]);
  });

  it("uses the first matching pending target and drops it and the entries before it", async () => {
    const { emit, sent } = createRendererHarness();
    const turn: TelegramTurn = {
      chatId: 111,
      sourceMessageId: 1,
      pendingReplyTargets: [
        { text: "first queued", messageId: 2 },
        { text: "second queued", messageId: 3 },
        { text: "third queued", messageId: 4 },
      ],
      queuedAttachments: [],
    };

    await runWithTelegramTurn(turn, async () => {
      await emit("message_end", { message: { role: "user", content: "second queued" } });
      await emit("message_end", { message: { role: "assistant", content: "answer two" } });
    });

    expect(sent).toEqual([expect.objectContaining({ replyToMessageId: 3, text: expect.stringContaining("answer two") })]);
    expect(turn.pendingReplyTargets).toEqual([{ text: "third queued", messageId: 4 }]);
  });
});

describe("Telegram tool-call lines are readable, one per call", () => {
  const turn: TelegramTurn = { chatId: 111, queuedAttachments: [] };

  async function briefLine(toolName: string, args: unknown): Promise<string | undefined> {
    const { emit, sent } = createRendererHarness({ tool: "brief" });
    await runWithTelegramTurn(turn, () => emit("tool_execution_start", { toolCallId: "call", toolName, args }));
    return sent[0]?.text.replace(/^<blockquote>|<\/blockquote>$/g, "");
  }

  it.each([
    ["read", { i: "Reading notes", path: "src/notes.md" }, "🔧 read: src/notes.md"],
    ["write", { i: "Writing", path: "out/result.txt", content: "{\"a\": 1}" }, "🔧 write: out/result.txt"],
    ["edit", { i: "Editing", input: "[/tmp/p/notes.md#0760]\nPUT >4:\n+- d" }, "🔧 edit: notes.md"],
    ["edit", { i: "Editing", input: "[/tmp/p/a.ts#00AA]\nPUT >1:\n+x\n[/tmp/p/b.ts#00AB]\nPUT >2:\n+y" }, "🔧 edit: a.ts, b.ts"],
    ["edit", { i: "Editing", input: "[a.ts#1]\n[b.ts#2]\n[c.ts#3]\n[d.ts#4]\n[e.ts#5]" }, "🔧 edit: a.ts, b.ts, c.ts (+2 more)"],
    ["edit", { i: "Editing", input: "no header here" }, "🔧 edit: patch"],
    ["bash", { i: "Listing", command: "ls -la\necho done" }, "🔧 bash: ls -la"],
    ["eval", { i: "Computing", language: "js", code: "const x = 1;\nconsole.log(x)", title: "Sum check" }, "🔧 eval: Sum check"],
    ["eval", { i: "Computing", language: "js", code: "const x = 1;\nconsole.log(x)" }, "🔧 eval: js: const x = 1;"],
    ["glob", { i: "Finding", path: "lib/**/*.ts" }, "🔧 glob: lib/**/*.ts"],
    ["grep", { i: "Searching", pattern: "summarizeToolArgs", path: "lib" }, "🔧 grep: \"summarizeToolArgs\" in lib"],
    ["grep", { i: "Searching", pattern: "TODO" }, "🔧 grep: \"TODO\""],
    ["todo", { i: "Planning", op: "init", list: [{ phase: "A", items: ["one", "two"] }, { phase: "B", items: ["three"] }] }, "🔧 todo: init (2 phases, 3 items)"],
    ["todo", { i: "Done", op: "done", task: "write tests" }, "🔧 todo: done: write tests"],
    ["todo", { i: "Adding", op: "append", items: ["x", "y"] }, "🔧 todo: append 2 items"],
    ["wait", {}, "🔧 wait"],
    ["ask", { i: "Asking", questions: [{ question: "Which branch?", options: ["a", "b"] }, { question: "Second?" }] }, "🔧 ask: Which branch? (+1 more)"],
    ["web_search", { i: "Searching web", query: "oh-my-pi hashline" }, "🔧 web_search: oh-my-pi hashline"],
    ["task", { i: "Delegating", context: "shared", tasks: [{ name: "Scan", agent: "task", task: "scan the repo", solutionSpace: "x" }, { agent: "task", task: "second", solutionSpace: "y" }] }, "🔧 task: 2 tasks: Scan"],
    ["task", { i: "Delegating", context: "shared", tasks: [{ agent: "task", task: "Review the diff", solutionSpace: "x" }] }, "🔧 task: 1 task: Review the diff"],
    ["custom_tool", { i: "Custom", target: "thing", count: 3 }, "🔧 custom_tool: thing"],
    ["custom_tool", { i: "Custom", count: 3 }, "🔧 custom_tool"],
  ])("%s %j -> one line", async (toolName, args, expected) => {
    const line = await briefLine(toolName, args);
    expect(line).toBe(expected);
    expect(line).not.toMatch(/[{}"]\s*:|\{ /);
  });

  it("does not echo raw JSON or the intent field for a tool whose args only hold intent", async () => {
    expect(await briefLine("custom_tool", { i: "Only intent" })).toBe("🔧 custom_tool");
  });

  it("does not render assistant toolCall blocks inline on message_end, but still sends the reply", async () => {
    const { emit, sent } = createRendererHarness({ tool: "full" });

    await runWithTelegramTurn(turn, () => emit("message_end", {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
          { type: "text", text: "final words" },
        ],
      },
    }));

    expect(sent.some((item) => item.text.includes("🔧"))).toBe(false);
    expect(sent.some((item) => item.text.includes("final words"))).toBe(true);
  });

  it("full mode start sends the brief line without JSON", async () => {
    const { emit, sent } = createRendererHarness({ tool: "full" });

    await runWithTelegramTurn(turn, () => emit("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "write",
      args: { i: "Writing", path: "out.txt", content: "payload-body" },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("🔧 write: out.txt");
    expect(sent[0].text).not.toContain("payload-body");
    expect(sent[0].text).not.toContain("started");
  });

  it("full mode update is skipped when the partial result has no text", async () => {
    const { emit, sent } = createRendererHarness({ tool: "full" });

    await runWithTelegramTurn(turn, () => emit("tool_execution_update", {
      toolCallId: "call-2",
      toolName: "bash",
      partialResult: { details: { progress: 0.5 } },
    }));

    expect(sent).toHaveLength(0);
  });

  it("full mode update sends the partial text, not the JSON envelope", async () => {
    const { emit, sent } = createRendererHarness({ tool: "full" });

    await runWithTelegramTurn(turn, () => emit("tool_execution_update", {
      toolCallId: "call-3",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "tick 1" }], details: {} },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("🔄 bash\ntick 1");
    expect(sent[0].text).not.toContain('"content"');
  });
});
