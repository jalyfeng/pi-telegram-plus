#!/usr/bin/env node
/**
 * Mock Telegram Bot API server for isolated end-to-end acceptance runs.
 *
 * Implements only the surface pi-telegram-plus actually calls, so the plugin can be
 * exercised without touching the real Telegram service. Incoming updates are pushed by
 * the test driver through a control endpoint; every outbound API call is appended to a
 * JSONL log that the driver asserts against.
 *
 * Control endpoints (never hit by the plugin):
 *   POST /_control/inject   { "updates": [ ... ] }  queue updates for getUpdates
 *   GET  /_control/log                              read the JSONL call log
 *   GET  /_control/state                            read counters + queued updates
 *   POST /_control/delay   { "method", "ms", "withReplyMarkup"? }
 *                                                   hold matching calls for ms before replying;
 *                                                   { "ms": 0 } clears the rule (slow-network probe)
 *   POST /_control/reset                            clear log + queue + delay rule
 *
 * Usage: node mock-telegram.mjs [--port 9900] [--log /tmp/x/telegram.jsonl]
 */
import { createServer } from "node:http";
import { validateTelegramCall } from "./telegram-contract.mjs";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const PORT = Number(argValue("--port", "9900"));
const LOG_PATH = argValue("--log", "/tmp/pitg-e2e/telegram.jsonl");
const BOT_USERNAME = argValue("--username", "pi_tg_e2e_bot");

mkdirSync(dirname(LOG_PATH), { recursive: true });
writeFileSync(LOG_PATH, "");

/** Queued updates waiting to be delivered by the next getUpdates call. */
let pendingUpdates = [];
/** Every API call the plugin made, in order. */
const calls = [];
/**
 * getUpdates poll count, tracked outside `calls`.
 *
 * Long-poll requests are issued continuously and would flood the JSONL log, so they are
 * only logged when they actually deliver a batch. Counting them here still lets the
 * driver prove the polling loop engaged before any message was injected.
 */
let getUpdatesPolls = 0;
/**
 * Slow-network rule: calls matching `method` (and, when `withReplyMarkup`, carrying a
 * reply_markup) are recorded on arrival and then held for `ms` before the reply is sent.
 */
let delayRule = null;

function record(entry) {
  calls.push(entry);
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break the mock.
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, result) {
  json(res, 200, { ok: true, result });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Best-effort parse: JSON bodies are structured, multipart uploads stay raw text. */
function parseBody(buf, contentType) {
  const text = buf.toString("utf8");
  if ((contentType ?? "").includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return { _raw: text.slice(0, 512), _bytes: buf.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // ── Control plane ─────────────────────────────────────────────────────
  if (path.startsWith("/_control/")) {
    const raw = await readBody(req);
    if (path === "/_control/inject") {
      let parsed = {};
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return json(res, 400, { ok: false, error: "invalid JSON" });
      }
      const updates = parsed.updates ?? [];
      pendingUpdates.push(...updates);
      record({ ts: Date.now(), direction: "inject", count: updates.length, updates });
      return ok(res, { queued: pendingUpdates.length });
    }
    if (path === "/_control/log") {
      return json(res, 200, {
        calls,
        pending: pendingUpdates.length,
        getUpdatesPolls,
        file: existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "",
      });
    }
    if (path === "/_control/state") {
      return ok(res, {
        calls: calls.length,
        pending: pendingUpdates.length,
        getUpdatesPolls,
        methods: calls.filter((c) => c.direction === "out").map((c) => c.method),
      });
    }
    if (path === "/_control/delay") {
      let parsed = {};
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return json(res, 400, { ok: false, error: "invalid JSON" });
      }
      const ms = Number(parsed.ms ?? 0);
      delayRule = ms > 0 && typeof parsed.method === "string"
        ? { method: parsed.method, ms, withReplyMarkup: parsed.withReplyMarkup === true }
        : null;
      return ok(res, { delay: delayRule });
    }
    if (path === "/_control/reset") {
      pendingUpdates = [];
      calls.length = 0;
      getUpdatesPolls = 0;
      delayRule = null;
      writeFileSync(LOG_PATH, "");
      return ok(res, { reset: true });
    }
    return json(res, 404, { ok: false, error: "unknown control endpoint" });
  }

  // ── File download endpoint: /file/bot<token>/<file_path> ──────────────
  if (path.startsWith("/file/bot")) {
    record({ ts: Date.now(), direction: "out", method: "downloadFile", path });
    const payload = Buffer.from("E2E_ATTACHMENT_PAYLOAD");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
    return res.end(payload);
  }

  // ── Bot API: /bot<token>/<method> ─────────────────────────────────────
  const match = path.match(/^\/bot([^/]+)\/(.+)$/);
  if (!match) {
    record({ ts: Date.now(), direction: "out", method: "UNKNOWN", path });
    return json(res, 404, { ok: false, description: `unknown path ${path}` });
  }

  const [, token, method] = match;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers["content-type"]);

  // getUpdates must not be logged as a normal call — it is called in a tight long-poll
  // loop and would flood the log.
  if (method === "getUpdates") {
    getUpdatesPolls += 1;
    const offset = typeof body === "object" && body !== null ? body.offset : undefined;
    const timeoutSec = Math.min(Number(body?.timeout ?? 30) || 30, 3);
    const deadline = Date.now() + timeoutSec * 1000;

    // Telegram confirms an update as soon as a request arrives with a HIGHER offset, so
    // an update leaves the queue only when it falls strictly below the requested offset.
    // Delivering a batch is not what consumes it: `offset: 0` returns the whole backlog
    // and confirms none of it, which the startup cursor probe relies on.
    if (typeof offset === "number") {
      pendingUpdates = pendingUpdates.filter((u) => u.update_id >= offset);
    }

    while (pendingUpdates.length === 0 && Date.now() < deadline) {
      if (res.destroyed) return;
      await sleep(100);
    }
    if (res.destroyed) return;

    const batch = pendingUpdates;
    if (batch.length > 0) {
      record({
        ts: Date.now(),
        direction: "out",
        method: "getUpdates",
        token,
        delivered: batch.map((u) => u.update_id),
        texts: batch.map((u) => u.message?.text).filter(Boolean),
      });
    }
    return ok(res, batch);
  }

  // The real API rejects malformed payloads with 400; refusing them here keeps
  // the acceptance from passing on messages Telegram would never accept.
  const violations = validateTelegramCall({ method, body });
  if (violations.length > 0) {
    record({ ts: Date.now(), direction: "out", method, token, body, rejected: violations });
    res.writeHead(400, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: ${violations[0]}` }));
    return;
  }

  const resultMessageId = method === "sendMessage" || method === "editMessageText"
    ? 1000 + calls.length + 1
    : undefined;
  record({
    ts: Date.now(),
    direction: "out",
    method,
    token,
    body,
    ...(resultMessageId === undefined ? {} : { message_id: resultMessageId }),
  });

  if (delayRule && delayRule.method === method
    && (!delayRule.withReplyMarkup || body?.reply_markup !== undefined)) {
    await sleep(delayRule.ms);
  }

  switch (method) {
    case "getMe":
      return ok(res, {
        id: 424242,
        is_bot: true,
        first_name: "pi-tg E2E",
        username: BOT_USERNAME,
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      });
    case "deleteWebhook":
    case "setMyCommands":
    case "sendChatAction":
    case "answerCallbackQuery":
    case "deleteMessage":
    case "setMessageReaction":
      return ok(res, true);
    case "sendMessage":
    case "editMessageText":
      return ok(res, {
        message_id: 1000 + calls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body?.chat_id ?? 1, type: "private" },
        text: body?.text ?? "",
      });
    case "sendDocument":
    case "sendPhoto":
      return ok(res, {
        message_id: 1000 + calls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private" },
      });
    case "getFile":
      return ok(res, {
        file_id: body?.file_id ?? "file",
        file_unique_id: "unique",
        file_size: 21,
        file_path: "documents/e2e-fixture.txt",
      });
    default:
      // Unknown methods succeed: the plugin treats non-ok as a hard error and retries,
      // which would mask the assertion we actually care about.
      return ok(res, true);
  }
});

/**
 * Keep-alive must outlive the driver's idle gaps.
 *
 * A matrix run spends ~60s in `npm install` between versions while the driver holds a
 * pooled keep-alive socket. Node's default 5s `keepAliveTimeout` closes that socket
 * server-side, and the next driver request on the reused socket fails with
 * `read ECONNRESET` — which looks like a plugin failure but is pure HTTP plumbing.
 */
server.keepAliveTimeout = 600_000;
server.headersTimeout = 610_000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MOCK_TELEGRAM_READY port=${PORT} log=${LOG_PATH}`);
});

server.on("error", (error) => {
  console.error(`MOCK_TELEGRAM_ERROR ${error.code ?? ""} ${error.message}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
}
