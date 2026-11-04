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
    const errors: { error: unknown; context?: string }[] = [];

    const processed = await processTelegramUpdatesBatch([update(10), update(11), update(12)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async (item) => {
        handled.push(item.update_id);
        if (item.update_id === 11) throw new Error("boom 11");
      }),
      onError: (error, context) => { errors.push({ error, context }); },
    });

    // The cursor moves past an update before its handler runs, so the failed update is
    // committed and not retried; the batch stops there.
    expect(processed).toBe(false);
    expect(handled).toEqual([10, 11]);
    expect(persisted).toEqual([10, 11]);
    expect(config.lastUpdateId).toBe(11);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].context).toBe("processing");
  });

  it("stops before the next update when the instance loses its active lease", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 30 };
    let active = true;
    const handled: number[] = [];

    const processed = await processTelegramUpdatesBatch([update(31), update(32)], {
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
        active = false;
      },
      persistConfig: vi.fn(async () => undefined),
      shouldProcess: () => active,
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: vi.fn(),
    });

    expect(processed).toBe(true); // losing the lease is not a retryable failure
    expect(handled).toEqual([31]);
    expect(config.lastUpdateId).toBe(31);
  });

  it("stops when persisting an update fails so later updates cannot skip it", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 20 };
    const handled: number[] = [];
    const persisted: number[] = [];
    const errors: { error: unknown; context?: string }[] = [];

    const processed = await processTelegramUpdatesBatch([update(21), update(22)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => {
        persisted.push(next.lastUpdateId!);
        if (next.lastUpdateId === 21) throw new Error("persist failed");
      }),
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: (error, context) => { errors.push({ error, context }); },
    });

    expect(processed).toBe(false);
    expect(errors[0].context).toBe("processing");
    // The cursor could not be committed, so the update was not handled and stays unconfirmed.
    expect(handled).toEqual([]);
    expect(persisted).toEqual([21]);
    expect(config.lastUpdateId).toBe(20);
    expect(errors).toHaveLength(1);
  });

  it("skips re-delivered updates the cursor already processed", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 10 };
    const handled: number[] = [];
    const persisted: number[] = [];

    const processed = await processTelegramUpdatesBatch([update(10), update(11)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: vi.fn(),
    });

    expect(processed).toBe(true);
    expect(handled).toEqual([11]);
    expect(persisted).toEqual([11]);
    expect(config.lastUpdateId).toBe(11);
  });
});

describe("the cursor is committed before the handler runs", () => {
  it("has the update's cursor committed while its handler runs", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    let cursorDuringHandler: number | undefined;

    await processTelegramUpdatesBatch([update(10)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async () => {}),
      handleUpdate: vi.fn(async () => { cursorDuringHandler = config.lastUpdateId; }),
      onError: () => {},
    });

    expect(cursorDuringHandler).toBe(10);
  });

  it("persists the cursor through persistUpdate before the handler", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    const order: string[] = [];

    await processTelegramUpdatesBatch([update(10)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistUpdate: vi.fn(async (_next, item) => { order.push(`persist:${item.update_id}`); }),
      persistConfig: vi.fn(async () => { order.push("config"); }),
      handleUpdate: vi.fn(async (item) => { order.push(`handle:${item.update_id}`); }),
      onError: () => {},
    });

    // The replacement runtime reads the coordinator cursor, so the commit goes through
    // persistUpdate, and before the handler can replace the runtime.
    expect(order).toEqual(["persist:10", "handle:10"]);
  });

  it("does not hand an update to the replacement runtime again when the handler replaces the runtime", async () => {
    // Telegram serves every update at or above the offset the runtime asks for.
    const server = [update(10), update(11)];
    const serve = (offset: number) => server.filter((item) => item.update_id >= offset);
    // What is on disk is what a replacement runtime starts from.
    const disk: { config: TelegramConfig } = { config: { botToken: "token", lastUpdateId: 9 } };
    let memory = disk.config;
    let tornDown = false;
    let replacementFirstFetch: number[] | undefined;

    await processTelegramUpdatesBatch(serve(memory.lastUpdateId! + 1), {
      getConfig: () => memory,
      setConfig: (next) => { memory = next; },
      persistUpdate: vi.fn(async (next) => { disk.config = next; }),
      persistConfig: vi.fn(async () => {}),
      shouldProcess: () => !tornDown,
      handleUpdate: vi.fn(async (item) => {
        if (item.update_id !== 10) return;
        // The command switches the session: the replacement runtime starts and makes its first
        // fetch from the stored cursor while this handler is still running, then the old one is disposed.
        replacementFirstFetch = serve(disk.config.lastUpdateId! + 1).map((next) => next.update_id);
        tornDown = true;
      }),
      onError: () => {},
    });

    // The replacement must not get update 10 again; 11 was never handled and is still due.
    expect(replacementFirstFetch).toEqual([11]);
  });
});
