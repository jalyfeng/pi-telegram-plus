import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitiveAttachmentRealPath, registerTelegramAttachmentTool, sendQueuedTelegramAttachments } from "../attachments.ts";
import type { TelegramTurn, TelegramTransport } from "../types.ts";

describe("tg attachment tool and queue sender", () => {
  const tempDirs: string[] = [];

  const cleanup = async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const createTransportStub = (calls: string[]): TelegramTransport => ({
    removeInlineKeyboard: async () => undefined,
    sendText: async (chatId, message) => {
      calls.push(`text:${chatId}:${message}`);
      return [{ message_id: 1 }];
    },
    sendButtons: async () => ({ message_id: 1 }),
    editText: async () => undefined,
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => {
      calls.push("document");
      return undefined;
    },
    sendPhoto: async () => {
      calls.push("photo");
      return undefined;
    },
    sendChatAction: async (_chatId, action) => {
      calls.push(action);
    },
  });

  const createTempPng = async () => {
    const tmp = await mkdtemp(join(dirname(process.cwd()), "tmp-pi-tg-attach-"));
    tempDirs.push(tmp);
    const filePath = join(tmp, "image.png");
    // Minimal valid PNG signature bytes.
    await writeFile(filePath, Buffer.from("89504e470d0a1a0a", "hex"));
    return filePath;
  };

  afterEach(async () => {
    await cleanup();
  });

  it("sends attachments immediately when an active Telegram turn exists", async () => {
    const tmp = await mkdtemp("/tmp/pi-tg-attach-foreign-");
    tempDirs.push(tmp);
    const filePath = join(tmp, "outside.txt");
    await writeFile(filePath, "hello");

    const calls: string[] = [];
    let toolDef!: { execute: (toolCallId: string, params: { paths: string[] }) => Promise<{ content: { type: "text"; text: string }[] }> };
    const pi: { registerTool: (tool: any) => void } = {
      registerTool: (tool) => {
        toolDef = tool;
      },
    };

    const turn: TelegramTurn = {
      chatId: 123,
      queuedAttachments: [],
    };

    registerTelegramAttachmentTool(pi as any, {
      getActiveTurn: () => turn,
      transport: createTransportStub(calls),
    });

    const result = await toolDef!.execute("call", { paths: [filePath] });

    expect(result.content[0].text).toMatch(/Sent 1 Telegram attachment\(s\)\./);
    expect(turn.queuedAttachments).toHaveLength(0);
    expect(calls).toContain("upload_document");
    expect(calls).toContain("document");
  });

  it("sends active-turn attachments to the turn's Telegram topic", async () => {
    const tmp = await mkdtemp("/tmp/pi-tg-attach-thread-");
    tempDirs.push(tmp);
    const filePath = join(tmp, "thread.txt");
    await writeFile(filePath, "hello topic");

    const calls: Array<Record<string, unknown>> = [];
    let toolDef!: { execute: (toolCallId: string, params: { paths: string[] }) => Promise<unknown> };
    const transport: TelegramTransport = {
      ...createTransportStub([]),
      sendChatAction: async (chatId, action, messageThreadId) => { calls.push({ kind: "action", chatId, action, messageThreadId }); },
      sendDocument: async (chatId, path, caption, _signal, messageThreadId, replyToMessageId) => { calls.push({ kind: "document", chatId, path, caption, messageThreadId, replyToMessageId }); },
    };
    registerTelegramAttachmentTool({ registerTool: (tool: any) => { toolDef = tool; } } as any, {
      getActiveTurn: () => ({ chatId: 123, messageThreadId: 88, sourceMessageId: 8801, queuedAttachments: [] }),
      transport,
    });

    await toolDef.execute("call", { paths: [filePath] });

    expect(calls).toEqual([
      expect.objectContaining({ kind: "action", chatId: 123, action: "upload_document", messageThreadId: 88 }),
      expect.objectContaining({ kind: "document", chatId: 123, messageThreadId: 88, replyToMessageId: 8801 }),
    ]);
  });

  it("rejects symlinks that resolve into sensitive paths", async () => {
    const tmp = await mkdtemp("/tmp/pi-tg-attach-symlink-");
    tempDirs.push(tmp);
    const linkPath = join(tmp, "safe-looking.txt");
    await symlink("/etc/passwd", linkPath);

    const calls: string[] = [];
    let toolDef!: { execute: (toolCallId: string, params: { paths: string[] }) => Promise<unknown> };
    registerTelegramAttachmentTool({ registerTool: (tool: any) => { toolDef = tool; } } as any, {
      getActiveTurn: () => ({ chatId: 123, queuedAttachments: [] }),
      transport: createTransportStub(calls),
    });

    await expect(toolDef.execute("call", { paths: [linkPath] })).rejects.toThrow(/sensitive/);
    expect(calls).toEqual([]);
  });

  it("uses path boundaries for sensitive prefixes", () => {
    expect(isSensitiveAttachmentRealPath("/etc/passwd", "/home/alice")).toBe(true);
    expect(isSensitiveAttachmentRealPath("/etc", "/home/alice")).toBe(true);
    expect(isSensitiveAttachmentRealPath("/etc2/passwd", "/home/alice")).toBe(false);
    expect(isSensitiveAttachmentRealPath("/home/alice/.ssh/id_rsa", "/home/alice")).toBe(true);
    expect(isSensitiveAttachmentRealPath("/home/alice/.ssh2/id_rsa", "/home/alice")).toBe(false);
  });

  it("sends attachments directly when no active turn but default chat id is configured", async () => {
    const filePath = await createTempPng();
    const calls: string[] = [];
    let toolDef!: { execute: (toolCallId: string, params: { paths: string[] }) => Promise<{ content: { type: "text"; text: string }[] }> };
    const pi: { registerTool: (tool: any) => void } = {
      registerTool: (tool) => {
        toolDef = tool;
      },
    };

    registerTelegramAttachmentTool(pi as any, {
      getActiveTurn: () => undefined,
      getDefaultChatId: () => 777,
      transport: createTransportStub(calls),
    });

    const result = await toolDef!.execute("call", { paths: [filePath] });

    expect(result.content[0].text).toMatch(/Sent 1 Telegram attachment\(s\)\./);
    expect(calls).toContain("upload_photo");
    expect(calls).toContain("photo");
  });

  it("falls back to sendDocument when sendPhoto fails", async () => {
    const filePath = await createTempPng();
    const turn: TelegramTurn = {
      chatId: 123,
      queuedAttachments: [{ path: filePath, fileName: "image.png" }],
    };
    const calls: string[] = [];
    const transport: TelegramTransport = {
      ...createTransportStub(calls),
      sendPhoto: async () => {
        calls.push("photo");
        throw new Error("photo unavailable");
      },
    };

    await sendQueuedTelegramAttachments(turn, transport);

    expect(calls).toContain("upload_photo");
    expect(calls).toContain("photo");
    expect(calls).toEqual(["upload_photo", "photo", "upload_document", "document"]);
  });

  it("still sends document for non-photo attachments", async () => {
    const filePath = await createTempPng().then((path) => path.replace(/\.png$/, ".txt"));
    await writeFile(filePath, "hello");
    const textDir = dirname(filePath);
    tempDirs.push(textDir);

    const turn: TelegramTurn = {
      chatId: 456,
      queuedAttachments: [{ path: filePath, fileName: "notes.txt" }],
    };
    const calls: string[] = [];
    const transport: TelegramTransport = createTransportStub(calls);

    await sendQueuedTelegramAttachments(turn, transport);

    expect(calls).toEqual(["upload_document", "document"]);
  });
});
