import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramTransport } from "../telegram-api.ts";
import type { TelegramConfig } from "../types.ts";
import { __drainAndListFiles, __resetSinkForTests, initLogger } from "../logger.ts";

type FetchImpl = typeof fetch;

function telegramResponse(ok: boolean, result: unknown, description?: string): Response {
  return new Response(JSON.stringify({ ok, result, description }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Drive `createTelegramTransport` against a stubbed global fetch. The transport
 * is given a mutable config holder so individual tests can flip the bot token.
 */
function makeTransport() {
  let config: TelegramConfig = { botToken: "tok", retryCount: 0 };
  const transport = createTelegramTransport(() => config);
  return { transport, setConfig: (next: TelegramConfig) => { config = next; }, getConfig: () => config };
}

function freshLogDir(): string {
  return join(tmpdir(), `pi-tg-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function readTodayLog(dir: string): Promise<string> {
  await __drainAndListFiles(dir).catch(() => undefined);
  const files = await __drainAndListFiles(dir);
  const base = files.find((f) => f.split(sep).pop()!.match(/^pi-telegram-plus-\d{4}-\d{2}-\d{2}\.log$/));
  if (!base) return "";
  return readFile(base, "utf8");
}

describe("createTelegramTransport — network-failure suppression & logging", () => {
  let originalFetch: FetchImpl;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Logger must NEVER touch the console (it pollutes the pi TUI). Keep a spy
    // to enforce the no-console invariant across every test below.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logDir = freshLogDir();
    __resetSinkForTests();
    initLogger({ dir: logDir, level: "debug" });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
    await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("sendText rejects (no log warn, no console.warn, no plain-text retry) on a network failure", async () => {
    // Node's fetch rejects with a TypeError("fetch failed") on network errors.
    const failingFetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    globalThis.fetch = failingFetch as unknown as FetchImpl;

    const { transport } = makeTransport();

    // retryCount defaults to 3 → 4 attempts; verify only the HTML call is
    // attempted (no plain-text fallback) by counting fetch invocations.
    await expect(transport.sendText(1, "<b>hi</b>")).rejects.toThrow(/fetch failed/);

    // With retryCount: 0, only the HTML call is attempted (no retries, no
    // plain-text fallback) — verifying network failures short-circuit the
    // plain-text fallback path entirely.
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    // Network failures are not logged as HTML rejections (isNetworkError guard).
    const logText = await readTodayLog(logDir);
    expect(logText).not.toMatch(/HTML .*rejected/);
  });

  it("editText swallows network failures (no console.warn, no log warn)", async () => {
    const failingFetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    globalThis.fetch = failingFetch as unknown as FetchImpl;

    const { transport } = makeTransport();
    await expect(transport.editText(1, 10, "<b>hi</b>")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    const logText = await readTodayLog(logDir);
    expect(logText).not.toMatch(/HTML .*rejected/);
  });

  it("sendText falls back to plain text and logs a warn on a genuine HTML rejection", async () => {
    const htmlError = () => telegramResponse(false, undefined, "Bad Request: can't parse entities: unexpected character");
    const plainOk = () => telegramResponse(true, { message_id: 7 });
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return body.parse_mode === "HTML" ? htmlError() : plainOk();
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    const sent = await transport.sendText(1, "<b>hi</b>");
    expect(sent).toEqual([{ message_id: 7 }]);
    // With retryCount: 0: one HTML attempt (rejected) then one plain-text
    // fallback (ok) — no retries.
    expect(stub).toHaveBeenCalledTimes(2);
    // The warn now goes to the log file (JSON Lines), NOT the console.
    expect(warnSpy).not.toHaveBeenCalled();
    const logText = await readTodayLog(logDir);
    expect(logText).toMatch(/"level":"warn"/);
    expect(logText).toMatch(/HTML sendMessage rejected/);
    expect(logText).toMatch(/can't parse entities/);
    expect(logText).toMatch(/"scope":"telegram-api"/);
  });
});