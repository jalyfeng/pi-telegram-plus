import { TelegramSendSuppressedError } from "./telegram-api.ts";
import type { TelegramSentMessage, TelegramTransport } from "./types.ts";

export function createActiveTelegramTransport(
    transport: TelegramTransport,
    deps: {
        isActive: () => boolean;
        getLease?: () => unknown;
        waitUntilReady?: () => Promise<void>;
    },
): TelegramTransport {
    let tail: Promise<void> = Promise.resolve();

    const run = <T>(fallback: T, operation: () => Promise<T>): Promise<T> => {
        const lease = deps.getLease?.();
        const result = tail.then(async () => {
            await deps.waitUntilReady?.();
            if (!deps.isActive() || (deps.getLease && lease !== deps.getLease())) return fallback;
            try {
                return await operation();
            } catch (error) {
                if (error instanceof TelegramSendSuppressedError) return fallback;
                throw error;
            }
        });
        tail = result.then(() => undefined, () => undefined);
        return result;
    };

    return {
        removeInlineKeyboard: (chatId, messageId) => run<void>(undefined, () => transport.removeInlineKeyboard(chatId, messageId)),
        sendText: (chatId, text, messageThreadId, replyToMessageId, richMarkdown, delivery) => run<TelegramSentMessage[]>([], () => (
            delivery
                ? transport.sendText(chatId, text, messageThreadId, replyToMessageId, richMarkdown, delivery)
                : transport.sendText(chatId, text, messageThreadId, replyToMessageId, richMarkdown)
        )),
        sendButtons: (chatId, text, rows, messageThreadId, replyToMessageId) => run<TelegramSentMessage>({ message_id: 0 }, () => (
            transport.sendButtons(chatId, text, rows, messageThreadId, replyToMessageId)
        )),
        editText: (chatId, messageId, text, richMarkdown, delivery) => run<void>(undefined, () => (
            delivery
                ? transport.editText(chatId, messageId, text, richMarkdown, delivery)
                : transport.editText(chatId, messageId, text, richMarkdown)
        )),
        editButtons: (chatId, messageId, text, rows) => run<void>(undefined, () => transport.editButtons(chatId, messageId, text, rows)),
        answerCallbackQuery: (callbackQueryId, text) => run<void>(undefined, () => transport.answerCallbackQuery(callbackQueryId, text)),
        deleteMessage: (chatId, messageId) => run<void>(undefined, () => transport.deleteMessage(chatId, messageId)),
        sendDocument: (chatId, path, caption, signal, messageThreadId, replyToMessageId) => run<void>(undefined, () => (
            transport.sendDocument(chatId, path, caption, signal, messageThreadId, replyToMessageId)
        )),
        sendPhoto: (chatId, data, caption, isPath, signal, messageThreadId, replyToMessageId) => run<void>(undefined, () => (
            transport.sendPhoto(chatId, data, caption, isPath, signal, messageThreadId, replyToMessageId)
        )),
        sendChatAction: (chatId, action, messageThreadId) => run<void>(undefined, () => (
            transport.sendChatAction(chatId, action, messageThreadId)
        )),
    };
}
