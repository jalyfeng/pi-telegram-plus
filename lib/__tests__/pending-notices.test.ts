/**
 * Notices that must survive an extension-runtime replacement (`/new` on pi,
 * `/reload` on both hosts): the queue lives on globalThis, the old runtime only
 * queues, the replacement runtime delivers from its reconcile loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverPendingNotices, queuePendingNotice, takePendingNotices, type PendingNotice } from "../pending-notices.ts";
import type { TelegramTransport } from "../types.ts";

const notice = (over: Partial<PendingNotice> = {}): PendingNotice => ({
  chatId: 42,
  html: "✅ Done",
  createdAt: Date.now(),
  ...over,
});

function fakeTransport() {
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const sends: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }> = [];
  const transport: Pick<TelegramTransport, "sendText" | "editText"> = {
    editText: vi.fn(async (chatId: number, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
    }),
    sendText: vi.fn(async (chatId: number, text: string, messageThreadId?: number, replyToMessageId?: number) => {
      sends.push({ chatId, text, messageThreadId, replyToMessageId });
      return [{ message_id: 1 }];
    }),
  };
  return { transport, edits, sends };
}

afterEach(() => {
  // The queue is process-global: drain whatever a test left behind.
  takePendingNotices();
});

describe("pending notice queue", () => {
  it("queues a notice and empties the queue once taken", () => {
    queuePendingNotice(notice());
    expect(takePendingNotices().map((n) => n.html)).toEqual(["✅ Done"]);
    expect(takePendingNotices()).toEqual([]);
  });

  it("drops notices older than two minutes", () => {
    queuePendingNotice(notice({ html: "fresh", createdAt: Date.now() - 119_000 }));
    queuePendingNotice(notice({ html: "stale", createdAt: Date.now() - 121_000 }));
    expect(takePendingNotices().map((n) => n.html)).toEqual(["fresh"]);
  });

  it("keeps at most 20 notices and drops the oldest", () => {
    for (let i = 0; i < 25; i++) queuePendingNotice(notice({ html: `n${i}` }));
    const taken = takePendingNotices();
    expect(taken.map((n) => n.html)).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${i + 5}`),
    );
  });
});

describe("pending notice lifetime and limits", () => {
  it("keeps a must-deliver notice for 30 minutes and drops a normal one after 2", () => {
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    queuePendingNotice(notice({ html: "must", mustDeliver: true, createdAt: tenMinutesAgo }));
    queuePendingNotice(notice({ html: "normal", createdAt: tenMinutesAgo }));
    expect(takePendingNotices().map((n) => n.html)).toEqual(["must"]);
  });

  it("drops a must-deliver notice older than 30 minutes", () => {
    queuePendingNotice(notice({ html: "stale", mustDeliver: true, createdAt: Date.now() - 31 * 60_000 }));
    expect(takePendingNotices()).toEqual([]);
  });

  it("caps must-deliver notices at 200 and normal ones at 20, counted separately", () => {
    for (let i = 0; i < 201; i++) queuePendingNotice(notice({ html: `m${i}`, mustDeliver: true }));
    for (let i = 0; i < 21; i++) queuePendingNotice(notice({ html: `n${i}` }));
    const taken = takePendingNotices();
    expect(taken.filter((n) => n.mustDeliver)).toHaveLength(200);
    expect(taken.find((n) => n.html === "m0")).toBeUndefined();
    expect(taken.filter((n) => !n.mustDeliver)).toHaveLength(20);
  });

  it("a later edit of the same message replaces the queued one in place and keeps its first queue time", () => {
    queuePendingNotice(notice({ html: "one", editMessageId: 5, createdAt: 100 }));
    queuePendingNotice(notice({ html: "other" }));
    queuePendingNotice(notice({ html: "two", editMessageId: 5, createdAt: 200 }));
    const taken = takePendingNotices(200);
    expect(taken.map((n) => n.html)).toEqual(["two", "other"]);
    expect(taken[0].createdAt).toBe(100);
  });
});

describe("deliverPendingNotices (what the replacement runtime's reconcile does)", () => {
  it("edits the ack when the notice carries a message id, sends otherwise", async () => {
    queuePendingNotice(notice({ editMessageId: 7, html: "<b>▶️ /new</b>\n\n✅ New session started" }));
    queuePendingNotice(notice({ messageThreadId: 3, replyTo: 9, html: "✅ Reloaded." }));

    const { transport, edits, sends } = fakeTransport();
    await deliverPendingNotices(transport);

    expect(edits).toEqual([{ chatId: 42, messageId: 7, text: "<b>▶️ /new</b>\n\n✅ New session started" }]);
    expect(sends).toEqual([{ chatId: 42, text: "✅ Reloaded.", messageThreadId: 3, replyToMessageId: 9 }]);
  });

  it("a second reconcile re-sends nothing", async () => {
    queuePendingNotice(notice());
    const { transport, sends } = fakeTransport();

    await deliverPendingNotices(transport);
    await deliverPendingNotices(transport);

    expect(sends).toHaveLength(1);
  });

  it("never re-delivers a notice that expired before the reconcile", async () => {
    queuePendingNotice(notice({ createdAt: Date.now() - 121_000 }));
    const { transport, sends } = fakeTransport();

    await deliverPendingNotices(transport);

    expect(sends).toEqual([]);
  });

  it("swallows a failed delivery", async () => {
    queuePendingNotice(notice());
    const { transport, sends } = fakeTransport();
    vi.mocked(transport.sendText).mockRejectedValueOnce(new Error("403 Forbidden"));

    await expect(deliverPendingNotices(transport)).resolves.toBeUndefined();
    expect(sends).toEqual([]);
  });

  it("sends in queue order, one at a time: the next send starts only after the previous one settled", async () => {
    queuePendingNotice(notice({ html: "first", mustDeliver: true }));
    queuePendingNotice(notice({ html: "second", mustDeliver: true }));
    const order: string[] = [];
    let release: () => void = () => undefined;
    const transport: Pick<TelegramTransport, "sendText" | "editText"> = {
      editText: vi.fn(async () => undefined),
      sendText: vi.fn((_chatId: number, text: string) => {
        order.push(`start ${text}`);
        return new Promise<never[]>((resolve) => {
          release = () => { order.push(`end ${text}`); resolve([]); };
        });
      }),
    };

    const done = deliverPendingNotices(transport);
    expect(order).toEqual(["start first"]);
    release();
    await vi.waitFor(() => expect(order).toEqual(["start first", "end first", "start second"]));
    release();
    await done;
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("passes mustDeliver and the original queue time to the transport", async () => {
    const queuedAt = Date.now() - 60_000;
    queuePendingNotice(notice({ html: "reply", mustDeliver: true, createdAt: queuedAt }));
    const { transport } = fakeTransport();

    await deliverPendingNotices(transport);

    expect(vi.mocked(transport.sendText).mock.calls[0][5]).toEqual({ mustDeliver: true, heldSince: queuedAt });
  });
});
