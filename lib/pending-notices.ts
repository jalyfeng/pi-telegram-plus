import { log } from "./logger.ts";
import type { TelegramTransport } from "./types.ts";

const noticeLog = log.child("pending-notices");

/**
 * Notices that must be delivered by the REPLACEMENT extension runtime.
 *
 * `/new` (pi) and `/reload` (both hosts) re-activate the plugin in-process. The
 * old runtime's active-transport drops every send queued after the lease
 * changes (that is what keeps a non-active instance out of the chat), so a
 * result message produced by the old runtime never reaches Telegram. Instead of
 * sending it, the old runtime queues it here; the new runtime drains the queue
 * from its reconcile loop, where it is the active instance.
 *
 * The queue lives on `globalThis` under a registered symbol: module state is
 * rebuilt on reload, this survives it.
 */
export type PendingNotice = {
  chatId: number;
  messageThreadId?: number;
  /** Reply target for a plain send; ignored for an edit. */
  replyTo?: number;
  /** When set the notice edits this existing message instead of sending. */
  editMessageId?: number;
  /**
   * A paged command output: `html` is the full body, and the replacement runtime shows it through
   * its own pager on `editMessageId` (with its own page buttons). Needs a PagedDelivery to deliver.
   */
  paged?: { title: string };
  html: string;
  createdAt: number;
};

/** Shows a paged body on a message through the runtime's pager (DialogBroker.showPaged). */
export type PagedDelivery = (
  target: { chatId: number; messageThreadId?: number; messageId: number },
  title: string,
  html: string,
) => void;

const PENDING_NOTICES = Symbol.for("pi-telegram-plus.pending-notices");
const MAX_PENDING_NOTICES = 20;
/** A notice nobody drained within this window is stale: the chat has moved on. */
const PENDING_NOTICE_TTL_MS = 2 * 60 * 1000;

function getPendingNoticeQueue(): PendingNotice[] {
  const g = globalThis as typeof globalThis & Record<symbol, PendingNotice[] | undefined>;
  g[PENDING_NOTICES] ??= [];
  return g[PENDING_NOTICES] as PendingNotice[];
}

export function queuePendingNotice(notice: PendingNotice): void {
  const queue = getPendingNoticeQueue();
  queue.push(notice);
  if (queue.length > MAX_PENDING_NOTICES) queue.splice(0, queue.length - MAX_PENDING_NOTICES);
}

/** Drain the queue, dropping notices older than the TTL. */
export function takePendingNotices(now = Date.now()): PendingNotice[] {
  const queue = getPendingNoticeQueue();
  return queue.splice(0, queue.length).filter((notice) => now - notice.createdAt <= PENDING_NOTICE_TTL_MS);
}

/**
 * Deliver every queued notice through `transport` (the CALLER's transport, i.e.
 * the runtime that is now active) and forget them. A failed delivery is logged,
 * never retried: the chat has already moved on.
 */
export function deliverPendingNotices(
  transport: Pick<TelegramTransport, "sendText" | "editText">,
  showPaged?: PagedDelivery,
  now = Date.now(),
): void {
  for (const notice of takePendingNotices(now)) {
    if (notice.paged) {
      if (showPaged && notice.editMessageId !== undefined) {
        showPaged({ chatId: notice.chatId, messageThreadId: notice.messageThreadId, messageId: notice.editMessageId }, notice.paged.title, notice.html);
      } else {
        noticeLog.warn("paged notice dropped: no pager in this runtime", { chatId: notice.chatId });
      }
      continue;
    }
    const delivery: Promise<unknown> = notice.editMessageId !== undefined
      ? transport.editText(notice.chatId, notice.editMessageId, notice.html)
      : transport.sendText(notice.chatId, notice.html, notice.messageThreadId, notice.replyTo);
    void delivery.catch((error) => noticeLog.warn("pending notice delivery failed", { chatId: notice.chatId, error }));
  }
}
