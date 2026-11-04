#!/usr/bin/env node
/**
 * Focused /login scenario on real pi: isolated tmux + pi with the plugin + mock
 * Bot API + mock provider. Opens /login, taps "Sign in with an API key", then
 * taps the first provider and checks that the key prompt (with Cancel) arrives
 * on the same message. Runs with plugin debug logging so the agent log holds the
 * broker and key records for the same taps.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-login-select.mjs [--pi-bin <path>]
 *     [--tg-port 9962] [--provider-port 9963] [--root /tmp/pitg-login-select] [--keep]
 *
 * Exit code is non-zero when a step fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const KEEP = process.argv.includes("--keep");
const TG_PORT = Number(argValue("--tg-port", "9962"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9963"));
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const ROOT = argValue("--root", "/tmp/pitg-login-select");
const STEP_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

async function control(path, init) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, {
    ...init,
    headers: { connection: "close", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const controlGet = () => control("/_control/log");
const controlPost = (path, body) => control(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

async function waitFor(label, predicate, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet();
      const value = predicate(last);
      if (value) return value === true ? last : value;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const wasRejected = (call) => Array.isArray(call?.rejected) && call.rejected.length > 0;
const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const DIALOG_CANCEL = /^tgplus:dlg:[^:]+:\d+:x$/;
const isNav = (button) => /^tgplus:dlg:[^:]+:\d+:p(?::|$)/.test(String(button.callback_data ?? ""));
const isCancel = (button) => DIALOG_CANCEL.test(String(button.callback_data ?? ""));
const choicesOf = (call) => buttonsOf(call).filter((b) => !isNav(b) && !isCancel(b) && !/^\d+\/\d+$/.test(String(b.text ?? "")));
const RESPONSE_METHODS = new Set(["sendMessage", "sendPhoto", "sendDocument", "editMessageText", "editMessageReplyMarkup"]);

/** Latest state of one Telegram message, folded from every later send and edit of it. */
const foldState = (calls, messageId) => {
  let current;
  for (const entry of calls) {
    if (wasRejected(entry) || !entry.body) continue;
    if (entry.method === "sendMessage") {
      if (entry.message_id !== messageId) continue;
      current = { text: String(entry.body.text ?? ""), rows: entry.body.reply_markup?.inline_keyboard ?? [] };
    } else if (entry.method === "editMessageText" || entry.method === "editMessageReplyMarkup") {
      if (entry.body.message_id !== messageId) continue;
      current = {
        text: entry.method === "editMessageText" ? String(entry.body.text ?? "") : (current?.text ?? ""),
        rows: entry.body.reply_markup?.inline_keyboard ?? [],
      };
    }
  }
  return current
    ? { method: "sendMessage", message_id: messageId, body: { message_id: messageId, text: current.text, reply_markup: { inline_keyboard: current.rows } } }
    : undefined;
};
const latestState = async (messageId) => foldState((await controlGet()).calls, messageId);
const awaitMessage = (label, messageId, predicate, timeoutMs = STEP_TIMEOUT_MS) => waitFor(label, (state) => {
  const current = foldState(state.calls, messageId);
  return current && predicate(current) ? current : false;
}, timeoutMs);

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
}

function seed(runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] },
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{ id: "pi-bot", name: "pi", token: "333333:LOGIN_TOKEN", allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}` }],
    defaultBotId: "pi-bot",
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: "pi-bot", enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function startHost(projectDir, agentDir, paneLog, session) {
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_TELEGRAM_PLUS_LOG_LEVEL: "debug",
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = [PI_CLI, "--no-skills", "--no-extensions", "-e", PLUGIN, "--provider", "mock", "--model", "mock-model"];
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  const result = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
  if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${shq(paneLog)}`);
  return result;
}

async function main() {
  const steps = [];
  const record = (name, ok, detail = "") => {
    steps.push({ name, ok });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  };
  const summarize = (message) => `text: "${String(message?.body?.text ?? "").replace(/\s+/g, " ").slice(0, 120)}" buttons: ${buttonsOf(message).map((b) => b.text).join(" / ") || "(none)"}`;

  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(`${label} port ${port} is in use (${error.code})`)));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
  ];
  let mockOut = "";
  for (const mock of mocks) mock.stdout.on("data", (d) => { mockOut += d.toString(); });
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline && !(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    await sleep(200);
  }
  if (!(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) throw new Error(`mocks not ready: ${mockOut}`);

  const session = "pitg-login-select";
  const runDir = join(ROOT, "run");
  const paneLog = join(runDir, "pane.log");
  killSession(session);
  mkdirSync(runDir, { recursive: true });
  const { agentDir, projectDir } = seed(runDir);
  const start = startHost(projectDir, agentDir, paneLog, session);
  record("start pi in tmux", start.status === 0, start.stderr?.trim() || session);

  let updateId = 5000;
  let messageId = 9000;
  const injectMessage = async (text) => {
    const id = messageId++;
    await controlPost("/_control/inject", { updates: [{
      update_id: updateId++,
      message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" }, text },
    }] });
    return id;
  };
  const injectCallback = async (data, targetMessageId) => {
    const callbackId = `cb-${updateId}`;
    await controlPost("/_control/inject", { updates: [{
      update_id: updateId++,
      callback_query: {
        id: callbackId, from: { id: 42, is_bot: false, first_name: "E2E" },
        message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
        chat_instance: "e2e", data,
      },
    }] });
    return callbackId;
  };
  const cursor = async () => (await controlGet()).calls.length;
  const click = async (button, targetMessageId) => {
    const since = await cursor();
    const callbackId = await injectCallback(String(button.callback_data), targetMessageId);
    await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId));
    await sleep(1500);
    return { since, toast: (await controlGet()).calls.find((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId)?.body?.text };
  };

  try {
    await waitFor("plugin authenticates", (state) => state.calls.some((c) => c.method === "getMe"), 60_000);
    record("plugin authenticates", true);
    await waitFor("BotMenu published", (state) => state.calls.some((c) => c.method === "setMyCommands" && Array.isArray(c.body?.commands) && c.body.commands.length > 20), 30_000);
    await sleep(3000);

    const since = await cursor();
    const injected = await injectMessage("/login");
    const ack = await waitFor("reply to /login", (state) => state.calls.slice(since).find((entry) =>
      entry.method === "sendMessage" && !wasRejected(entry) && entry.body?.reply_parameters?.message_id === injected) ?? false);
    const loginId = ack.message_id;
    const menu = await awaitMessage("auth method menu", loginId, (cur) => choicesOf(cur).length > 0, 20_000);
    console.log(`  menu before tap: ${summarize(menu)}`);

    const apiKey = choicesOf(menu).find((b) => /api ?key/i.test(String(b.text ?? "")));
    if (!apiKey) throw new Error(`no API-key button: ${choicesOf(menu).map((b) => b.text).join(" / ")}`);
    const tap1 = await click(apiKey, loginId);
    console.log(`  tap 1 (${apiKey.text}) toast: ${tap1.toast ?? "(none)"}`);
    const afterTap1 = await latestState(loginId);
    console.log(`  after tap 1: ${summarize(afterTap1)}`);
    const providers = await latestState(loginId);
    const providerList = choicesOf(providers).find((b) => /DeepSeek/i.test(String(b.text ?? ""))) ?? choicesOf(providers)[0];
    const reachedProviders = choicesOf(providers).length > 0 && !choicesOf(providers).some((b) => /api ?key/i.test(String(b.text ?? "")));
    record("tap 1 shows the API-key provider list", reachedProviders, summarize(providers));

    if (providerList) {
      const tap2 = await click(providerList, loginId);
      console.log(`  tap 2 (${providerList.text}) toast: ${tap2.toast ?? "(none)"}`);
      const prompt = await latestState(loginId);
      console.log(`  after tap 2: ${summarize(prompt)}`);
      record("tap a provider shows key prompt with Cancel", buttonsOf(prompt).some(isCancel) && /key/i.test(String(prompt?.body?.text ?? "")), summarize(prompt));
    }
  } catch (error) {
    record("scenario", false, String(error.message).slice(0, 300));
  } finally {
    await sleep(1000);
    const logDir = join(agentDir, "logs");
    const logFiles = (() => { try { return readdirSync(logDir).filter((f) => f.startsWith("pi-telegram-plus-")); } catch { return []; } })();
    console.log(`  agent log dir: ${logDir} files: ${logFiles.join(", ") || "(none)"}`);
    const paneText = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    console.log(`  pane tail:\n${paneText.split("\n").filter((l) => l.trim()).slice(-12).join("\n")}`);
    if (!KEEP) killSession(session);
    for (const mock of mocks) mock.kill();
  }
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
