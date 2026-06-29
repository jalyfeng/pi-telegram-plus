import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramTransport } from "../telegram-api.ts";
import type { TelegramConfig } from "../types.ts";

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

describe("createTelegramTransport — network-failure suppression", () => {
  let originalFetch: FetchImpl;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it("sendText rejects (no console.warn, no plain-text retry) on a network failure", async () => {
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
  });

  it("editText swallows network failures silently (no console.warn)", async () => {
    const failingFetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    globalThis.fetch = failingFetch as unknown as FetchImpl;

    const { transport } = makeTransport();
    await expect(transport.editText(1, 10, "<b>hi</b>")).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("sendText falls back to plain text and warns on a genuine HTML rejection", async () => {
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/HTML sendMessage rejected.*can't parse entities/);
  });
});