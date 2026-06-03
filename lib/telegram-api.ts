import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TelegramButton, TelegramConfig, TelegramSentMessage, TelegramTransport, TelegramUpdate } from "./types.ts";
import { stripHtml, splitTelegramText } from "./text-split.ts";

type TelegramFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path: string;
};

type TelegramApiError = {
  ok: boolean;
  result?: unknown;
  description?: string;
};

const TELEGRAM_CALLBACK_LIMIT = 64;

function inferMimeTypeFromPath(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return undefined;
  }
}

export async function telegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await response.json()) as TelegramApiError & { result: T };
  if (!json.ok) throw new Error(json.description ?? `${method} failed`);
  return json.result;
}

export async function getTelegramFile(token: string, fileId: string, signal?: AbortSignal): Promise<TelegramFileInfo> {
  return telegramApi<TelegramFileInfo>(
    token,
    "getFile",
    { file_id: fileId },
    signal,
  );
}

export async function downloadTelegramFile(token: string, filePath: string, signal?: AbortSignal): Promise<Buffer> {
  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${encodedPath}`, {
    method: "GET",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTelegramTransport(getConfig: () => TelegramConfig): TelegramTransport {
  const cfg = () => getConfig();

  /** Call a Telegram API method with retry on transient failures. */
  const callApi = async <T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const token = requireToken();
    const maxRetries = cfg().retryCount ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await telegramApi<T>(token, method, body, signal);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || signal?.aborted) throw error;
        // Exponential backoff: 500ms, 1s, 2s
        await sleep(250 * Math.pow(2, attempt));
      }
    }
    throw lastError;
  };

  /** Non-retrying API call (for idempotent fire-and-forget or catch-suppressed helpers). */
  const callApiOnce = async <T>(method: string, body: Record<string, unknown>) => {
    return telegramApi<T>(requireToken(), method, body);
  };
  const buildInlineKeyboard = (rows: TelegramButton[][]) => ({
    inline_keyboard: rows.map((row: TelegramButton[]) =>
      row.map((button) => {
        if (Buffer.byteLength(button.value, "utf8") > TELEGRAM_CALLBACK_LIMIT) {
          throw new Error(`Telegram callback_data exceeds ${TELEGRAM_CALLBACK_LIMIT} bytes: ${button.text}`);
        }
        return {
          text: button.text,
          callback_data: button.value,
        };
      }),
    ),
  });

  const requireToken = () => {
    const token = getConfig().botToken;
    if (!token) throw new Error("Telegram bot token is not configured");
    return token;
  };

  return {
    async sendText(chatId, text) {
      const sent: TelegramSentMessage[] = [];
      for (const chunk of splitTelegramText(text)) {
        const body = {
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
        };
        const msg = await callApi<TelegramSentMessage>("sendMessage", body)
          .catch(() => callApi<TelegramSentMessage>("sendMessage", {
            chat_id: chatId,
            text: stripHtml(chunk),
          }));
        sent.push(msg);
      }
      return sent;
    },

    async sendButtons(chatId, text, rows) {
      // Button messages cannot be split without duplicating keyboards, so keep
      // title text short. The UI layer already truncates button labels.
      const reply_markup = buildInlineKeyboard(rows);
      const first = splitTelegramText(text)[0];
      return await callApi<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: first,
        parse_mode: "HTML",
        reply_markup,
      }).catch(() => callApi<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: stripHtml(first),
        reply_markup,
      }));
    },

    async editText(chatId, messageId, text) {
      const first = splitTelegramText(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
      }).catch(() => callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: stripHtml(first),
      }).catch(() => undefined));
    },

    async editButtons(chatId, messageId, text, rows) {
      const reply_markup = buildInlineKeyboard(rows);
      const first = splitTelegramText(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
        reply_markup,
      }).catch(() => callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: stripHtml(first),
        reply_markup,
      }).catch(() => undefined));
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    },

    async removeInlineKeyboard(chatId, messageId) {
      await callApi("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    },

    async deleteMessage(chatId, messageId) {
      await callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => undefined);
    },

    async sendDocument(chatId, path, caption, signal) {
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      const data = await readFile(path);
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const form = new FormData();
          form.set("chat_id", String(chatId));
          if (caption) form.set("caption", caption);
          const documentBlob = new Blob([data], {
            type: inferMimeTypeFromPath(path) ?? "application/octet-stream",
          });
          form.set("document", documentBlob, basename(path));
          const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
            method: "POST",
            body: form,
            signal,
          });
          const json = await response.json() as { ok: boolean; description?: string };
          if (!json.ok) throw new Error(json.description ?? "sendDocument failed");
          return;
        } catch (error) {
          lastError = error;
          if (attempt >= maxRetries || signal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendPhoto(chatId, data, caption, isPath = false, signal) {
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const form = new FormData();
          form.set("chat_id", String(chatId));
          if (caption) form.set("caption", caption);
          if (isPath) {
            const bytes = await readFile(data);
            form.set("photo", new Blob([bytes], {
              type: inferMimeTypeFromPath(data) ?? "image/jpeg",
            }), basename(data));
          } else {
            const match = data.match(/^data:([^;]+);base64,(.*)$/);
            const base64 = match ? match[2] : data;
            const mime = match?.[1] ?? "image/png";
            const bytes = Buffer.from(base64, "base64");
            form.set("photo", new Blob([bytes], { type: mime }), `image.${mime.split("/")[1] ?? "png"}`);
          }
          const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: "POST",
            body: form,
            signal,
          });
          const json = await response.json() as { ok: boolean; description?: string };
          if (!json.ok) throw new Error(json.description ?? "sendPhoto failed");
          return;
        } catch (error) {
          lastError = error;
          if (attempt >= maxRetries || signal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendChatAction(chatId, action) {
      await telegramApi(requireToken(), "sendChatAction", {
        chat_id: chatId,
        action,
      }).catch(() => undefined);
    },
  };
}

export async function getTelegramBotUsername(token: string): Promise<string | undefined> {
  const result = await telegramApi<{ username?: string }>(token, "getMe", {});
  return result.username;
}

export async function setTelegramMyCommands(token: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  await telegramApi(token, "setMyCommands", {
    commands,
  });
}

export async function getTelegramUpdates(
  config: TelegramConfig,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  if (!config.botToken) return [];
  return telegramApi<TelegramUpdate[]>(
    config.botToken,
    "getUpdates",
    {
      offset: config.lastUpdateId === undefined ? undefined : config.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    },
    signal,
  );
}
