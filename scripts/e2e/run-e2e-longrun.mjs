#!/usr/bin/env node
/**
 * Long-run acceptance for issue #19: no wrapper stacking, and `/tg` plus the
 * dialogs keep working after a long session.
 *
 * Host side: the plugin runs with `PITG_HOOK_STATS` set, so `lib/tui/hooks.ts`
 * appends one JSON line per minute (cumulative and per-window wrapper creation
 * counts, the deepest plugin-wrapper chain on any live slot). This driver only
 * reads that file; it cannot see the host's memory.
 *
 * OMP (--host omp, default 12 minutes): every 45 s a Telegram message triggers
 * the `ask` tool, answered from Telegram; every 90 s `/model` is opened from
 * Telegram and cancelled. At the end `/tg` is typed into the TUI pane.
 *
 * pi (--host pi): 15 `/new` and 5 `/reload` cycles from Telegram, each waited
 * for, with one extension `select` (probe extension `/probe-select`) answered
 * from Telegram between cycles. At the end `/tg` is typed into the TUI pane.
 *
 * Stack: real OMP / pi in tmux + mock Bot API + mock provider, all state under
 * the run root (PITG_L1_ROOT, default /tmp/pitg-l1, suffixed with the host).
 *
 * Usage:
 *   node scripts/e2e/run-e2e-longrun.mjs --host omp|pi [--minutes 12]
 *     [--pi-new 15] [--pi-reload 5] [--tg-port 9962] [--provider-port 9963]
 *     [--timeout 40] [--keep] [--pi-bin <path>] [--omp <path>]
 *
 * Exit code is non-zero when any check fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const PROBE_EXTENSION = join(REPO, "scripts", "e2e", "probe-extension.ts");
const E2E = join(REPO, "scripts", "e2e");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const HOST = argValue("--host", "omp");
const KEEP = process.argv.includes("--keep");
const MINUTES = Number(argValue("--minutes", "12"));
const PI_NEW = Number(argValue("--pi-new", "15"));
const PI_RELOAD = Number(argValue("--pi-reload", "5"));
const TG_PORT = Number(argValue("--tg-port", "9962"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9963"));
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "40")) * 1000;
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const ROOT = `${process.env.PITG_L1_ROOT || "/tmp/pitg-l1"}-${HOST}`;
const SESSION = `pitg-l1-${HOST}`;
const STACK_ERROR = "Maximum call stack size exceeded";
const ASK_EVERY_MS = 45_000;
const MODEL_EVERY_MS = 90_000;

if (HOST !== "omp" && HOST !== "pi") throw new Error(`--host must be omp or pi, got ${HOST}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

// Injected update ids must keep rising (see run-e2e-dialogs.mjs).
let nextUpdateId = 6_000_000;
const injectedUpdateId = () => nextUpdateId++;

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const isDrivable = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:"));
const findButton = (call, pattern) => buttonsOf(call).find((b) => pattern.test(String(b.text ?? "")));
const CANCEL_TEXT = /^\s*(✖|✕|❌|⨯)?\s*cancel\b/i;
const isCancelButton = (b) => /^tgplus:dlg:[^:]+:\d+:x$/.test(String(b.callback_data ?? "")) || CANCEL_TEXT.test(String(b.text ?? ""));

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  tmux("kill-session", "-t", session);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function startServer(script, args) {
  const proc = spawn("node", [join(E2E, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d.toString(); });
  proc.stderr.on("data", (d) => { buf += d.toString(); });
  return { proc, getOutput: () => buf };
}

async function controlRequest(path, init, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, {
        ...init,
        headers: { connection: "close", ...(init?.headers ?? {}) },
      });
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`control request ${path} failed after ${attempts} attempts: ${lastError}`);
}
const controlGet = (path = "/_control/log") => controlRequest(path, { method: "GET" });
const controlPost = (path, body) => controlRequest(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

async function waitFor(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = predicate(await controlGet());
      if (value) return value;
    } catch {
      // control API busy: retry
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const providerEntries = () => {
  const path = join(ROOT, "provider.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return {}; } });
};
/** A provider request whose last message is a tool result: the answer reached the model. */
const toolResultSince = (before) => providerEntries().slice(before)
  .some((entry) => entry.lastRole === "tool" || entry.lastRole === "toolResult");

function seed(runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(join(agentDir, "logs"), { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (HOST === "pi") {
    // clearDialog() sends Escape twice; with an empty editor pi would open the Session Tree.
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
          api: "openai-completions",
          apiKey: "mock",
          models: [{ id: "mock-model" }],
        },
      },
    }, null, 2) + "\n");
  } else {
    writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\ndoubleEscapeAction: none\n");
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock", "    api: openai-completions", "    models:",
      "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768",
      "        maxTokens: 4096", "",
    ].join("\n"));
  }
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{
      id: `${HOST}-bot`, name: HOST,
      token: `${HOST === "pi" ? "555555" : "666666"}:LONGRUN_TOKEN`,
      allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${HOST}-bot`,
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${HOST}-bot`, enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function hostArgs(pluginArgs) {
  return HOST === "omp"
    ? [OMP_CLI, ...pluginArgs, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules",
       "--no-lsp", "--approval-mode", "write", "--no-title"]
    : [PI_CLI, "--no-skills", "--no-extensions", ...pluginArgs, "--provider", "mock", "--model", "mock-model"];
}

function scanForStackError(agentDir) {
  const hits = [];
  const check = (path) => {
    try {
      if (readFileSync(path, "utf8").includes(STACK_ERROR)) hits.push(path);
    } catch {
      // unreadable or not text: skip
    }
  };
  check(join(ROOT, "telegram.jsonl"));
  const logs = join(agentDir, "logs");
  if (existsSync(logs)) for (const name of readdirSync(logs)) check(join(logs, name));
  return hits;
}

function analyseStats(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  // A leftover run holding these ports would steal the injected updates.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another run is likely alive`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }

  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(ROOT, { recursive: true });
  const runDir = ROOT;
  const statsPath = join(runDir, "hook-stats.jsonl");
  const servers = [
    startServer("mock-telegram.mjs", ["--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")]),
    startServer("mock-provider.mjs", ["--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"), "--reply", "MOCK_OK"]),
  ];
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok: Boolean(ok), detail });
    log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  };
  const counters = {};
  const bump = (key, by = 1) => { counters[key] = (counters[key] ?? 0) + by; };

  const session = SESSION;
  let agentDir;
  let projectDir;
  try {
    await sleep(1_200);
    await controlGet("/_control/state");
    await controlPost("/_control/reset");
    ({ agentDir, projectDir } = seed(runDir));
    killSession(session);

    const stubBin = join(runDir, "bin");
    mkdirSync(stubBin, { recursive: true });
    for (const name of ["open", "xdg-open"]) {
      const stub = join(stubBin, name);
      writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${join(runDir, "open-calls.log")}"\nexit 0\n`);
      chmodSync(stub, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
      PI_OFFLINE: "1",
      TMPDIR: join(runDir, "tmp"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      PITG_HOOK_STATS: statsPath,
      PI_GOAL_AUTO_CONFIRM: "0",
    };
    mkdirSync(env.TMPDIR, { recursive: true });
    const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const pluginArgs = ["-e", PLUGIN, "-e", PROBE_EXTENSION];
    const command = `cd ${shq(projectDir)} && export PATH=${shq(env.PATH)} && exec ${hostArgs(pluginArgs).map(shq).join(" ")}`;
    const started = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
    if (started.status !== 0) throw new Error(`failed to start ${HOST}: ${started.stderr}`);
    log(`${HOST} started in tmux session ${session}`);

    const clearDialog = async () => {
      tmux("send-keys", "-t", session, "Escape");
      await sleep(400);
      tmux("send-keys", "-t", session, "Escape");
      await sleep(600);
    };
    const cursor = async () => (await controlGet()).calls.length;
    const injectText = (text) => controlPost("/_control/inject", {
      updates: [{
        update_id: injectedUpdateId(),
        message: {
          message_id: 8000 + Math.floor(Math.random() * 1e6),
          date: Math.floor(Date.now() / 1000),
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "E2E" },
          text,
        },
      }],
    });
    /** Press a button on a message; true when the plugin acknowledged the press. */
    const clickButton = async (button, targetMessageId) => {
      const callbackId = `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await controlPost("/_control/inject", {
        updates: [{
          update_id: injectedUpdateId(),
          callback_query: {
            id: callbackId,
            from: { id: 42, is_bot: false, first_name: "E2E" },
            message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
            chat_instance: "longrun",
            data: String(button.callback_data),
          },
        }],
      });
      return waitFor(`callback acknowledged: ${button.text}`, (state) =>
        state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId),
      { timeoutMs: 15_000 }).then(() => true).catch(() => false);
    };
    /** The newest drivable keyboard sent after `since` whose buttons satisfy `pick`. */
    const keyboardSince = (calls, since, pick) => calls.slice(since)
      .findLast((c) => Array.isArray(rowsOf(c)) && isDrivable(c) && pick(buttonsOf(c)));
    const waitKeyboard = (label, since, pick, timeoutMs = 30_000) => waitFor(label,
      (state) => keyboardSince(state.calls, since, pick) ?? false, { timeoutMs }).catch(() => undefined);
    const waitText = (label, since, pattern, timeoutMs = 60_000) => waitFor(label,
      (state) => state.calls.slice(since).find((c) =>
        (c.method === "sendMessage" || c.method === "editMessageText") && pattern.test(String(c.body?.text ?? ""))) ?? false,
    { timeoutMs }).catch(() => undefined);
    const keyboardGone = (messageId, timeoutMs = 15_000) => waitFor("keyboard removed", (state) =>
      state.calls.findLast((c) => c.body?.message_id === messageId
        && (c.method === "editMessageText" || c.method === "editMessageReplyMarkup")
        && rowsOf(c) !== undefined && rowsOf(c).length === 0) ?? false,
    { timeoutMs }).then(() => true).catch(() => false);
    const paneText = () => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");

    // ── startup ───────────────────────────────────────────────────────────
    await waitFor("getMe", (state) => state.calls.some((c) => c.method === "getMe"), { timeoutMs: 90_000 });
    await sleep(2_000);
    await clearDialog();
    {
      const since = await cursor();
      await injectText("reply with the single word warmup");
      const replied = await waitText("warmup reply", since, /MOCK_OK/, 60_000);
      if (!replied) throw new Error("no warmup reply from the provider");
    }
    await clearDialog();
    const startedAt = Date.now();
    record("plugin authenticated and model round trip", true);

    if (HOST === "omp") {
      // ── OMP: ask every 45 s, /model every 90 s, for MINUTES ────────────
      const endAt = startedAt + MINUTES * 60_000;
      let nextModelAt = startedAt + MODEL_EVERY_MS;
      let consecutiveFailures = 0;
      for (let round = 0; ; round += 1) {
        const dueAt = startedAt + round * ASK_EVERY_MS;
        if (dueAt >= endAt) break;
        if (dueAt > Date.now()) await sleep(dueAt - Date.now());
        bump("askAttempted");
        const askOk = await (async () => {
          const since = await cursor();
          const providerBefore = providerEntries().length;
          await injectText(`please run the probe ASK_TOOL_PROBE run-${round}`);
          const kb = await waitKeyboard(`ask keyboard ${round}`, since,
            (buttons) => buttons.some((b) => /green/i.test(String(b.text ?? ""))));
          if (!kb) return { ok: false, detail: "no ask keyboard with a green option" };
          const green = findButton(kb, /green/i);
          const messageId = kb.body?.message_id ?? kb.message_id;
          if (!await clickButton(green, messageId)) return { ok: false, detail: "green press not acknowledged" };
          // Single-select asks may need a Submit press before the answer is sent.
          let answered = await waitFor(`ask answer ${round}`, () => toolResultSince(providerBefore), { timeoutMs: 8_000 })
            .then(() => true).catch(() => false);
          if (!answered) {
            const latest = (await controlGet()).calls.slice(since)
              .findLast((c) => Array.isArray(rowsOf(c)) && isDrivable(c));
            const submit = latest && findButton(latest, /submit|done|enter|confirm/i);
            if (submit && await clickButton(submit, latest.body?.message_id ?? latest.message_id)) {
              answered = await waitFor(`ask answer after submit ${round}`, () => toolResultSince(providerBefore), { timeoutMs: 20_000 })
                .then(() => true).catch(() => false);
            }
          }
          return answered ? { ok: true, detail: "green answered, tool result reached the model" }
            : { ok: false, detail: "tool result never reached the model" };
        })().catch((error) => ({ ok: false, detail: String(error.message).slice(0, 200) }));
        if (askOk.ok) bump("dialogsAnswered");
        else { bump("askFailed"); record(`ask ${round} answered from Telegram`, false, askOk.detail); }
        consecutiveFailures = askOk.ok ? 0 : consecutiveFailures + 1;

        if (Date.now() >= nextModelAt) {
          nextModelAt += MODEL_EVERY_MS;
          bump("modelAttempted");
          const since = await cursor();
          await injectText("/model");
          const kb = await waitKeyboard("/model picker", since, (buttons) => buttons.some(isCancelButton), 30_000);
          if (!kb) {
            bump("modelFailed");
            record("/model picker opens and cancels from Telegram", false, "no picker with a cancel button");
            consecutiveFailures += 1;
          } else {
            const cancel = buttonsOf(kb).find(isCancelButton);
            const messageId = kb.body?.message_id ?? kb.message_id;
            if (await clickButton(cancel, messageId)) bump("modelCancelled");
            else { bump("modelFailed"); record("/model cancel from Telegram", false, "cancel press not acknowledged"); }
          }
        }
        if (consecutiveFailures >= 3) {
          record("OMP dialogs keep answering", false, "three rounds in a row failed; stopping early");
          break;
        }
        log(`omp round ${round} done · dialogs answered ${counters.dialogsAnswered ?? 0} · elapsed ${Math.round((Date.now() - startedAt) / 1000)} s`);
      }
      record("OMP ran for the full duration", Date.now() - startedAt >= MINUTES * 60_000 - ASK_EVERY_MS,
        `${Math.round((Date.now() - startedAt) / 1000)} s`);
    } else {
      // ── pi: 15 /new + 5 /reload from Telegram, one select between cycles ─
      // Interleave: every fourth cycle is a /reload, the rest /new, until the counts are used up.
      const plan = [];
      let newLeft = PI_NEW;
      let reloadLeft = PI_RELOAD;
      for (let i = 0; newLeft + reloadLeft > 0; i += 1) {
        if (reloadLeft > 0 && (i % 4 === 3 || newLeft === 0)) { plan.push("reload"); reloadLeft -= 1; }
        else { plan.push("new"); newLeft -= 1; }
      }
      let consecutiveFailures = 0;
      for (let index = 0; index < plan.length; index += 1) {
        if (index > 0) {
          bump("selectAttempted");
          const since = await cursor();
          await injectText("/probe-select");
          const kb = await waitKeyboard(`select ${index}`, since, (buttons) => buttons.some((b) => /beta/i.test(String(b.text ?? ""))));
          const beta = kb && findButton(kb, /beta/i);
          const ok = Boolean(beta) && await clickButton(beta, kb.body?.message_id ?? kb.message_id)
            && await keyboardGone(kb.body?.message_id ?? kb.message_id);
          if (ok) bump("dialogsAnswered");
          else { bump("selectFailed"); record(`select before cycle ${index + 1} answered from Telegram`, false, kb ? "keyboard not withdrawn" : "no select keyboard"); }
          if (!ok) consecutiveFailures += 1;
        }
        const kind = plan[index];
        bump(kind === "new" ? "newAttempted" : "reloadAttempted");
        const since = await cursor();
        await injectText(kind === "new" ? "/new" : "/reload");
        let ok;
        if (kind === "new") {
          const confirm = await waitKeyboard(`/new confirm ${index}`, since, (buttons) => buttons.some((b) => /yes|confirm|ok/i.test(String(b.text ?? ""))), 30_000);
          if (confirm) {
            await clickButton(findButton(confirm, /yes|confirm|ok/i), confirm.body?.message_id ?? confirm.message_id);
          }
          ok = Boolean(await waitText(`/new result ${index}`, since, /New session started/, 60_000));
        } else {
          ok = Boolean(await waitText(`/reload result ${index}`, since, /Reloaded/, 60_000));
        }
        if (ok) bump(kind === "new" ? "newOk" : "reloadOk");
        else { bump(kind === "new" ? "newFailed" : "reloadFailed"); record(`${kind} cycle ${index + 1} result`, false, "no result message in Telegram"); }
        consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= 3) {
          record("pi cycles keep answering", false, "three cycles in a row failed; stopping early");
          break;
        }
        log(`pi cycle ${index + 1}/${plan.length} (${kind}) ${ok ? "ok" : "FAILED"} · elapsed ${Math.round((Date.now() - startedAt) / 1000)} s`);
      }
    }

    // ── /tg typed into the TUI pane ─────────────────────────────────────────
    {
      const since = await cursor();
      tmux("send-keys", "-t", session, "-l", "/tg");
      tmux("send-keys", "-t", session, "Enter");
      const menu = await waitText("/tg menu after TUI submit", since, /Telegram Management/, 30_000);
      await sleep(3_000);
      const pane = paneText();
      writeFileSync(join(ROOT, "tg-pane.txt"), pane);
      const lines = pane.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      const stackHits = [...(pane.includes(STACK_ERROR) ? ["pane"] : []), ...scanForStackError(agentDir)];
      const paneMenu = /Telegram Management|\/tg/.test(pane);
      record(`${HOST} /tg from the TUI pane shows the menu`, paneMenu && stackHits.length === 0,
        `pane menu ${paneMenu ? "seen" : "missing"} · telegram menu ${menu ? "seen" : "not sent"} · stack error ${stackHits.length ? stackHits.join(",") : "none"} · pane lines ${lines.length}`);
      bump("tgPaneChecked");
    }
    await clearDialog();

    // ── wrapper statistics ─────────────────────────────────────────────────
    const stats = analyseStats(statsPath);
    const maxDepth = stats.reduce((max, line) => Math.max(max, line.maxDepth ?? 0), 0);
    record("hook stats written every minute", stats.length >= 1, `${stats.length} samples`);
    record("no chain deeper than one plugin wrapper", stats.length > 0 && maxDepth <= 1, `max depth ${maxDepth}`);
    if (HOST === "omp") {
      const later = stats.slice(1);
      const lateCreated = later.reduce((sum, line) => sum + (line.createdInWindow ?? 0), 0);
      record("no new wrappers after the first minute (OMP)", later.length > 0 && lateCreated === 0,
        `created per window: ${stats.map((l) => l.createdInWindow).join(", ")}`);
    } else {
      const base = stats[0]?.created ?? 0;
      const total = stats.at(-1)?.created ?? 0;
      const cycles = PI_NEW + PI_RELOAD;
      record("pi wrapper creation bounded by host rebuilds", stats.length > 0 && total <= (cycles + 1) * Math.max(base, 1),
        `created ${total} in total, ${base} in the first window, ${cycles} rebuild cycles`);
    }
    const first = stats[0];
    const last = stats.at(-1);
    log(`hook stats first window: created ${first?.created ?? "-"} live ${first?.liveSlots ?? "-"}; last window: created ${last?.created ?? "-"} live ${last?.liveSlots ?? "-"}`);
    log(`counters ${JSON.stringify(counters)}`);
    const duration = Math.round((Date.now() - startedAt) / 1000);
    log(`${HOST} run duration ${duration} s`);
  } catch (error) {
    record(`${HOST} longrun completes`, false, String(error?.message ?? error).slice(0, 400));
  } finally {
    killSession(session);
    for (const server of servers) server.proc.kill();
    const leftovers = String(tmux("ls").stdout ?? "").split("\n").filter((l) => l.startsWith("pitg-"));
    for (const line of leftovers) killSession(line.split(":")[0]);
    if (!KEEP) rmSync(join(ROOT, "tmp"), { recursive: true, force: true, maxRetries: 3 });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`LONGRUN_${HOST.toUpperCase()}_FAILURES=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
