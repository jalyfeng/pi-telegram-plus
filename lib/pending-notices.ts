import { log } from "./logger.ts";
import type { TelegramDelivery, TelegramTransport } from "./types.ts";

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
  /**
   * Content the user must see (a final reply, a closing edit), kept by the
   * transport when Telegram is unreachable. Such a notice has its own, longer
   * lifetime and its own queue limit.
   */
  mustDeliver?: boolean;
  /** When the notice was first queued (for a kept notice: its first failed send). */
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
/** Must-deliver content is kept through a long Telegram outage; 200 pieces cover a long reply's chunks. */
const MAX_MUST_DELIVER_NOTICES = 200;
/** A notice nobody drained within this window is stale: the chat has moved on. */
const PENDING_NOTICE_TTL_MS = 2 * 60 * 1000;
/**
 * Must-deliver content outlives a normal notice: it is an answer the user is waiting for,
 * and a link outage can last longer than two minutes. Thirty minutes is still bounded so
 * a dead bot does not hold messages forever.
 */
const MUST_DELIVER_TTL_MS = 30 * 60 * 1000;

function getPendingNoticeQueue(): PendingNotice[] {
  const g = globalThis as typeof globalThis & Record<symbol, PendingNotice[] | undefined>;
  g[PENDING_NOTICES] ??= [];
  return g[PENDING_NOTICES] as PendingNotice[];
}

const isMustDeliver = (notice: PendingNotice): boolean => notice.mustDeliver === true;

/** Keep the oldest `limit` entries of one group; the rest are dropped with a warning. */
function enforceLimit(queue: PendingNotice[], group: boolean, limit: number): void {
  let excess = queue.filter((notice) => isMustDeliver(notice) === group).length - limit;
  for (let i = 0; i < queue.length && excess > 0; ) {
    if (isMustDeliver(queue[i]) === group) {
      const [dropped] = queue.splice(i, 1);
      excess -= 1;
      noticeLog.warn("pending notice dropped: queue limit reached", { chatId: dropped.chatId, mustDeliver: group });
    } else {
      i += 1;
    }
  }
}

export function queuePendingNotice(notice: PendingNotice): void {
  const queue = getPendingNoticeQueue();
  // A later edit of the same message replaces the queued one in place: only the newest content goes out.
  // The replacement keeps the first queue time, so a long outage does not extend the lifetime.
  const sameMessage = notice.editMessageId === undefined
    ? -1
    : queue.findIndex((queued) => queued.chatId === notice.chatId && queued.editMessageId === notice.editMessageId);
  if (sameMessage >= 0) {
    const earlier = queue[sameMessage];
    queue[sameMessage] = { ...notice, createdAt: earlier.createdAt, mustDeliver: isMustDeliver(earlier) || isMustDeliver(notice) };
    return;
  }
  queue.push(notice);
  enforceLimit(queue, true, MAX_MUST_DELIVER_NOTICES);
  enforceLimit(queue, false, MAX_PENDING_NOTICES);
}

/**
 * Forget queued edits of a message that has just been edited directly: a
 * queued edit is older than that content and must not overwrite it on replay.
 */
export function supersedePendingEdit(chatId: number, messageId: number): void {
  const queue = getPendingNoticeQueue();
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].chatId === chatId && queue[i].editMessageId === messageId) queue.splice(i, 1);
  }
}

/** Drain the queue, dropping notices older than their TTL. */
export function takePendingNotices(now = Date.now()): PendingNotice[] {
  const queue = getPendingNoticeQueue();
  return queue.splice(0, queue.length).filter((notice) => {
    const ttl = isMustDeliver(notice) ? MUST_DELIVER_TTL_MS : PENDING_NOTICE_TTL_MS;
    return now - notice.createdAt <= ttl;
  });
}

/**
 * Deliver every queued notice through `transport` (the CALLER's transport, i.e.
 * the runtime that is now active) in queue order, one after another, and forget
 * them. A must-deliver notice that fails again on an outage is kept by the
 * transport for the next reconnect; any other failure is logged and dropped, as
 * before: the chat has already moved on. Never rejects.
 */
export async function deliverPendingNotices(
  transport: Pick<TelegramTransport, "sendText" | "editText">,
  showPaged?: PagedDelivery,
  now = Date.now(),
): Promise<void> {
  for (const notice of takePendingNotices(now)) {
    if (notice.paged) {
      if (showPaged && notice.editMessageId !== undefined) {
        showPaged({ chatId: notice.chatId, messageThreadId: notice.messageThreadId, messageId: notice.editMessageId }, notice.paged.title, notice.html);
      } else {
        noticeLog.warn("paged notice dropped: no pager in this runtime", { chatId: notice.chatId });
      }
      continue;
    }
    const options: TelegramDelivery = { mustDeliver: isMustDeliver(notice), heldSince: notice.createdAt };
    try {
      if (notice.editMessageId !== undefined) {
        await transport.editText(notice.chatId, notice.editMessageId, notice.html, undefined, options);
      } else {
        await transport.sendText(notice.chatId, notice.html, notice.messageThreadId, notice.replyTo, undefined, options);
      }
    } catch (error) {
      noticeLog.warn("pending notice delivery failed", { chatId: notice.chatId, error });
    }
  }
}
