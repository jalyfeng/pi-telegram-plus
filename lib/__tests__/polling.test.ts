import { describe, expect, it, vi } from "vitest";
import { processTelegramUpdatesBatch } from "../polling.ts";
import type { TelegramConfig, TelegramUpdate } from "../types.ts";

const update = (id: number): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: 123 }, from: { id: 456 }, text: `message ${id}` },
});

describe("processTelegramUpdatesBatch", () => {
  it("stops at a failed update and does not advance offset past it", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    const handled: number[] = [];
    const persisted: number[] = [];
    const errors: unknown[] = [];

    await processTelegramUpdatesBatch([update(10), update(11), update(12)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async (item) => {
        handled.push(item.update_id);
        if (item.update_id === 11) throw new Error("boom 11");
      }),
      onError: (error) => { errors.push(error); },
    });

    expect(handled).toEqual([10, 11]);
    expect(persisted).toEqual([10]);
    expect(config.lastUpdateId).toBe(10);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("stops when persisting an update fails so later updates cannot skip it", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 20 };
    const handled: number[] = [];
    const persisted: number[] = [];
    const errors: unknown[] = [];

    await processTelegramUpdatesBatch([update(21), update(22)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => {
        persisted.push(next.lastUpdateId!);
        if (next.lastUpdateId === 21) throw new Error("persist failed");
      }),
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: (error) => { errors.push(error); },
    });

    expect(handled).toEqual([21]);
    expect(persisted).toEqual([21]);
    expect(config.lastUpdateId).toBe(20);
    expect(errors).toHaveLength(1);
  });
});
