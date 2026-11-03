import { describe, expect, it, vi } from "vitest";
import { buildTelegramHistoryReplay, replayTelegramHistory, type TelegramHistoryEntry } from "../history-replay.ts";
import type { TelegramTransport } from "../types.ts";

const entries: TelegramHistoryEntry[] = [
    { type: "message", message: { role: "user", content: "hello" } },
    {
        type: "message",
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "considering the request" },
                { type: "toolCall", id: "call-ok", name: "read", arguments: { path: "README.md" } },
                { type: "toolCall", id: "call-fail", name: "bash", arguments: { command: "exit 1" } },
                { type: "text", text: "assistant answer" },
            ],
        },
    },
    {
        type: "message",
        message: {
            role: "toolResult",
            toolCallId: "call-ok",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "successful tool output" }],
        },
    },
    {
        type: "message",
        message: {
            role: "toolResult",
            toolCallId: "call-fail",
            toolName: "bash",
            isError: true,
            content: [
                { type: "text", text: "Command failed" },
                { type: "image", data: "tool-image", mimeType: "image/png" },
            ],
        },
    },
    { type: "compaction" },
];

function textItems(replay: ReturnType<typeof buildTelegramHistoryReplay>): string {
    return replay.items.flatMap((item) => item.type === "text" ? [item.html] : []).join("\n");
}

describe("buildTelegramHistoryReplay", () => {
    it("replays the active branch messages while hiding configured details", () => {
        const replay = buildTelegramHistoryReplay(entries, { tool: "hidden", thinking: "hidden" });
        const text = textItems(replay);

        expect(replay.messageCount).toBe(4);
        expect(text).toContain("👤 User");
        expect(text).toContain("hello");
        expect(text).toContain("🤖 Assistant");
        expect(text).toContain("assistant answer");
        expect(text).not.toContain("considering the request");
        expect(text).not.toContain("successful tool output");
        expect(text).not.toContain("Command failed");
    });

    it("uses brief tool and thinking behavior including failed results only", () => {
        const replay = buildTelegramHistoryReplay(entries, { tool: "brief", thinking: "brief" });
        const text = textItems(replay);

        expect(text).toContain("considering the request");
        expect(text).toContain("README.md");
        expect(text).toContain("exit 1");
        expect(text).toContain("Command failed");
        expect(text).not.toContain("successful tool output");
        expect(replay.items.find((item) => item.type === "photo")).toBeUndefined();
    });

    it("includes complete tool results and images in full mode", () => {
        const replay = buildTelegramHistoryReplay(entries, { tool: "full", thinking: "full" });
        const text = textItems(replay);

        expect(text).toContain("Thinking");
        expect(text).toContain("successful tool output");
        expect(text).toContain("Command failed");
        expect(replay.items).toContainEqual({ type: "photo", data: "tool-image", caption: "bash output" });
    });
});

describe("replayTelegramHistory", () => {
    it("sends a header, all replay items, and a completion marker in order", async () => {
        const sent: string[] = [];
        const transport: TelegramTransport = {
            removeInlineKeyboard: async () => undefined,
            sendText: vi.fn(async (_chatId, text) => {
                sent.push(text);
                return [{ message_id: sent.length }];
            }),
            sendButtons: async () => ({ message_id: 1 }),
            editText: async () => undefined,
            editButtons: async () => undefined,
            answerCallbackQuery: async () => undefined,
            deleteMessage: async () => undefined,
            sendDocument: async () => undefined,
            sendPhoto: async () => undefined,
            sendChatAction: async () => undefined,
        };

        const result = await replayTelegramHistory({
            entries: entries.slice(0, 2),
            config: { tool: "hidden", thinking: "hidden" },
            transport,
            target: { chatId: 42, messageThreadId: 7, sourceMessageId: 100 },
            instance: {
                cwd: "/workspace/project",
                sessionName: "demo",
                model: "provider/model",
                instanceId: "instance-a",
            },
        });

        expect(result).toMatchObject({ messageCount: 2, aborted: false });
        expect(sent[0]).toContain("Switched to project");
        expect(sent[0]).not.toContain("demo");
        expect(sent[1]).toContain("👤 User");
        expect(sent).toContainEqual(expect.stringContaining("🤖 Assistant"));
        expect(sent.at(-1)).toContain("History replay complete");
    });

    it("edits the switch menu message into the result, with no buttons, instead of a new message", async () => {
        const sent: string[] = [];
        const edits: Array<{ messageId: number; text: string }> = [];
        const transport: TelegramTransport = {
            removeInlineKeyboard: async () => undefined,
            sendText: vi.fn(async (_chatId, text) => {
                sent.push(text);
                return [{ message_id: sent.length }];
            }),
            sendButtons: async () => ({ message_id: 1 }),
            editText: vi.fn(async (_chatId, messageId, text) => {
                edits.push({ messageId, text });
            }),
            editButtons: async () => undefined,
            answerCallbackQuery: async () => undefined,
            deleteMessage: async () => undefined,
            sendDocument: async () => undefined,
            sendPhoto: async () => undefined,
            sendChatAction: async () => undefined,
        };

        await replayTelegramHistory({
            entries: entries.slice(0, 2),
            config: { tool: "hidden", thinking: "hidden" },
            transport,
            target: { chatId: 42, messageThreadId: 7, sourceMessageId: 100, menuMessageId: 555 },
            instance: { cwd: "/workspace/project2", sessionName: "demo", model: "mock/mock-model", instanceId: "instance-b" },
        });

        expect(edits).toHaveLength(1);
        expect(edits[0].messageId).toBe(555);
        expect(edits[0].text).toContain("Switched to project2");
        expect(edits[0].text).toContain("cwd:");
        expect(edits[0].text).toContain("<b>model:</b> mock/mock-model");
        // The result is not sent a second time; only the replayed items and the completion marker are new messages.
        expect(sent.some((text) => text.includes("Switched to"))).toBe(false);
        expect(sent.at(-1)).toContain("History replay complete");
    });

    it("sends the switch result as a message of its own when there is no menu message", async () => {
        const sent: string[] = [];
        const transport: TelegramTransport = {
            removeInlineKeyboard: async () => undefined,
            sendText: vi.fn(async (_chatId, text) => {
                sent.push(text);
                return [{ message_id: sent.length }];
            }),
            sendButtons: async () => ({ message_id: 1 }),
            editText: vi.fn(async () => undefined),
            editButtons: async () => undefined,
            answerCallbackQuery: async () => undefined,
            deleteMessage: async () => undefined,
            sendDocument: async () => undefined,
            sendPhoto: async () => undefined,
            sendChatAction: async () => undefined,
        };

        await replayTelegramHistory({
            entries: entries.slice(0, 2),
            config: { tool: "hidden", thinking: "hidden" },
            transport,
            target: { chatId: 42 },
            instance: { cwd: "/workspace/project", instanceId: "instance-b" },
        });

        expect(sent[0]).toContain("Switched to project");
        expect(transport.editText).not.toHaveBeenCalled();
    });

    it("carries a Rich Message payload for replayed assistant tables", () => {
        const table = "| Project | Status |\n| --- | --- |\n| dsh-im | Installed |";
        const replay = buildTelegramHistoryReplay([
            { type: "message", message: { role: "assistant", content: [{ type: "text", text: table }] } },
        ], { tool: "hidden", thinking: "hidden" });

        const item = replay.items[0];
        expect(item).toMatchObject({ type: "text" });
        if (item.type !== "text") throw new Error("expected a text item");
        expect(item.richMarkdown).toBe(`**🤖 Assistant**\n\n${table}`);
        // The HTML rendering stays the fallback for the same item.
        expect(item.html).toContain("Project");
    });
});

describe("history replay tool-call lines", () => {
    it("keeps one readable line per replayed tool call in brief mode", () => {
        const replay = buildTelegramHistoryReplay(entries, { tool: "brief", thinking: "hidden" });
        const text = textItems(replay);

        expect(text).toContain("🔧 read: README.md");
        expect(text).toContain("🔧 bash: exit 1");
        expect(text).not.toContain('"path"');
        expect(text).not.toContain('"command"');
    });
});
