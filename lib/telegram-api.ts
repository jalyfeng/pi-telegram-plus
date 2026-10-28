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

type TelegramApiResponse = {
  ok: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
};

export class TelegramApiRequestError extends Error {
  readonly retryAfterMs?: number;
  /** HTTP status of the Telegram answer (400 for a rejected payload, 429 for flood control). */
  readonly status?: number;

  constructor(message: string, retryAfterSeconds?: number, status?: number) {
    super(message);
    this.name = "TelegramApiRequestError";
    this.retryAfterMs = typeof retryAfterSeconds === "number" && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : undefined;
    this.status = status;
  }
}

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

function telegramApiBase(apiBase?: string): string {
  const base = apiBase ?? process.env.PI_TELEGRAM_API_BASE ?? "https://api.telegram.org";
  return base.replace(/\/+$/, "");
}

export async function telegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  apiBase?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${telegramApiBase(apiBase)}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new Error(`Telegram API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const json = (await response.json()) as TelegramApiResponse & { result: T };
  if (!json.ok) {
    throw new TelegramApiRequestError(json.description ?? `${method} failed`, json.parameters?.retry_after, response.status);
  }
  return json.result;
}

export async function getTelegramFile(token: string, fileId: string, signal?: AbortSignal, apiBase?: string): Promise<TelegramFileInfo> {
  return telegramApi<TelegramFileInfo>(
    token,
    "getFile",
    { file_id: fileId },
    signal,
    apiBase,
  );
}

/**
 * Downloads a file from the Telegram file endpoint.
 *
 * Honours `PI_TELEGRAM_API_BASE` / `apiBase` like every other call in this module:
 * the file endpoint lives on the same origin as the Bot API, so hardcoding
 * `api.telegram.org` bypassed a mock or self-hosted Bot API server and sent
 * attachment downloads to the real Telegram service.
 */
export async function downloadTelegramFile(
  token: string,
  filePath: string,
  signal?: AbortSignal,
  apiBase?: string,
): Promise<Buffer> {
  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${telegramApiBase(apiBase)}/file/bot${token}/${encodedPath}`;
  let response: Response;
  try {
    response = await fetch(url, {
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

/**
 * True when repeating the same request may succeed: flood control (429), server
 * errors (5xx), and network-level failures (no Telegram answer). Any other
 * Telegram answer, such as 400 "can't parse entities" or "message is too long",
 * is a deterministic rejection of this payload; repeating it only resends the
 * same rejected message.
 */
function isTransientSendError(error: unknown): boolean {
  if (!(error instanceof TelegramApiRequestError) || error.status === undefined) return true;
  return error.status === 429 || error.status >= 500;
}

// ── Telegram Rich Messages (Bot API 10.1+) ──────────────────────────────────
// Rich Messages render Markdown tables natively, which the regular HTML parse
// mode cannot (see lib/rich-message.ts). A Telegram server that predates the
// API — including a custom `apiBase` proxy or self-hosted Bot API server —
// rejects the call, so rich delivery is attempted opportunistically and marked
// unavailable for the rest of the process after a definitive rejection.

let richMessagesAvailable = true;

/** Reset the process-wide Rich Message capability probe (tests only). */
export function __resetRichMessagesForTests(): void {
  richMessagesAvailable = true;
}

/**
 * True when the failure means the server does not implement Rich Messages.
 * Content-specific rejections (bad markup, oversized payload, …) must NOT
 * disable the feature for every later message.
 */
function isRichUnsupportedError(error: unknown): boolean {
  if (!(error instanceof TelegramApiRequestError)) return false;
  // `Not Found` is Telegram's answer for an unknown method; an older server
  // handed only `rich_message` on an edit replies `message text is empty`.
  return /not found|unknown method|unsupported|message text is empty/i.test(error.message);
}

export class TelegramSendSuppressedError extends Error {
  constructor() {
    super("Telegram send suppressed because this pi instance is not active");
    this.name = "TelegramSendSuppressedError";
  }
}

export function createTelegramTransport(
  getConfig: () => TelegramConfig,
  options: {
    getAbortSignal?: () => AbortSignal | undefined;
    getSendLease?: () => unknown;
    shouldSend?: (lease: unknown) => boolean;
  } = {},
): TelegramTransport {
  const cfg = () => getConfig();
  const captureSendLease = () => options.getSendLease?.();
  const ensureSendAllowed = (lease: unknown) => {
    if (options.shouldSend && !options.shouldSend(lease)) throw new TelegramSendSuppressedError();
  };

  /** Call a Telegram API method with retry on transient failures.
   *  `maxAttempts` overrides the configured retry budget for one call
   *  (diagnostic notices use 1 so a flaky link cannot duplicate them). */
  const callApi = async <T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    lease: unknown,
    delivery?: { maxAttempts?: number },
  ): Promise<T> => {
    const requestSignal = signal ?? options.getAbortSignal?.();
    const token = requireToken();
    const maxAttempts = Math.max(1, delivery?.maxAttempts ?? ((cfg().retryCount ?? 3) + 1));
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        ensureSendAllowed(lease);
        return await telegramApi<T>(token, method, body, requestSignal, cfg().apiBase);
      } catch (error) {
        lastError = error;
        if (
          error instanceof TelegramSendSuppressedError
          || !isTransientSendError(error)
          || attempt + 1 >= maxAttempts
          || requestSignal?.aborted
        ) throw error;
        const retryAfterMs = error instanceof TelegramApiRequestError ? error.retryAfterMs : undefined;
        // Prefer Telegram's explicit flood-control delay; otherwise use exponential backoff.
        await sleep(retryAfterMs ?? 250 * Math.pow(2, attempt));
      }
    }
    throw lastError;
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
    if (err instanceof TelegramSendSuppressedError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    // telegramApi wraps raw fetch failures as "Telegram API request failed: <cause>".
    if (msg.startsWith("Telegram API request failed")) return true;
    // sendDocument/sendPhoto wrap as "Telegram sendX failed: <cause>"; direct
    // Node fetch errors also surface with these signatures.
    return /\bfetch failed\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network(?:\s|_)?error/i.test(msg);
  };

  /** True when a failed send must NOT be retried as plain text. Network
   *  failures and transient Telegram answers (429/5xx) that already used up
   *  their retry budget are not payload problems: a plain-text resend would hit
   *  the same flaky server. Only a deterministic rejection (400 "can't parse
   *  entities", …) earns the single plain-text fallback. */
  const skipsFallback = (err: unknown): boolean => isNetworkError(err) || isTransientSendError(err);

  /** Log why an HTML-format send failed before falling back to plain text.
   *  Without this the renderer's failures were completely silent — a single
   *  unsupported tag nuked the whole message's formatting and nobody noticed.
   *
   *  Network-level failures are intentionally NOT logged here: the polling
   *  loop already reports them via the status line / ui.notify, and logging
   *  every failed send when the bot is simply offline would only noise up the
   *  log file. */
  const warnHtmlFallback = (label: string, err: unknown, preview: string) => {
    if (skipsFallback(err)) return;
    const reason = err instanceof Error ? err.message : String(err);
    const snippet = preview.replace(/\s+/g, " ").slice(0, 120);
    apiLog.warn(`HTML ${label} rejected; falling back to plain text`, { reason, snippet });
  };

  /** Note a rejected Rich Message attempt. A definitive "this server has no
   *  Rich Messages" disables the feature process-wide, so later tables do not
   *  pay a failed request each; content-specific rejections keep it enabled. */
  const noteRichFailure = (label: string, err: unknown) => {
    if (isRichUnsupportedError(err)) {
      richMessagesAvailable = false;
      apiLog.warn("Rich Messages are not supported by this Telegram API base; using HTML tables", {
        method: label,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    apiLog.warn("Rich Message rejected; falling back to HTML", {
      method: label,
      reason: err instanceof Error ? err.message : String(err),
    });
  };

  /** Send one Rich Message. Returns undefined when the caller should fall back
   *  to the HTML path (network failures still propagate: the fallback would
   *  fail identically and the polling status line already reports the outage). */
  const sendRich = async (
    markdown: string,
    chatId: number,
    lease: unknown,
    messageThreadId?: number,
    replyToMessageId?: number,
    delivery?: { maxAttempts?: number },
  ): Promise<TelegramSentMessage | undefined> => {
    try {
      return await callApi<TelegramSentMessage>("sendRichMessage", {
        chat_id: chatId,
        rich_message: { markdown },
        ...messageTargetFields(messageThreadId, replyToMessageId),
      }, undefined, lease, delivery);
    } catch (err) {
      if (skipsFallback(err)) throw err;
      noteRichFailure("sendRichMessage", err);
      return undefined;
    }
  };

  return {
    async sendText(chatId, text, messageThreadId, replyToMessageId, richMarkdown, delivery) {
      const lease = captureSendLease();
      if (richMarkdown && richMessagesAvailable) {
        const rich = await sendRich(richMarkdown, chatId, lease, messageThreadId, replyToMessageId, delivery);
        if (rich) return [rich];
      }
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
        const msg = await callApi<TelegramSentMessage>("sendMessage", body, undefined, lease, delivery)
          .catch((err) => {
            // Network failure: the plain-text retry will fail identically.
            // Propagate so the caller's `.catch` (or renderer suppression)
            // handles it; the polling status line already reports outages.
            if (skipsFallback(err)) throw err;
            warnHtmlFallback("sendMessage", err, chunk);
            return callApi<TelegramSentMessage>("sendMessage", {
              chat_id: chatId,
              text: stripHtml(chunk),
              ...messageTargetFields(messageThreadId, replyToMessageId),
            }, undefined, lease, delivery);
          });
        sent.push(msg);
      }
      return sent;
    },

    async sendButtons(chatId, text, rows, messageThreadId, replyToMessageId) {
      const lease = captureSendLease();
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
      }, undefined, lease).catch((err) => {
        if (skipsFallback(err)) throw err;
        warnHtmlFallback("sendButtons", err, first);
        return callApi<TelegramSentMessage>("sendMessage", {
          chat_id: chatId,
          text: stripHtml(first),
          reply_markup,
          ...messageTargetFields(messageThreadId, replyToMessageId),
        }, undefined, lease);
      });
    },

    async editText(chatId, messageId, text, richMarkdown) {
      const lease = captureSendLease();
      if (richMarkdown && richMessagesAvailable) {
        try {
          await callApi("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            rich_message: { markdown: richMarkdown },
          }, undefined, lease);
          return;
        } catch (err) {
          // Network failure: nothing useful to retry (same as the HTML path).
          if (skipsFallback(err)) return;
          noteRichFailure("editMessageText", err);
        }
      }
      const first = splitTelegramHtml(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
      }, undefined, lease).catch((err) => {
        if (skipsFallback(err)) return; // swallow; nothing useful to retry
        warnHtmlFallback("editMessageText", err, first);
        return callApi("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: stripHtml(first),
        }, undefined, lease).catch(apiLog.swallow("debug", "editMessageText plain-text fallback failed", { chatId, messageId }));
      });
    },

    async editButtons(chatId, messageId, text, rows) {
      const lease = captureSendLease();
      const reply_markup = buildInlineKeyboard(rows);
      const first = splitTelegramHtml(text)[0];
      await callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: first,
        parse_mode: "HTML",
        reply_markup,
      }, undefined, lease).catch((err) => {
        if (skipsFallback(err)) return; // swallow; nothing useful to retry
        warnHtmlFallback("editButtons", err, first);
        return callApi("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: stripHtml(first),
          reply_markup,
        }, undefined, lease).catch(apiLog.swallow("debug", "editButtons plain-text fallback failed", { chatId, messageId }));
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      const lease = captureSendLease();
      await callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }, undefined, lease);
    },

    async removeInlineKeyboard(chatId, messageId) {
      const lease = captureSendLease();
      await callApi("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }, undefined, lease).catch(apiLog.swallow("debug", "removeInlineKeyboard failed", { chatId, messageId }));
    },

    async deleteMessage(chatId, messageId) {
      const lease = captureSendLease();
      await callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }, undefined, lease).catch(apiLog.swallow("warn", "deleteMessage failed", { chatId, messageId }));
    },

    async sendDocument(chatId, path, caption, signal, messageThreadId, replyToMessageId) {
      const lease = captureSendLease();
      const sendSignal = signal ?? options.getAbortSignal?.();
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      const data = await readFile(path);
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          ensureSendAllowed(lease);
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
            ensureSendAllowed(lease);
            const response = await fetch(`${telegramApiBase(cfg().apiBase)}/bot${token}/sendDocument`, {
              method: "POST",
              body: form,
              signal: sendSignal,
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
          if (error instanceof TelegramSendSuppressedError || attempt >= maxRetries || sendSignal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendPhoto(chatId, data, caption, isPath = false, signal, messageThreadId, replyToMessageId) {
      const lease = captureSendLease();
      const sendSignal = signal ?? options.getAbortSignal?.();
      const token = requireToken();
      const maxRetries = cfg().retryCount ?? 3;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          ensureSendAllowed(lease);
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
            ensureSendAllowed(lease);
            const response = await fetch(`${telegramApiBase(cfg().apiBase)}/bot${token}/sendPhoto`, {
              method: "POST",
              body: form,
              signal: sendSignal,
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
          if (error instanceof TelegramSendSuppressedError || attempt >= maxRetries || sendSignal?.aborted) throw error;
          await sleep(250 * Math.pow(2, attempt));
        }
      }
      throw lastError;
    },

    async sendChatAction(chatId, action, messageThreadId) {
      const lease = captureSendLease();
      ensureSendAllowed(lease);
      await telegramApi(requireToken(), "sendChatAction", {
        chat_id: chatId,
        action,
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      }, options.getAbortSignal?.(), cfg().apiBase).catch(apiLog.swallow("debug", "sendChatAction failed", { chatId, action, messageThreadId }));
    },
  };
}

export async function getTelegramBotUsername(token: string, apiBase?: string): Promise<string | undefined> {
  const result = await telegramApi<{ username?: string }>(token, "getMe", {}, undefined, apiBase);
  return result.username;
}

export async function setTelegramMyCommands(token: string, commands: Array<{ command: string; description: string }>, apiBase?: string): Promise<void> {
  await telegramApi(token, "setMyCommands", {
    commands,
  }, undefined, apiBase);
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
    config.apiBase,
  );
}

/**
 * Fetch the unconfirmed backlog without touching the cursor.
 *
 * `offset: 0` returns every update the server still holds and confirms none of
 * them — confirmation only happens when a request's offset is *above* an
 * update's id. Used once per polling runtime start to detect a stored cursor
 * that is ahead of the bot's stream: a server that drops out-of-range requests
 * (the documented behaviour) never hands back such an update, so the corruption
 * would otherwise stay invisible while every message was silently discarded.
 */
export async function getPendingTelegramUpdates(
  config: TelegramConfig,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  if (!config.botToken) return [];
  return telegramApi<TelegramUpdate[]>(
    config.botToken,
    "getUpdates",
    {
      offset: 0,
      timeout: 0,
      allowed_updates: ["message", "callback_query"],
    },
    signal,
    config.apiBase,
  );
}
