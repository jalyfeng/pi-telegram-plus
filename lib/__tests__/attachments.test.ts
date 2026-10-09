import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    const tmp = await mkdtemp(join(tmpdir(), "pi-tg-attach-foreign-"));
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
    const tmp = await mkdtemp(join(tmpdir(), "pi-tg-attach-symlink-"));
    tempDirs.push(tmp);

    const calls: string[] = [];
    let toolDef!: { execute: (toolCallId: string, params: { paths: string[] }) => Promise<unknown> };
    registerTelegramAttachmentTool({ registerTool: (tool: any) => { toolDef = tool; } } as any, {
      getActiveTurn: () => ({ chatId: 123, queuedAttachments: [] }),
      transport: createTransportStub(calls),
    });

    const fakeHome = join(tmp, "fake-home");
    const fakeSsh = join(fakeHome, ".ssh");
    await mkdir(fakeSsh, { recursive: true });
    const sensitiveFile = join(fakeSsh, "id_rsa");
    await writeFile(sensitiveFile, "secret", "utf8");

    let linkPath: string;
    const originalUserProfile = process.env.USERPROFILE;
    const originalHome = process.env.HOME;

    try {
      process.env.USERPROFILE = fakeHome;
      process.env.HOME = fakeHome;

      if (process.platform === "win32") {
        // Directory junctions do not require elevated privileges on Windows.
        const junctionDir = join(tmp, "safe-looking-dir");
        await symlink(fakeSsh, junctionDir, "junction");
        linkPath = join(junctionDir, "id_rsa");
      } else {
        linkPath = join(tmp, "safe-looking.txt");
        await symlink(sensitiveFile, linkPath);
      }

      await expect(toolDef.execute("call", { paths: [linkPath] })).rejects.toThrow(/sensitive/);
      expect(calls).toEqual([]);
    } finally {
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it("uses path boundaries for sensitive prefixes", () => {
    const testHome = resolve("test-fixtures", "home-alice");
    const testHomeSsh = resolve(testHome, ".ssh");
    const testHomeSshKey = resolve(testHomeSsh, "id_rsa");
    const testHomeSshSibling = resolve(testHome, ".ssh2", "id_rsa");
    const testHomeSshBackup = resolve(testHome, ".ssh-backup", "id_rsa");
    const testAllowed = resolve(testHome, "documents", "notes.txt");

    // Sensitive directory itself and files below it are blocked
    expect(isSensitiveAttachmentRealPath(testHomeSsh, testHome)).toBe(true);
    expect(isSensitiveAttachmentRealPath(testHomeSshKey, testHome)).toBe(true);

    // Sibling prefixes are not falsely blocked
    expect(isSensitiveAttachmentRealPath(testHomeSshSibling, testHome)).toBe(false);
    expect(isSensitiveAttachmentRealPath(testHomeSshBackup, testHome)).toBe(false);

    // Regular allowed paths are not blocked
    expect(isSensitiveAttachmentRealPath(testAllowed, testHome)).toBe(false);

    // Unix system paths boundary checks
    expect(isSensitiveAttachmentRealPath("/etc/passwd", testHome)).toBe(true);
    expect(isSensitiveAttachmentRealPath("/etc", testHome)).toBe(true);
    expect(isSensitiveAttachmentRealPath("/etc2/passwd", testHome)).toBe(false);

    // Home discovery when HOME environment variable is absent
    const originalHome = process.env.HOME;
    try {
      delete process.env.HOME;
      expect(isSensitiveAttachmentRealPath(resolve(homedir(), ".ssh", "id_rsa"))).toBe(true);
      expect(isSensitiveAttachmentRealPath(resolve(homedir(), ".ssh-backup", "id_rsa"))).toBe(false);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
    }
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
