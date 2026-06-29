import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TelegramTransport, TelegramTurn } from "./types.ts";
import { log } from "./logger.ts";

const attachLog = log.child("attachments");

const MAX_ATTACHMENTS_PER_TURN = 10;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function outboundAttachmentLimit(): number {
  for (const name of ["PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES", "TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES"]) {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return DEFAULT_MAX_BYTES;
}

const SENSITIVE_PATH_PREFIXES = ["/etc", "/.ssh", "/root/.ssh"];

function isSensitivePath(resolved: string): boolean {
  const home = process.env.HOME ?? "";
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (resolved.startsWith(prefix)) return true;
  }
  if (home && resolved.startsWith(home + "/.ssh")) return true;
  return false;
}

function isPhotoPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.endsWith(".jpg") || normalized.endsWith(".jpeg") || normalized.endsWith(".png") || normalized.endsWith(".webp");
}

function sizeLimitError(path: string, size: number, max: number): string {
  return `Attachment exceeds size limit (${size} bytes > ${max} bytes): ${path}`;
}

type ResolvedTelegramAttachment = {
  path: string;
  fileName: string;
};

async function sendTelegramAttachment(
  chatId: number,
  attachment: ResolvedTelegramAttachment,
  transport: TelegramTransport,
  maxBytes: number,
  onError?: (message: string) => Promise<void>,
): Promise<void> {
  try {
    const stats = await stat(attachment.path);
    if (stats.size > maxBytes) {
      throw new Error(sizeLimitError(attachment.path, stats.size, maxBytes));
    }
    if (isPhotoPath(attachment.path)) {
      try {
        await transport.sendChatAction(chatId, "upload_photo");
        await transport.sendPhoto(chatId, attachment.path, attachment.fileName, true);
        return;
      } catch (err) {
        attachLog.warn("sendPhoto failed; falling back to sendDocument", { chatId, fileName: attachment.fileName, err });
        await transport.sendChatAction(chatId, "upload_document");
        await transport.sendDocument(chatId, attachment.path, attachment.fileName);
        return;
      }
    }
    await transport.sendChatAction(chatId, "upload_document");
    await transport.sendDocument(chatId, attachment.path, attachment.fileName);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (onError) {
      await onError(`Failed to send attachment ${attachment.fileName}: ${message}`);
      return;
    }
    throw error;
  }
}

function formatDirectAttachmentErrorSummary(errors: string[]): string {
  if (errors.length === 0) return "";
  return ` (${errors.length} failed, first: ${errors[0]})`;
}

export function registerTelegramAttachmentTool(
  pi: ExtensionAPI,
  deps: {
    getActiveTurn: () => TelegramTurn | undefined;
    getDefaultChatId?: () => number | undefined;
    transport: TelegramTransport;
  },
): void {
  pi.registerTool({
    name: "tg_attach",
    label: "Telegram Attach",
    description: "Send one or more local files to Telegram immediately (uses current active turn chat, or default chat config when no active turn exists).",
    promptSnippet: "Send local files to Telegram immediately.",
    promptGuidelines: [
      "When handling a Telegram-originated request and the user asked for a file or generated artifact, call tg_attach with the local path instead of only mentioning the path in text.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
    }),
    async execute(_toolCallId, params) {
      const maxBytes = outboundAttachmentLimit();
      const pendingAttachments: ResolvedTelegramAttachment[] = [];
      for (const rawPath of params.paths) {
        const resolved = resolve(rawPath);
        if (isSensitivePath(resolved)) throw new Error(`Attachment path not allowed (sensitive): ${rawPath}`);
        const stats = await stat(resolved);
        if (!stats.isFile()) throw new Error(`Not a file: ${rawPath}`);
        if (stats.size > maxBytes) throw new Error(sizeLimitError(rawPath, stats.size, maxBytes));
        pendingAttachments.push({ path: resolved, fileName: basename(resolved) });
      }

      if (params.paths.length > MAX_ATTACHMENTS_PER_TURN) {
        throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
      }
      const turn = deps.getActiveTurn();
      const chatId = turn?.chatId ?? deps.getDefaultChatId?.();
      if (chatId === undefined) {
        throw new Error("tg_attach can only be used with an active Telegram chat or configured default chat id");
      }
      const failed: string[] = [];
      for (const attachment of pendingAttachments) {
        await sendTelegramAttachment(chatId, attachment, deps.transport, maxBytes, async (message) => {
          failed.push(message);
          await deps.transport.sendText(chatId, message).catch(attachLog.swallow("warn", "sendText attachment error notice failed", { chatId }));
        });
      }
      return {
        content: [{
          type: "text" as const,
          text: `\nSent ${pendingAttachments.length} Telegram attachment(s).${formatDirectAttachmentErrorSummary(failed)}`,
        }],
        details: { paths: pendingAttachments.map((attachment) => attachment.path) },
      };
    },
  });
}

export async function sendQueuedTelegramAttachments(
  turn: TelegramTurn,
  transport: TelegramTransport,
): Promise<void> {
  if (turn.attachmentsSent) return;
  turn.attachmentsSent = true;
  const maxBytes = outboundAttachmentLimit();
  for (const attachment of turn.queuedAttachments) {
    await sendTelegramAttachment(turn.chatId, attachment, transport, maxBytes, async (message) => {
      await transport.sendText(turn.chatId, message).catch(attachLog.swallow("warn", "sendText attachment error notice failed", { chatId: turn.chatId }));
    });
  }
}
