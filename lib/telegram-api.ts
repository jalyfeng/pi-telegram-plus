import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TelegramButton, TelegramConfig, TelegramSentMessage, TelegramTransport, TelegramUpdate } from "./types.ts";
import { stripHtml, splitTelegramHtml } from "./text-split.ts";
import { log } from "./logger.ts";

const apiLog = log.child("telegram-api");

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
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new Error(`Telegram API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/file/bot${token}/${encodedPath}`, {
      method: "GET",
      signal,
    });
  } catch (error) {
    throw new Error(`Telegram file download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

  const messageTargetFields = (messageThreadId?: number, replyToMessageId?: number): Record<string, unknown> => ({
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
    ...(replyToMessageId !== undefined ? { reply_parameters: { message_id: replyToMessageId } } : {}),
  });

  /** True when an error represents a network-level failure (fetch rejected,
   *  DNS, connection refused/timeout, …). When the bot is unreachable the
   *  plain-text fallback retry will fail identically, so callers should skip
   *  it and let existing `.catch(swallow(...))` / status-line reporting
   *  surface the outage instead of pointlessly retrying (and logging). */
  const isNetworkError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    // telegramApi wraps raw fetch failures as "Telegram API request failed: <cause>".
    if (msg.startsWith("Telegram API request failed")) return true;
    // sendDocument/sendPhoto wrap as "Telegram sendX failed: <cause>"; direct
    // Node fetch errors also surface with these signatures.
    return /\bfetch failed\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network(?:\s|_)?error/i.test(msg);
  };

  /** Log why an HTML-format send failed before falling back to plain text.
   *  Without this the renderer's failures were completely silent — a single
   *  unsupported tag nuked the whole message's formatting and nobody noticed.
   *
   *  Network-level failures are intentionally NOT logged here: the polling
   *  loop already reports them via the status line / ui.notify, and logging
   *  every failed send when the bot is simply offline would only noise up the
   *  log file. */
  const warnHtmlFallback = (label: string, err: unknown, preview: string) => {
    if (isNetworkError(err)) return;
    const reason = err instanceof Error ? err.message : String(err);
    const snippet = preview.replace(/\s+/g, " ").slice(0, 120);
    apiLog.warn(`HTML ${label} rejected; falling back to plain text`, { reason, snippet });
  };

  return {
    async sendText(chatId, text, messageThreadId, replyToMessageId) {
      const sent: TelegramSentMessage[] = [];
      // Use the semantic HTML splitter so multi-message sends cut at block
      // boundaries (every chunk is independently valid Telegram HTML) instead
      // of the legacy byte splitter that could split mid-<pre>/<blockquote>
      // and force a plain-text fallback.
      for (const chunk of splitTelegramHtml(text)) {
        const body = {
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          ...messageTargetFields(messageThreadId, replyToMessageId),
        };
        const msg = await callApi<TelegramSentMessage>("sendMessage", body)
          .catch((err) => {
            // Network failure: the plain-text retry will fail identically.
            // Propagate so the caller's `.catch` (or renderer suppression)
            // handles it; the polling status line already reports outages.
            if (isNetworkError(err)) throw err;
            warnHtmlFallback("sendMessage", err, chunk);
            return callApi<TelegramSentMessage>("sendMessage", {
              chat_id: chatId,
              text: stripHtml(chunk),
              ...messageTargetFields(messageThreadId, replyToMessageId),
            });
          });
        sent.push(msg);
      }
      return sent;
    },

    async sendButtons(chatId, text, rows, messageThreadId, replyToMessageId) {
      // Button messages cannot be split without duplicating keyboards, so keep
      // title text short. The UI layer already truncates button labels.
      const reply_markup = buildInlineKeyboard(rows);
      const first = splitTelegramHtml(text)[0];
      return await callApi<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: first,
        parse_mode: "HTML",
        reply_markup,
        ...messageTargetFields(messageThreadId, replyToMessageId),
      }).catch((err) => {
        if (isNetworkError(err)) throw err;
        warnHtmlFallback("sendButtons", err, first);
        return callApi<TelegramSentMessage>("sendMessage", {
          chat_id: chatId,
          text: stripHtml(first),
          reply_markup,
          ...messageTargetFields(messageThreadId, replyToMessageId),
        });
      });
    },

    async editText(chatId, messageId, text) {
      const first = splitTelegramHtml(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
      }).catch((err) => {
        if (isNetworkError(err)) return; // swallow; nothing useful to retry
        warnHtmlFallback("editMessageText", err, first);
        return callApi("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: stripHtml(first),
        }).catch(apiLog.swallow("debug", "editMessageText plain-text fallback failed", { chatId, messageId }));
      });
    },

    async editButtons(chatId, messageId, text, rows) {
      const reply_markup = buildInlineKeyboard(rows);
      const first = splitTelegramHtml(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
        reply_markup,
      }).catch((err) => {
        if (isNetworkError(err)) return; // swallow; nothing useful to retry
        warnHtmlFallback("editButtons", err, first);
        return callApi("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: stripHtml(first),
          reply_markup,
        }).catch(apiLog.swallow("debug", "editButtons plain-text fallback failed", { chatId, messageId }));
      });
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
      }).catch(apiLog.swallow("debug", "removeInlineKeyboard failed", { chatId, messageId }));
    },

    async deleteMessage(chatId, messageId) {
      await callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }).catch(apiLog.swallow("warn", "deleteMessage failed", { chatId, messageId }));
    },

    async sendDocument(chatId, path, caption, signal, messageThreadId, replyToMessageId) {
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      const data = await readFile(path);
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const form = new FormData();
          form.set("chat_id", String(chatId));
          if (messageThreadId !== undefined) form.set("message_thread_id", String(messageThreadId));
          if (replyToMessageId !== undefined) form.set("reply_parameters", JSON.stringify({ message_id: replyToMessageId }));
          if (caption) form.set("caption", caption);
          const documentBlob = new Blob([data], {
            type: inferMimeTypeFromPath(path) ?? "application/octet-stream",
          });
          form.set("document", documentBlob, basename(path));
          try {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
              method: "POST",
              body: form,
              signal,
            });
            const json = await response.json() as { ok: boolean; description?: string };
            if (!json.ok) throw new Error(json.description ?? "sendDocument failed");
            return;
          } catch (fetchError) {
            if ((fetchError as any)?.name === "AbortError") throw fetchError;
            throw new Error(`Telegram sendDocument failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
          }
        } catch (error) {
          lastError = error;
          if (attempt >= maxRetries || signal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendPhoto(chatId, data, caption, isPath = false, signal, messageThreadId, replyToMessageId) {
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const form = new FormData();
          form.set("chat_id", String(chatId));
          if (messageThreadId !== undefined) form.set("message_thread_id", String(messageThreadId));
          if (replyToMessageId !== undefined) form.set("reply_parameters", JSON.stringify({ message_id: replyToMessageId }));
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
          try {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
              method: "POST",
              body: form,
              signal,
            });
            const json = await response.json() as { ok: boolean; description?: string };
            if (!json.ok) throw new Error(json.description ?? "sendPhoto failed");
            return;
          } catch (fetchError) {
            if ((fetchError as any)?.name === "AbortError") throw fetchError;
            throw new Error(`Telegram sendPhoto failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
          }
        } catch (error) {
          lastError = error;
          if (attempt >= maxRetries || signal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendChatAction(chatId, action, messageThreadId) {
      await telegramApi(requireToken(), "sendChatAction", {
        chat_id: chatId,
        action,
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      }).catch(apiLog.swallow("debug", "sendChatAction failed", { chatId, action, messageThreadId }));
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
