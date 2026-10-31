import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramTransport, __resetRichMessagesForTests } from "../telegram-api.ts";
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

  it("honors a per-call maxAttempts override so notices are one-shot", async () => {
    const failingFetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    globalThis.fetch = failingFetch as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 3 });

    await expect(
      transport.sendText(1, "<b>error</b>", undefined, undefined, undefined, { maxAttempts: 1 }),
    ).rejects.toThrow(/fetch failed/);
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it("honors Telegram retry_after responses before retrying a send", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          ok: false,
          description: "Too Many Requests: retry later",
          parameters: { retry_after: 0 },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return telegramResponse(true, { message_id: 9 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 1 });
    await expect(transport.sendText(123, "history chunk")).resolves.toEqual([{ message_id: 9 }]);

    expect(stub).toHaveBeenCalledTimes(2);
    expect(bodies.every((body) => body.parse_mode === "HTML")).toBe(true);
  });

  it("stops a multi-chunk send when the active-instance generation changes", async () => {
    let generation = 1;
    const stub = vi.fn(async () => {
      generation = 2;
      return telegramResponse(true, { message_id: 9 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;
    const transport = createTelegramTransport(
      () => ({ botToken: "tok", retryCount: 0 }),
      {
        getSendLease: () => generation,
        shouldSend: (lease) => lease === generation,
      },
    );

    await expect(transport.sendText(123, "history ".repeat(2_000))).rejects.toThrow(/send suppressed/);

    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("sendText includes Telegram topic and source-message reply context", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return telegramResponse(true, { message_id: 9 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    await transport.sendText(123, "hello", 456, 789);
    await transport.sendChatAction(123, "typing", 456);

    expect(bodies[0]).toMatchObject({
      chat_id: 123,
      message_thread_id: 456,
      reply_parameters: { message_id: 789 },
      text: "hello",
    });
    expect(bodies[1]).toMatchObject({
      chat_id: 123,
      message_thread_id: 456,
      action: "typing",
    });
  });

  it("sendChatAction targets the configured apiBase instead of the public endpoint", async () => {
    const urls: string[] = [];
    const stub = vi.fn(async (url: string) => {
      urls.push(url);
      return telegramResponse(true, true);
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 0, apiBase: "http://self-hosted.example:8081" });
    await transport.sendChatAction(123, "typing");

    expect(urls).toEqual(["http://self-hosted.example:8081/bottok/sendChatAction"]);
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

describe("createTelegramTransport — retries only transient failures", () => {
  let originalFetch: FetchImpl;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
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

  const httpError = (status: number, description: string, retryAfter?: number) => new Response(JSON.stringify({
    ok: false,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  }), { status, headers: { "content-type": "application/json" } });

  it("a 400 parse rejection makes one HTML attempt and one plain-text attempt, even with retries configured", async () => {
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return body.parse_mode === "HTML"
        ? httpError(400, "Bad Request: can't parse entities: unexpected character")
        : telegramResponse(true, { message_id: 7 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 3 });
    await expect(transport.sendText(1, "<pre><code>x &lt; y</code></pre>")).resolves.toEqual([{ message_id: 7 }]);

    expect(stub).toHaveBeenCalledTimes(2);
    const bodies = stub.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].parse_mode).toBe("HTML");
    expect(bodies[1].parse_mode).toBeUndefined();
  });

  it("a 400 rejection on the plain-text fallback is not retried either", async () => {
    const stub = vi.fn(async () => httpError(400, "Bad Request: message is too long"));
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 3 });
    await expect(transport.sendText(1, "<b>hi</b>")).rejects.toThrow(/message is too long/);

    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx answer per retryCount", async () => {
    const stub = vi.fn(async () => httpError(502, "Bad Gateway"));
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 2 });
    await expect(transport.sendText(1, "hello")).rejects.toThrow(/Bad Gateway/);

    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 answer per retryCount", async () => {
    const stub = vi.fn(async () => httpError(429, "Too Many Requests: retry later", 0));
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport, setConfig } = makeTransport();
    setConfig({ botToken: "tok", retryCount: 2 });
    await expect(transport.sendText(1, "hello")).rejects.toThrow(/Too Many Requests/);

    expect(stub).toHaveBeenCalledTimes(3);
  });
});

describe("createTelegramTransport — Rich Messages (native Markdown tables)", () => {
  let originalFetch: FetchImpl;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logDir: string;
  const table = "| Project | Status |\n| --- | --- |\n| dsh-im | Installed |";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logDir = freshLogDir();
    __resetSinkForTests();
    initLogger({ dir: logDir, level: "debug" });
    // The capability probe is process-wide; each test starts from "available".
    __resetRichMessagesForTests();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
    __resetRichMessagesForTests();
    await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("sends rich_message.markdown through sendRichMessage with topic/reply context", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) });
      return telegramResponse(true, { message_id: 42 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    const sent = await transport.sendText(123, "<b>Project</b>", 456, 789, table);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendRichMessage");
    expect(calls[0].body).toMatchObject({
      chat_id: 123,
      message_thread_id: 456,
      reply_parameters: { message_id: 789 },
      rich_message: { markdown: table },
    });
    expect(calls[0].body.parse_mode).toBeUndefined();
    expect(sent).toEqual([{ message_id: 42 }]);
  });

  it("falls back to the HTML send when the Rich call is rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) });
      return String(url).includes("sendRichMessage")
        ? telegramResponse(false, undefined, "Bad Request: can't parse rich message")
        : telegramResponse(true, { message_id: 7 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    const sent = await transport.sendText(1, "<b>Project</b>", undefined, undefined, table);

    expect(sent).toEqual([{ message_id: 7 }]);
    expect(calls.map((call) => call.url.split("/").pop())).toEqual(["sendRichMessage", "sendMessage"]);
    expect(calls[1].body).toMatchObject({ parse_mode: "HTML", text: "<b>Project</b>" });
    const logText = await readTodayLog(logDir);
    expect(logText).toMatch(/Rich Message rejected/);
  });

  it("stops attempting Rich after a server reports the method is unknown", async () => {
    const calls: string[] = [];
    const stub = vi.fn(async (url: string) => {
      const method = String(url).split("/").pop()!;
      calls.push(method);
      return method === "sendRichMessage"
        ? telegramResponse(false, undefined, "Not Found")
        : telegramResponse(true, { message_id: 7 });
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    await transport.sendText(1, "<b>a</b>", undefined, undefined, table);
    await transport.sendText(1, "<b>b</b>", undefined, undefined, table);

    // Only the first send probes the unsupported method; the second goes
    // straight to the HTML path.
    expect(calls).toEqual(["sendRichMessage", "sendMessage", "sendMessage"]);
    const logText = await readTodayLog(logDir);
    expect(logText).toMatch(/Rich Messages are not supported/);
  });

  it("edits an existing placeholder with rich_message", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) });
      return telegramResponse(true, true);
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    await transport.editText(1, 10, "<b>Project</b>", table);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/editMessageText");
    expect(calls[0].body).toMatchObject({
      chat_id: 1,
      message_id: 10,
      rich_message: { markdown: table },
    });
  });

  it("falls back to the HTML edit when the Rich edit is rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init.body as string) });
      return calls.length === 1
        ? telegramResponse(false, undefined, "Bad Request: rich message is too long")
        : telegramResponse(true, true);
    });
    globalThis.fetch = stub as unknown as FetchImpl;

    const { transport } = makeTransport();
    await transport.editText(1, 10, "<b>Project</b>", table);

    expect(calls.map((call) => call.url.split("/").pop())).toEqual(["editMessageText", "editMessageText"]);
    expect(calls[1].body).toMatchObject({ parse_mode: "HTML", text: "<b>Project</b>" });
  });
});