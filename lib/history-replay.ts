import { basename } from "node:path";
import { escapeHtml } from "./html.ts";
import { markdownToTelegramHtml } from "./markdown.ts";
import { richMarkdownForTables } from "./rich-message.ts";
import {
    contentImages,
    contentToRenderParts,
    extractToolResultParts,
    formatToolFailureBrief,
} from "./renderer.ts";
import type { TelegramConfig, TelegramRenderLevel, TelegramTransport } from "./types.ts";
import { RENDER_LEVELS } from "./types.ts";

export type TelegramHistoryEntry = {
    type?: string;
    message?: {
        role?: string;
        content?: unknown;
        errorMessage?: string;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
    };
};

export type TelegramHistoryReplayItem =
    | { type: "text"; html: string; richMarkdown?: string }
    | { type: "photo"; data: string; caption: string };

export type TelegramHistoryReplay = {
    items: TelegramHistoryReplayItem[];
    messageCount: number;
};

export type TelegramHistoryReplayTarget = {
    chatId: number;
    messageThreadId?: number;
    sourceMessageId?: number;
    /** The /tg menu message that the switch was picked on: it becomes the switch result. */
    menuMessageId?: number;
};

export type TelegramHistoryInstanceInfo = {
    cwd: string;
    sessionId?: string;
    sessionName?: string;
    model?: string;
    instanceId: string;
};

function renderLevel(config: TelegramConfig, key: "tool" | "thinking"): TelegramRenderLevel {
    const value = config[key];
    return (RENDER_LEVELS as readonly string[]).includes(value ?? "") ? value! : "brief";
}

function textContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const value = part as Record<string, unknown>;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).filter(Boolean).join("\n\n");
}

function pushPhotos(
    items: TelegramHistoryReplayItem[],
    content: unknown,
    caption: string,
): void {
    for (const image of contentImages(content)) {
        items.push({ type: "photo", data: image.data, caption });
    }
}

export function buildTelegramHistoryReplay(
    entries: TelegramHistoryEntry[],
    config: TelegramConfig,
): TelegramHistoryReplay {
    const items: TelegramHistoryReplayItem[] = [];
    const toolArguments = new Map<string, unknown>();
    const thinkingLevel = renderLevel(config, "thinking");
    const toolLevel = renderLevel(config, "tool");
    let messageCount = 0;

    for (const entry of entries) {
        if (entry.type !== "message" || !entry.message) continue;
        const message = entry.message;
        if (message.role === "user") {
            messageCount++;
            const body = textContent(message.content);
            if (body.trim()) {
                items.push({
                    type: "text",
                    html: `<b>👤 User</b>\n${markdownToTelegramHtml(body)}`,
                });
            }
            pushPhotos(items, message.content, "User image");
            continue;
        }

        if (message.role === "assistant") {
            messageCount++;
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (!part || typeof part !== "object") continue;
                    const value = part as Record<string, unknown>;
                    if (value.type === "toolCall" && typeof value.id === "string") {
                        toolArguments.set(value.id, value.arguments);
                    }
                }
            }
            const rendered = contentToRenderParts(message.content, thinkingLevel, toolLevel);
            for (const event of rendered.inlineEvents) {
                items.push({ type: "text", html: `<blockquote>${escapeHtml(event)}</blockquote>` });
            }
            const body = rendered.body || message.errorMessage || "";
            if (body.trim()) {
                // Replayed assistant answers keep the same table treatment as a
                // live turn: a real GFM table goes out as a Rich Message so the
                // switch-session replay shows a native table too.
                const richTable = richMarkdownForTables(body);
                items.push({
                    type: "text",
                    html: `<b>🤖 Assistant</b>\n${markdownToTelegramHtml(body)}`,
                    ...(richTable ? { richMarkdown: `**🤖 Assistant**\n\n${richTable}` } : {}),
                });
            }
            pushPhotos(items, message.content, "Assistant image");
            continue;
        }

        if (message.role !== "toolResult") continue;
        messageCount++;
        if (toolLevel === "hidden") continue;
        const toolName = message.toolName || "tool";
        if (toolLevel === "brief") {
            if (!message.isError) continue;
            const summary = formatToolFailureBrief(
                toolName,
                { content: message.content },
                message.toolCallId ? toolArguments.get(message.toolCallId) : undefined,
            );
            items.push({ type: "text", html: `<blockquote>${escapeHtml(summary)}</blockquote>` });
            continue;
        }

        const result = extractToolResultParts({ content: message.content });
        const header = `${message.isError ? "❌" : "✅"} <b>${escapeHtml(toolName)}</b>`;
        if (result.body.trim()) {
            const rendered = markdownToTelegramHtml(result.body);
            const expandable = rendered.length > 600 || rendered.split("\n").length > 8;
            const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
            items.push({ type: "text", html: `${tag}${header}\n${rendered}</blockquote>` });
        } else {
            items.push({ type: "text", html: `<blockquote>${header}</blockquote>` });
        }
        for (const image of result.images) {
            items.push({ type: "photo", data: image.data, caption: `${toolName} output` });
        }
    }

    return { items, messageCount };
}

export async function replayTelegramHistory(options: {
    entries: TelegramHistoryEntry[];
    config: TelegramConfig;
    transport: TelegramTransport;
    target: TelegramHistoryReplayTarget;
    instance: TelegramHistoryInstanceInfo;
    canContinue?: () => boolean;
}): Promise<{ messageCount: number; itemCount: number; aborted: boolean }> {
    const replay = buildTelegramHistoryReplay(options.entries, options.config);
    const instanceLabel = basename(options.instance.cwd) || options.instance.cwd;
    const details = [
        `🔀 <b>Switched to ${escapeHtml(instanceLabel)}</b>`,
        `<b>cwd:</b> <code>${escapeHtml(options.instance.cwd)}</code>`,
        options.instance.model ? `<b>model:</b> ${escapeHtml(options.instance.model)}` : "",
        `<b>history:</b> ${replay.messageCount} messages`,
    ].filter(Boolean).join("\n");

    if (options.canContinue && !options.canContinue()) {
        return { messageCount: replay.messageCount, itemCount: 0, aborted: true };
    }
    // One result for the switch: edit the menu message when the switch came from it
    // (an edit without a reply_markup also removes its buttons), else a message of its own.
    if (options.target.menuMessageId !== undefined) {
        await options.transport.editText(options.target.chatId, options.target.menuMessageId, details);
    } else {
        await options.transport.sendText(
            options.target.chatId,
            details,
            options.target.messageThreadId,
            options.target.sourceMessageId,
        );
    }

    let itemCount = 0;
    for (const item of replay.items) {
        if (options.canContinue && !options.canContinue()) {
            return { messageCount: replay.messageCount, itemCount, aborted: true };
        }
        if (item.type === "text") {
            await options.transport.sendText(
                options.target.chatId,
                item.html,
                options.target.messageThreadId,
                undefined,
                item.richMarkdown,
            );
        } else {
            await options.transport.sendChatAction(options.target.chatId, "upload_photo", options.target.messageThreadId);
            await options.transport.sendPhoto(
                options.target.chatId,
                item.data,
                item.caption,
                false,
                undefined,
                options.target.messageThreadId,
            );
        }
        itemCount++;
    }

    if (options.canContinue && !options.canContinue()) {
        return { messageCount: replay.messageCount, itemCount, aborted: true };
    }
    await options.transport.sendText(
        options.target.chatId,
        `✅ <b>History replay complete.</b>\nNew Telegram messages now route to this instance.`,
        options.target.messageThreadId,
    );
    if (options.canContinue && !options.canContinue()) {
        return { messageCount: replay.messageCount, itemCount, aborted: true };
    }
    return { messageCount: replay.messageCount, itemCount, aborted: false };
}
