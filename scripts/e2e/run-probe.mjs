#!/usr/bin/env node
/**
 * Stage 0 host probe driver (docs/tui-parity-refactor-plan.md §6).
 *
 * Starts the real host TUI in tmux with the plugin and the probe extension,
 * drives every dialog-producing command, and copies the probe's JSON output.
 * Isolated the same way as the acceptance harness: mock Telegram + mock
 * OpenAI-compatible provider, all state under /tmp.
 *
 * Usage:
 *   node scripts/e2e/run-probe.mjs --host pi  [--pi-version 1.4.0] [--out docs/host-probe/pi-1.4.0.json]
 *   node scripts/e2e/run-probe.mjs --host omp [--omp /path/to/omp]   [--out docs/host-probe/omp-18.12.5.json]
 *   node scripts/e2e/run-probe.mjs --host pi --goal confirm --out /tmp/goal-confirm.json
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ENTRY = join(REPO, "index.ts");
const PROBE_EXTENSION = join(REPO, "scripts", "e2e", "probe-extension.ts");
const E2E = join(REPO, "scripts", "e2e");
const ROOT = process.env.PITG_PROBE_ROOT || "/tmp/pitg-probe";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const HOST = argValue("--host", "pi");
const GOAL = argValue("--goal", "");
const APPROVAL = process.argv.includes("--approval");
const KEEP = process.argv.includes("--keep");
const TIMEOUT_MS = Number(argValue("--timeout", "180")) * 1000;
const TG_PORT = Number(argValue("--tg-port", HOST === "omp" ? "9982" : "9980"));
const PROVIDER_PORT = Number(argValue("--provider-port", HOST === "omp" ? "9983" : "9981"));
const OUT = resolve(argValue("--out", join(REPO, "docs", "host-probe", `${HOST}${GOAL ? `-goal-${GOAL}` : ""}.json`)));
const PI_VERSION = argValue("--pi-version", "1.4.0");
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const BOT_TOKEN = `333333:${HOST.toUpperCase()}_PROBE_TOKEN`;
const CHAT_ID = 991;
const USER_ID = 991;
const SESSION = `pitg-probe-${HOST}${GOAL ? `-${GOAL}` : ""}`;
const RUN_DIR = join(ROOT, `run-${HOST}${GOAL ? `-${GOAL}` : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);

function removeQuietly(path, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
    }
  }
}

function killSession(name) {
  tmux("pipe-pane", "-t", name);
  tmux("kill-session", "-t", name);
  tmux("kill-session", "-t", name);
}

function startServer(name, script, args) {
  const proc = spawn("node", [join(E2E, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not become ready\n${output}`)), 30_000);
    const onData = (data) => {
      output += data.toString();
      if (/READY/.test(output)) {
        clearTimeout(timer);
        resolveReady(output);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited ${code}\n${output}`));
    });
  });
  return { proc, ready };
}

function ensurePi(version) {
  const prefix = join(ROOT, `pi-${version}`);
  const pkg = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  if (!existsSync(pkg)) {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: `probe-pi-${version}`, private: true }, null, 2));
    const result = sh("npm", ["install", "--no-save", `@earendil-works/pi-coding-agent@${version}`], {
      cwd: prefix,
      env: {
        ...process.env,
        npm_config_cache: join(ROOT, "npm-cache"),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      },
      timeout: 300_000,
    });
    if (result.status !== 0) throw new Error(`install pi ${version} failed:\n${result.stdout}\n${result.stderr}`);
  }
  const manifest = JSON.parse(readFileSync(pkg, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (!bin) throw new Error(`no bin.pi in ${pkg}`);
  return join(dirname(pkg), bin);
}

function seedEnvironment() {
  const agentDir = join(RUN_DIR, "agent");
  const projectDir = join(RUN_DIR, "project");
  const sessionDir = join(RUN_DIR, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  // clearDialog() sends Escape twice; with an empty editor pi would open the Session Tree.
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
          api: "openai-completions",
          apiKey: "mock",
          models: [{ id: "mock-model" }],
        },
      },
    }, null, 2),
  );
  writeFileSync(
    join(agentDir, "config.yml"),
    "setupVersion: 2\nstartup:\n  setupWizard: false\n",
  );
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  mock:",
      `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock",
      "    api: openai-completions",
      "    models:",
      "      - id: mock-model",
      "        name: Mock Model",
      "        contextWindow: 32768",
      "        maxTokens: 4096",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(agentDir, "tg.json"),
    JSON.stringify({
      version: 3,
      bots: [{ id: "probe-bot", name: "probe", token: BOT_TOKEN, allowedUserId: USER_ID, apiBase: `http://127.0.0.1:${TG_PORT}` }],
      defaultBotId: "probe-bot",
    }, null, 2) + "\n",
  );
  writeFileSync(
    join(projectDir, ".pi", "telegram.json"),
    JSON.stringify({ botId: "probe-bot", enabled: false, activeChatId: CHAT_ID }, null, 2) + "\n",
  );
  return { agentDir, projectDir, sessionDir };
}

function probeDoc(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function waitForProbe(path, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = probeDoc(path);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}\nlast: ${JSON.stringify(last ?? null).slice(0, 2000)}`);
}

function capturePane() {
  return String(tmux("capture-pane", "-p", "-t", SESSION).stdout ?? "");
}

async function sendText(text, settleMs = 900) {
  tmux("send-keys", "-t", SESSION, "-l", text);
  tmux("send-keys", "-t", SESSION, "Enter");
  await sleep(settleMs);
}

async function sendKey(key, settleMs = 500) {
  tmux("send-keys", "-t", SESSION, key);
  await sleep(settleMs);
}

async function runCommand(command, settleMs = 1500) {
  await sendText(command, settleMs);
  await sendKey("Escape");
  await sendKey("Escape");
  await sleep(250);
}

async function main() {
  if (HOST !== "pi" && HOST !== "omp") throw new Error(`--host must be pi or omp, got ${HOST}`);
  killSession(SESSION);
  removeQuietly(RUN_DIR);
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });

  const { agentDir, projectDir, sessionDir } = seedEnvironment();
  const tg = startServer("mock-telegram", "mock-telegram.mjs", [
    "--port", String(TG_PORT), "--log", join(RUN_DIR, "telegram.jsonl"),
  ]);
  const provider = startServer("mock-provider", "mock-provider.mjs", [
    "--port", String(PROVIDER_PORT), "--log", join(RUN_DIR, "provider.jsonl"), "--reply", "PROBE_OK",
  ]);
  await Promise.all([tg.ready, provider.ready]);

  const piCli = HOST === "pi" ? ensurePi(PI_VERSION) : undefined;
  const goalEntry = GOAL
    ? join(ROOT, "..", "pitg-probe-goal", "node_modules", "@capyup", "pi-goal", "extensions", "goal.ts")
    : undefined;
  if (goalEntry && !existsSync(goalEntry)) {
    throw new Error(`pi-goal not installed at ${goalEntry}; run: cd /tmp/pitg-probe-goal && npm install --no-save @capyup/pi-goal`);
  }

  const probePath = join(RUN_DIR, "probe.json");
  const paneLog = join(RUN_DIR, "pane.log");
  const versionText = HOST === "pi"
    ? String(sh(piCli, ["--version"], { timeout: 30_000 }).stdout ?? "").trim()
    : String(sh(OMP_CLI, ["--version"], { timeout: 30_000 }).stdout ?? "").trim();

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(RUN_DIR, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    PITG_PROBE: probePath,
    PITG_PROBE_HOST: HOST,
    PITG_PROBE_LABEL: `${HOST}${GOAL ? `-goal-${GOAL}` : ""}`,
    PITG_PROBE_VERSION: versionText,
    PI_GOAL_AUTO_CONFIRM: "0",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const extensionArgs = ["-e", PLUGIN_ENTRY, "-e", PROBE_EXTENSION];
  if (goalEntry) extensionArgs.push("-e", goalEntry);

  const command = HOST === "pi"
    ? [
        piCli,
        "--no-skills",
        "--no-extensions",
        ...extensionArgs,
        "--provider", "mock",
        "--model", "mock-model",
      ]
    : [
        OMP_CLI,
        ...extensionArgs,
        "--model", "mock/mock-model",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--no-title",
        "--session-dir", sessionDir,
        ...(APPROVAL ? ["--approval-mode", "always-ask"] : []),
      ];

  const start = tmux(
    "new-session", "-d", "-s", SESSION, "-x", "220", "-y", "55", "-c", projectDir,
    ...envArgs,
    ...command,
  );
  if (start.status !== 0) throw new Error(`failed to start ${HOST}: ${start.stderr}`);
  tmux("pipe-pane", "-t", SESSION, `cat > ${paneLog}`);

  const steps = [];
  const step = (name, detail = "") => {
    steps.push({ name, detail, at: new Date().toISOString() });
    console.log(`  · ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const doc = await waitForProbe(probePath, (value) => value.mode && value.prototype?.mode?.length > 0, "mode capture");
    step("probe captured mode", `${doc.prototype.mode.length} prototype names`);
    await sleep(1500);

    // Extension dialogs first: they prove the entry hooks independently of any
    // command implementation.
    if (!APPROVAL) {
    await runCommand("/probe-ui", 1200);
    step("probe-ui");
    for (const [name, interaction] of [
      ["/probe-select", [["Down"], ["Enter"]]],
      ["/probe-confirm", [["Enter"]]],
      ["/probe-input", [["-l", "probe answer"], ["Enter"]]],
      ["/probe-input-secret", [["-l", "probe-secret"], ["Enter"]]],
      ["/probe-editor", [["-l", "probe editor text"], ["Enter"]]],
      ["/probe-custom", [["Down"], ["Enter"]]],
      ["/probe-ask", [["Enter"], ["Enter"]]],
      ["/probe-notify", []],
    ]) {
      tmux("send-keys", "-t", SESSION, "-l", name);
      tmux("send-keys", "-t", SESSION, "Enter");
      await sleep(1200);
      for (const keys of interaction) {
        tmux("send-keys", "-t", SESSION, ...keys);
        await sleep(400);
      }
      await sendKey("Escape");
      await sleep(400);
      step(name);
    }
    }

    // Host commands that open a dialog or print output. Unknown commands are
    // harmless; the probe records whichever entry points the host calls.
    const commands = APPROVAL ? [] : HOST === "pi"
      ? ["/help", "/hotkeys", "/model", "/settings", "/session", "/resume", "/tree", "/fork",
         "/login", "/logout", "/scoped-models", "/theme", "/thinking", "/status", "/usage",
         "/context", "/changelog", "/debug", "/compact", "/share", "/export"]
      : ["/help", "/hotkeys", "/model", "/models", "/settings", "/sessions", "/resume", "/tree",
         "/fork", "/login", "/logout", "/scoped-models", "/theme", "/thinking", "/status",
         "/usage", "/context", "/changelog", "/debug", "/compact", "/share", "/export",
         "/skills", "/plugins", "/tools", "/mcp", "/agents", "/plan"];
    for (const command of commands) {
      await runCommand(command, command === "/compact" ? 2500 : 1400);
      step(command);
    }

    if (HOST === "omp" && !GOAL) {
      const prompts = APPROVAL ? ["PROBE_APPROVAL"] : ["ASK_TOOL_PROBE", "ASK_TOOL_PROBE_MULTI"];
      for (const prompt of prompts) {
        await sleep(1500);
        await sendText(prompt, 6000);
        await sendKey("Escape");
        await sleep(2000);
        step(prompt);
      }
    }

    if (GOAL) {
      const trigger = GOAL === "confirm" ? "PROBE_GOAL_CONFIRM"
        : (GOAL === "question" ? "PROBE_GOAL_QUESTION" : "PROBE_GOAL_QUESTIONNAIRE");
      await sendText(`/goals ${trigger}`, 2500);
      await waitForProbe(
        probePath,
        (value) => (value.customComponents ?? []).some((event) => String(event.data?.source ?? "").toLowerCase().includes("custom")),
        `${GOAL} custom component`,
        30_000,
      ).catch(() => undefined);
      await sleep(800);
      await sendKey("Escape");
      await sleep(800);
      step(`/goals ${trigger}`);
    }

    const finalDoc = probeDoc(probePath) ?? {};
    finalDoc.hostVersion = versionText;
    finalDoc.driver = {
      host: HOST,
      goal: GOAL || undefined,
      piVersion: HOST === "pi" ? PI_VERSION : undefined,
      commands,
      steps,
      paneLog,
      providerLog: join(RUN_DIR, "provider.jsonl"),
      telegramLog: join(RUN_DIR, "telegram.jsonl"),
    };
    writeFileSync(OUT, `${JSON.stringify(finalDoc, null, 2)}\n`);
    console.log(`probe written: ${OUT}`);
    console.log(`steps: ${steps.length}, entryCalls: ${finalDoc.entryCalls?.length ?? 0}, focusEvents: ${finalDoc.focusEvents?.length ?? 0}, custom: ${finalDoc.customComponents?.length ?? 0}`);
  } catch (error) {
    console.error(`PROBE_FAILED ${String(error)}\n--- pane ---\n${capturePane().slice(-6000)}`);
    const partial = probeDoc(probePath);
    if (partial) {
      partial.hostVersion = versionText;
      partial.driver = { host: HOST, goal: GOAL || undefined, commands: [], steps, failure: String(error), paneLog };
      writeFileSync(OUT, `${JSON.stringify(partial, null, 2)}\n`);
      console.error(`partial probe written: ${OUT}`);
    }
    process.exitCode = 1;
  } finally {
    if (!KEEP) {
      killSession(SESSION);
      tg.proc.kill();
      provider.proc.kill();
    } else {
      console.log(`kept session ${SESSION}, run dir ${RUN_DIR}`);
      tg.proc.kill();
      provider.proc.kill();
    }
  }
}

await main();
