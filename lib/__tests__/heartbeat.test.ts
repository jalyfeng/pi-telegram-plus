import { describe, expect, it, vi } from "vitest";
import { createHeartbeat } from "../heartbeat.ts";
import type { TelegramTurn } from "../types.ts";

const state = {
  hasBotToken: true,
  pollingActive: true,
  paired: true,
  processing: true,
};

describe("createHeartbeat", () => {
  it("sends typing to every active chat/thread target", async () => {
    const turnA: TelegramTurn = { chatId: 111, messageThreadId: 10, queuedAttachments: [] };
    const turnB: TelegramTurn = { chatId: 111, messageThreadId: 20, queuedAttachments: [] };
    const actions: Array<{ chatId: number; action: string; messageThreadId?: number }> = [];
    const heartbeat = createHeartbeat({
      getConfig: () => ({ botToken: "token" }),
      getActiveTurns: () => [turnA, turnB],
      sendChatAction: async (chatId, action, messageThreadId) => { actions.push({ chatId, action, messageThreadId }); },
      ensurePollingStarted: () => undefined,
    });

    heartbeat.refreshStatus(state);
    await vi.waitFor(() => expect(actions).toHaveLength(2));

    expect(actions).toEqual(expect.arrayContaining([
      { chatId: 111, action: "typing", messageThreadId: 10 },
      { chatId: 111, action: "typing", messageThreadId: 20 },
    ]));
    heartbeat.dispose();
  });

  it("does not send typing for a stale same-chat thread that ended mid-pulse", async () => {
    const staleTurn: TelegramTurn = { chatId: 111, messageThreadId: 10, queuedAttachments: [] };
    const liveTurn: TelegramTurn = { chatId: 111, messageThreadId: 20, queuedAttachments: [] };
    let call = 0;
    const actions: Array<{ chatId: number; action: string; messageThreadId?: number }> = [];
    const heartbeat = createHeartbeat({
      getConfig: () => ({ botToken: "token" }),
      getActiveTurns: () => {
        call += 1;
        return call === 1 ? [staleTurn, liveTurn] : [liveTurn];
      },
      sendChatAction: async (chatId, action, messageThreadId) => { actions.push({ chatId, action, messageThreadId }); },
      ensurePollingStarted: () => undefined,
    });

    heartbeat.refreshStatus(state);
    await vi.waitFor(() => expect(actions).toHaveLength(1));

    expect(actions).toEqual([{ chatId: 111, action: "typing", messageThreadId: 20 }]);
    heartbeat.dispose();
  });
});
