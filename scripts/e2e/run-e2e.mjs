#!/usr/bin/env node
/**
 * Isolated end-to-end acceptance for pi-telegram-plus.
 *
 * Proves the plugin actually engages the Telegram Bot API through a real pi CLI inside
 * a real terminal (tmux), against a mock Telegram API and a mock OpenAI-compatible
 * provider, with every piece of state confined to /tmp.
 *
 * The assertion chain (each step must be evidenced, not assumed):
 *   1. pi starts in tmux with the plugin loaded via -e and reaches idle.
 *   2. The plugin authenticates against the mock Bot API (getMe) and starts polling.
 *   3. An injected Telegram message is picked up by getUpdates.
 *   4. The plugin drives a pi turn, which reaches the mock provider.
 *   5. The plugin sends the assistant reply back through sendMessage/editMessageText.
 *   6. Restarted with a `lastUpdateId` that is ahead of the bot's stream (the live
 *      failure: re-created bot / reused token / reassigned id sequence), an injected
 *      message is still delivered exactly once and both cursors are rewound. The mock
 *      Bot API drops out-of-range requests exactly as the documented contract requires,
 *      so this step can only pass if the plugin probes the backlog it cannot see.
 *
 * Nothing here contacts the real Telegram service or a real model provider.
 *
 * Usage:
 *   node scripts/e2e/run-e2e.mjs [--pi-bin node_modules/.bin/pi] [--keep] [--timeout 90]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ENTRY = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

// The plugin is accepted against exactly the pi build this repo pins as its peer/dev
// dependency; --pi-bin overrides for local experiments.
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const KEEP = process.argv.includes("--keep");
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "90")) * 1000;
const TG_PORT = Number(argValue("--tg-port", "9940"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9941"));
const BOT_TOKEN = "111111:E2E_MOCK_TOKEN";
const CHAT_ID = 777;
const USER_ID = 777;
/**
 * Step 6 plants this cursor — far above any id the mock will ever issue — and then
 * injects `REWIND_UPDATE_ID` below it, mirroring the live corruption (cursor 636583913
 * while the bot's stream sat at 5413839xx).
 */
const POISONED_CURSOR = 636583913;
const REWIND_UPDATE_ID = 541383987;
const TOKEN_HASH = createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 24);
/**
 * All run state lives under /tmp, deliberately.
 *
 * `os.tmpdir()` resolves to the macOS per-user temp dir, so the acceptance environment
 * is pinned to /tmp to keep it short-lived, outside the repo, and easy to wipe.
 */
const ROOT = process.env.PITG_E2E_ROOT || "/tmp/pitg-e2e";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/**
 * Probe which optional isolation flags a given pi build actually accepts.
 *
 * `--no-mcp` only exists from pi 1.0.0; passing it to 0.8x aborts startup with
 * "Error: Unknown option: --no-mcp" before the extension is ever loaded, which looks
 * exactly like an extension failure. `--no-skills` and `--no-extensions` are stable
 * across the whole tested range.
 */
function supportedFlags(piCli, env) {
  const help = sh(piCli, ["--help"], { env, timeout: 60_000 });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  return { noMcp: /\B--no-mcp\b/.test(text), noSkills: /\B--no-skills\b/.test(text) };
}

/** Seed an isolated PI_CODING_AGENT_DIR + project dir wired to the mocks. */
function seedEnvironment(runDir, tgBase) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });

  // Minimal settings keep the run free of the user's real config; doubleEscapeAction "none" stops a double Escape from opening the Session Tree.
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);

  // OpenAI-compatible mock provider. pi needs a registered provider + model; without
  // SSE the stream aborts with "Stream ended without finish_reason".
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
            api: "openai-completions",
            apiKey: "mock",
            models: [{ id: "mock-model" }],
          },
        },
      },
      null,
      2,
    ),
  );

  // Bot registry: token + apiBase pointed at the mock. allowedUserId is preset so the
  // injected message is already authorized and no /pair round-trip is needed.
  writeFileSync(
    join(agentDir, "tg.json"),
    JSON.stringify(
      {
        version: 3,
        bots: [{ id: "e2e-bot", name: "e2e", token: BOT_TOKEN, allowedUserId: USER_ID, apiBase: tgBase }],
        defaultBotId: "e2e-bot",
      },
      null,
      2,
    ) + "\n",
  );

  // Project binding: enabled, with the chat pre-seeded as active.
  writeFileSync(
    join(projectDir, ".pi", "telegram.json"),
    JSON.stringify({ botId: "e2e-bot", enabled: true, activeChatId: CHAT_ID }, null, 2) + "\n",
  );

  return { agentDir, projectDir };
}

/** Block the current thread for `ms` without spawning a subprocess. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Best-effort recursive delete.
 *
 * A killed pi process can still be flushing its log/state files inside `agent/` when the
 * run finishes, so a plain `rmSync` races it and throws ENOTEMPTY — which previously
 * aborted the whole run partway through. Retry briefly, then give up quietly: leaving
 * a stale temp dir is strictly better than losing the run's evidence.
 */
function removeQuietly(path, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      sleepSync(400 * (attempt + 1));
    }
  }
}

/**
 * Stop the tmux session and wait for pi to actually exit.
 *
 * `tmux kill-session` returns as soon as the client detaches; pi keeps running briefly and
 * may still be writing inside `agent/`. Waiting for the session to disappear from
 * `tmux ls` (plus a short settle) keeps teardown from racing those writes.
 */
function killSession(session) {
  tmux("pipe-pane", "-t", session);
  tmux("kill-session", "-t", session);
  tmux("kill-session", "-t", session);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) break;
    sleepSync(200);
  }
  sleepSync(500);
}

function tmux(...args) {
  return sh("tmux", args);
}

/**
 * Control-plane HTTP with retry.
 *
 * Node's undici keeps connections pooled, and the mock server can idle for the tens of
 * seconds a single E2E step takes to drive pi. If the server closes a pooled socket in that
 * gap, the next request on it fails with `fetch failed` / `ECONNRESET` even though the
 * mock is healthy. Retrying (and disabling keep-alive) keeps that plumbing noise from
 * being reported as a plugin failure.
 */
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

async function controlPost(path, body) {
  return controlRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function controlGet(path) {
  return controlRequest(path, { method: "GET" });
}

/** Wait until predicate(parsedState) is truthy, or throw on timeout. */
async function waitFor(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet("/_control/log");
      const hit = predicate(last);
      if (hit) return last;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}\nlast state: ${JSON.stringify(last, null, 2).slice(0, 3000)}`);
}

function providerLog() {
  const path = join(ROOT, "provider.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function runE2e() {
  const runDir = join(ROOT, "run");
  const session = "pitg-e2e";
  const tgLog = join(ROOT, "telegram.jsonl");
  const provLog = join(ROOT, "provider.jsonl");
  const paneLog = join(runDir, "pane.log");
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  removeQuietly(runDir);
  mkdirSync(runDir, { recursive: true });

  const piCli = PI_CLI;

  const { agentDir, projectDir } = seedEnvironment(runDir, `http://127.0.0.1:${TG_PORT}`);
  await controlPost("/_control/reset");
  writeFileSync(provLog, "");

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  // Interactive pi inside tmux: --print would exit after one turn and we need the
  // extension alive to observe the polling loop.
  tmux("kill-session", "-t", session);
  const flags = supportedFlags(piCli, env);
  const isolationArgs = [
    ...(flags.noMcp ? ["--no-mcp"] : []),
    ...(flags.noSkills ? ["--no-skills"] : []),
    "--no-extensions",
  ];
  const envArgs = Object.entries(env)
    .map(([k, v]) => ["-e", `${k}=${v}`])
    .flat();
  /** Start the plugin inside tmux, capturing the pane to `pane`. */
  const startPlugin = (pane) => {
    const result = tmux(
      "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir,
      ...envArgs,
      piCli, ...isolationArgs, "-e", PLUGIN_ENTRY, "--provider", "mock", "--model", "mock-model",
    );
    if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${pane}`);
    return result;
  };

  const start = startPlugin(paneLog);
  if (start.status !== 0) {
    record("start pi in tmux", false, start.stderr?.trim());
    return { steps, ok: false };
  }
  record("start pi in tmux", true, `${session}${isolationArgs.length ? ` (${isolationArgs.join(" ")})` : " (no extra isolation flags)"}`);

  // ── 1. Plugin authenticates against the mock Bot API ──────────────────
  try {
    await waitFor("getMe (plugin authenticates with mock Bot API)", (s) => s.calls.some((c) => c.method === "getMe"));
    record("plugin authenticates via getMe", true);
  } catch (error) {
    record("plugin authenticates via getMe", false, String(error.message).slice(0, 500));
  }

  // ── 2. Polling engages ────────────────────────────────────────────────
  try {
    const state = await waitFor(
      "getUpdates polling loop",
      (s) => (s.getUpdatesPolls ?? 0) > 0,
    );
    record("polling loop reaches mock", true, `${state.getUpdatesPolls} getUpdates long-poll(s)`);
  } catch (error) {
    record("polling loop reaches mock", false, String(error.message).slice(0, 500));
  }

  // ── 3. Inject a Telegram message and watch it get picked up ───────────
  const promptText = "reply with MOCK_OK";
  try {
    await controlPost("/_control/inject", {
      updates: [
        {
          update_id: 5001,
          message: {
            message_id: 9001,
            date: Math.floor(Date.now() / 1000),
            chat: { id: CHAT_ID, type: "private" },
            from: { id: USER_ID, is_bot: false, first_name: "E2E" },
            text: promptText,
          },
        },
      ],
    });
    const delivered = await waitFor(
      "injected message delivered by getUpdates",
      (s) => s.calls.some((c) => c.method === "getUpdates" && c.texts?.includes(promptText)),
    );
    const hit = delivered.calls.find((c) => c.method === "getUpdates" && c.texts?.includes(promptText));
    record("injected Telegram message picked up", true, `update_id=${hit.delivered?.join(",")}`);
  } catch (error) {
    record("injected Telegram message picked up", false, String(error.message).slice(0, 500));
  }

  // ── 4. pi turn reaches the mock provider ──────────────────────────────
  try {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let seen;
    while (Date.now() < deadline) {
      seen = providerLog().find((e) => (e.prompt?.includes(promptText) || e.userText?.includes(promptText)));
      if (seen) break;
      await sleep(500);
    }
    if (!seen) throw new Error("no provider request carried the Telegram text");
    record("pi turn reached mock provider", true, `model=${seen.model}`);
  } catch (error) {
    record("pi turn reached mock provider", false, String(error.message).slice(0, 500));
  }

  // ── 5. Reply delivered back to Telegram ───────────────────────────────
  try {
    const sent = await waitFor(
      "outbound sendMessage/editMessageText to mock Bot API",
      (s) => s.calls.some((c) => c.method === "sendMessage" || c.method === "editMessageText"),
    );
    const replyCall = sent.calls.find((c) => c.method === "sendMessage" || c.method === "editMessageText");
    const replyText = replyCall.body?.text ?? "";
    const hasMockOk = sent.calls.some(
      (c) =>
        (c.method === "sendMessage" || c.method === "editMessageText")
        && String(c.body?.text ?? "").includes("MOCK_OK"),
    );
    record("reply delivered to Telegram", true, `text=${JSON.stringify(replyText).slice(0, 120)}`);
    record("reply contains provider output (MOCK_OK)", hasMockOk, hasMockOk ? "round-trip verified" : "reply seen but MOCK_OK missing");
  } catch (error) {
    record("reply delivered to Telegram", false, String(error.message).slice(0, 500));
  }

  // ── 6. A foreign cursor must not swallow messages ─────────────────────
  // Plant a `lastUpdateId` above every id the bot will ever see, queue a message far
  // below it, then start the plugin. The mock follows the documented contract and drops
  // requests whose offset is out of range, so the message is unreachable through the
  // normal poll: only the startup backlog probe can reveal the corruption.
  killSession(session);
  await controlPost("/_control/reset");
  writeFileSync(provLog, "");
  const rewindPrompt = "reply with MOCK_OK";
  await controlPost("/_control/inject", {
    updates: [
      {
        update_id: REWIND_UPDATE_ID,
        message: {
          message_id: 9002,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT_ID, type: "private" },
          from: { id: USER_ID, is_bot: false, first_name: "E2E" },
          text: rewindPrompt,
        },
      },
    ],
  });
  const bindingPath = join(projectDir, ".pi", "telegram.json");
  const cursorPath = join(agentDir, "tg-runtime", TOKEN_HASH, "cursor.json");
  writeFileSync(
    bindingPath,
    JSON.stringify({ ...JSON.parse(readFileSync(bindingPath, "utf8")), lastUpdateId: POISONED_CURSOR }, null, 2) + "\n",
  );
  const restart = startPlugin(join(runDir, "pane-rewind.log"));
  record("restart with a foreign lastUpdateId", restart.status === 0, `lastUpdateId=${POISONED_CURSOR}`);

  try {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let binding;
    let cursor;
    let turns = [];
    while (Date.now() < deadline) {
      // The message is only delivered if the plugin rewound the cursor it inherited:
      // the mock deletes anything below the requested offset.
      try {
        binding = JSON.parse(readFileSync(bindingPath, "utf8")).lastUpdateId;
      } catch {
        binding = undefined;
      }
      if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, "utf8")).updateId;
      turns = providerLog().filter((entry) => (entry.prompt?.includes(rewindPrompt) || entry.userText?.includes(rewindPrompt)));
      if (binding === REWIND_UPDATE_ID && cursor === REWIND_UPDATE_ID && turns.length === 1) break;
      await sleep(500);
    }
    record(
      "backlog below the foreign cursor was delivered exactly once",
      turns.length === 1,
      `agent turns=${turns.length}`,
    );
    record(
      "both cursors rewound to the delivered update",
      binding === REWIND_UPDATE_ID && cursor === REWIND_UPDATE_ID,
      `binding=${binding} cursor=${cursor}`,
    );
  } catch (error) {
    record("backlog below the foreign cursor was delivered exactly once", false, String(error.message).slice(0, 500));
  }

  try {
    const logsDir = join(agentDir, "logs");
    const logFile = existsSync(logsDir)
      ? readdirSync(logsDir).filter((name) => name.startsWith("pi-telegram-plus-")).sort().pop()
      : undefined;
    const text = logFile ? readFileSync(join(logsDir, logFile), "utf8") : "";
    const warned = text.includes("poll cursor is ahead of the update stream");
    record("rewind is reported in the plugin log", warned, logFile ?? "no log file");
  } catch (error) {
    record("rewind is reported in the plugin log", false, String(error.message).slice(0, 500));
  }

  killSession(session);

  const failed = steps.filter((s) => !s.ok);
  if (failed.length > 0 && existsSync(paneLog)) {
    console.log(`\n--- tmux pane (last 40 lines) ---`);
    console.log(readFileSync(paneLog, "utf8").split("\n").slice(-40).join("\n"));
  }

  const ok = failed.length === 0;
  if (!KEEP) removeQuietly(runDir);
  return { steps, ok, paneLog };
}

function startServer(name, script, args) {
  const logPath = join(ROOT, `${name}.out`);
  const out = spawn("node", [join(E2E, script), ...args], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  out.stdout.on("data", (d) => { buf += d.toString(); });
  out.stderr.on("data", (d) => { buf += d.toString(); });
  return { proc: out, getOutput: () => buf, logPath };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "provider.jsonl"), "");
  writeFileSync(join(ROOT, "telegram.jsonl"), "");

  // A leftover run holding these ports would silently steal the injected updates: this
  // suite would then read another host's chat. Fail with a name.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive - kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }

  console.log(`pi-telegram-plus E2E acceptance`);
  console.log(`  repo:     ${REPO}`);
  console.log(`  root:     ${ROOT}`);
  console.log(`  pi:       ${PI_CLI}`);
  console.log(`  plugin:   ${PLUGIN_ENTRY}\n`);

  const tg = startServer("mock-telegram", "mock-telegram.mjs", [
    "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl"),
  ]);
  const prov = startServer("mock-provider", "mock-provider.mjs", [
    "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"),
  ]);
  await sleep(1200);
  if (!tg.getOutput().includes("MOCK_TELEGRAM_READY")) throw new Error(`mock telegram failed to start:\n${tg.getOutput()}`);
  if (!prov.getOutput().includes("MOCK_PROVIDER_READY")) throw new Error(`mock provider failed to start:\n${prov.getOutput()}`);
  console.log("mocks ready: telegram + provider\n");

  let result;
  try {
    console.log("=== pi ===");
    result = await runE2e();
  } finally {
    tg.proc.kill();
    prov.proc.kill();
  }

  console.log("=== E2E summary ===");
  console.log(`${result.ok ? "✓" : "✗"} pi`);
  writeFileSync(join(ROOT, "e2e-report.json"), JSON.stringify([result], null, 2) + "\n");

  if (!result.ok) {
    console.log("\nE2E FAILED");
    process.exitCode = 1;
  } else {
    console.log("\nE2E_EXIT=0");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
