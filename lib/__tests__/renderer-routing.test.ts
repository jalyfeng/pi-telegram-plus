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
    ["todo", { i: "Planning", op: "init", list: [{ phase: "A", items: ["one", "two"] }] }, "🔧 todo: init (1 phase, 2 items)"],
    ["todo", { i: "Planning", op: "init", list: [{ phase: "A", items: ["one"] }] }, "🔧 todo: init (1 phase, 1 item)"],
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

  it("full mode update edits the start message with the partial text, not the JSON envelope", async () => {
    const { emit, sent } = createRendererHarness({ tool: "full" });

    await runWithTelegramTurn(turn, async () => {
      await emit("tool_execution_start", { toolCallId: "call-3", toolName: "bash", args: { command: "tick" } });
      await emit("tool_execution_update", {
        toolCallId: "call-3",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "tick 1" }], details: {} },
      });
    });

    // The harness records edits in `sent` too: the start message, then the progress edit.
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("🔧 bash: tick");
    expect(sent[1].text).toContain("🔧 bash: tick\n<blockquote>🔄 tick 1</blockquote>");
    expect(sent[1].text).not.toContain('"content"');
  });
});

describe("full tool mode: one message per tool call (P2-2, P2-3)", () => {
  function createFullModeHarness(options: { failStart?: boolean; sendDelayMs?: number } = {}) {
    const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
    const sent: Array<{ chatId: number; text: string; messageId: number }> = [];
    const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
    let nextMessageId = 500;
    let startFailed = false;
    const transport: TelegramTransport = {
      removeInlineKeyboard: async () => undefined,
      sendText: async (chatId, text) => {
        if (options.failStart && !startFailed) {
          startFailed = true;
          throw new Error("send failed");
        }
        if (options.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
        const messageId = ++nextMessageId;
        sent.push({ chatId, text, messageId });
        return [{ message_id: messageId }];
      },
      sendButtons: async () => ({ message_id: 1 }),
      editText: async (chatId, messageId, text) => {
        edits.push({ chatId, messageId, text });
      },
      editButtons: async () => undefined,
      answerCallbackQuery: async () => undefined,
      deleteMessage: async () => undefined,
      sendDocument: async () => undefined,
      sendPhoto: async () => undefined,
      sendChatAction: async () => undefined,
    };
    const pi = {
      on: (event: string, handler: (event: any) => Promise<void>) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    };
    registerTelegramRenderer(pi as any, {
      getConfig: () => ({ botToken: "token", activeChatId: 111, tool: "full", thinking: "brief" }),
      transport,
      getActiveTurn: () => getCurrentTelegramTurn(),
      hasActiveTurns: () => true,
    });
    // The host does not await extension handlers: `dispatch` returns without waiting for them.
    const dispatch = (event: string, payload: any) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
    const emit = async (event: string, payload: any) => {
      await dispatch(event, payload);
    };
    return { emit, dispatch, sent, edits };
  }

  const turn = (): TelegramTurn => ({ chatId: 111, queuedAttachments: [] });

  it("edits the start message with progress and then the result, instead of sending more messages", async () => {
    const { emit, sent, edits } = createFullModeHarness();

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "bash-1", toolName: "bash", args: { command: "echo hi; ls" } });
      await emit("tool_execution_update", {
        toolCallId: "bash-1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "hi" }], details: {} },
      });
      await emit("tool_execution_end", {
        toolCallId: "bash-1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "hi\nnotes.md\nout.txt" }] },
      });
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("🔧 bash: echo hi; ls");
    expect(edits).toHaveLength(2);
    expect(edits.every((edit) => edit.messageId === sent[0].messageId && edit.chatId === 111)).toBe(true);
    expect(edits[0].text).toContain("🔧 bash: echo hi; ls");
    expect(edits[0].text).toContain("<blockquote>🔄 hi</blockquote>");
    expect(edits[1].text).toContain("🔧 bash: echo hi; ls");
    expect(edits[1].text).toContain("notes.md");
    expect(edits[1].text).not.toContain("🔄");
  });

  it("puts the edit diff under the result in a diff code block, truncated past 3000 characters", async () => {
    const { emit, edits } = createFullModeHarness();
    const diff = `-beta\n+gamma\n${"x".repeat(3500)}`;

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit", args: { path: "notes.md" } });
      await emit("tool_execution_end", {
        toolCallId: "edit-1",
        toolName: "edit",
        isError: false,
        result: {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.md." }],
          details: { diff },
        },
      });
    });

    const final = edits.at(-1)!.text;
    expect(final).toContain("Successfully replaced 1 block(s) in notes.md.");
    expect(final).toContain("<pre><code class=\"language-diff\">");
    expect(final).toContain("-beta");
    expect(final).toContain("+gamma");
    expect(final).toContain("(diff truncated)");
    expect(final).not.toContain("x".repeat(3500));
  });

  it("does not add a diff for non-edit tools or when the host gives no diff", async () => {
    const { emit, edits } = createFullModeHarness();

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "w-1", toolName: "write", args: { path: "a.txt" } });
      await emit("tool_execution_end", {
        toolCallId: "w-1",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "wrote" }], details: { diff: "+x" } },
      });
    });

    expect(edits.at(-1)!.text).not.toContain("diff");
  });

  it("edits the start message when the call ends before its start message is sent", async () => {
    const { emit, dispatch, sent, edits } = createFullModeHarness({ sendDelayMs: 20 });

    await runWithTelegramTurn(turn(), async () => {
      // A fast write: the host emits its end while the start message is still being sent.
      const starting = dispatch("tool_execution_start", { toolCallId: "write-1", toolName: "write", args: { path: "two.md", content: "one\n" } });
      await emit("tool_execution_end", {
        toolCallId: "write-1",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "Successfully wrote 4 bytes to two.md" }], details: {} },
      });
      await starting;
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("🔧 write: two.md");
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe(sent[0].messageId);
    expect(edits[0].text).toContain("Successfully wrote 4 bytes to two.md");
  });

  it("drops the hashline header from a write result, shown with the call", async () => {
    const { emit, edits } = createFullModeHarness();

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "write-2", toolName: "write", args: { path: "two.md", content: "one\n" } });
      await emit("tool_execution_end", {
        toolCallId: "write-2",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "[two.md#B686]\nSuccessfully wrote 4 bytes to two.md" }], details: {} },
      });
    });

    const final = edits.at(-1)!.text;
    expect(final).toContain("Successfully wrote 4 bytes to two.md");
    expect(final).not.toContain("[two.md#B686]");
  });

  it("keeps a bracketed line that is not an OMP hashline header in a bash result", async () => {
    const { emit, edits } = createFullModeHarness();

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "bash-h", toolName: "bash", args: { command: "cat x" } });
      await emit("tool_execution_end", {
        toolCallId: "bash-h",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "[two.md#B686]" }] },
      });
    });

    expect(edits.at(-1)!.text).toContain("[two.md#B686]");
  });

  it("renders the edit diff as its own code block even when the result text leaves a fence open", async () => {
    const { emit, edits } = createFullModeHarness();
    // An unclosed fence in the result text must not swallow or re-wrap the diff.
    const diff = "-1|a | b\n+1|a | c\n 2|`";

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "edit-f", toolName: "edit", args: { path: "notes.md" } });
      await emit("tool_execution_end", {
        toolCallId: "edit-f",
        toolName: "edit",
        isError: false,
        result: { content: [{ type: "text", text: "Updated notes.md\n```" }], details: { diff } },
      });
    });

    const final = edits.at(-1)!.text;
    expect(final).toContain("<pre><code class=\"language-diff\">-1|a | b\n+1|a | c\n 2|`\n</code></pre>");
    expect(final).not.toContain("```");
    expect(final).not.toMatch(/^`$/m);
  });

  it("sends the result as a new message when the start message could not be sent", async () => {
    const { emit, sent, edits } = createFullModeHarness({ failStart: true });

    await runWithTelegramTurn(turn(), async () => {
      await emit("tool_execution_start", { toolCallId: "bash-2", toolName: "bash", args: { command: "ls" } }).catch(() => undefined);
      await emit("tool_execution_end", {
        toolCallId: "bash-2",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "notes.md" }] },
      });
    });

    expect(edits).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("notes.md");
  });
});
