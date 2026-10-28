#!/usr/bin/env node
/**
 * Isolated tmux acceptance for the TUI bridge + Telegram shell commands.
 *
 * By default, runs the pi CLI from this repo's `node_modules/.bin/pi` (override with
 * `--pi`) and OMP against the same mock Telegram Bot API and mock OpenAI-compatible
 * provider. Each run proves:
 *
 *   1. BotMenu includes commands discovered from the live host catalog.
 *   2. A local TUI command is not mirrored to Telegram (it stays in the terminal).
 *   3. Telegram `/settings` opens the real dialog brokered by the plugin:
 *      `tgplus:dlg:` semantic rows (the screen-mirror keyboard was removed in D2).
 *   4. Rows/keys/cancel reach the real host input path and mirror their
 *      lifecycle; text typed while a dialog owns the input never becomes a prompt.
 *   5. `!cmd` receipts carry the command line and its output once the host's
 *      shell component has finished; dangerous commands can be rejected.
 *   6. `!!cmd` receipts show a nonzero exit, and its output is absent from
 *      the next real provider request.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-tui-bridge.mjs [--host pi|omp|both] [--keep]
 *     [--timeout 90] [--pi /path/to/pi]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ENTRY = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const HOST_ARG = argValue("--host", "both");
const KEEP = process.argv.includes("--keep");
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "90")) * 1000;
const TG_PORT = Number(argValue("--tg-port", "9960"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9961"));
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI_ARG = argValue("--pi", process.env.PI_CLI);
const CUSTOM_PI_CLI = PI_CLI_ARG?.includes("/") ? resolve(REPO, PI_CLI_ARG) : PI_CLI_ARG;
const PI_CLI = CUSTOM_PI_CLI ?? resolve(REPO, "node_modules/.bin/pi");
const ROOT = process.env.PITG_E2E_BRIDGE_ROOT || "/tmp/pitg-e2e-bridge";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function tmux(...args) {
  return sh("tmux", args);
}

function removeQuietly(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
    }
  }
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  tmux("kill-session", "-t", session);
  tmux("kill-session", "-t", session);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
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

const controlPost = (path, body) => controlRequest(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});
const controlGet = (path) => controlRequest(path, { method: "GET" });

async function waitFor(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet("/_control/log");
      const value = predicate(last);
      if (value) return value === true ? last : value;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}\nlast state: ${JSON.stringify(last, null, 2).slice(0, 4000)}`);
}

async function waitForProvider(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const logPath = join(ROOT, "provider.jsonl");
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      entries = readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const value = predicate(entries);
      if (value) return value === true ? entries : value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for provider: ${label}\nlast entries: ${JSON.stringify(entries.slice(-2), null, 2)}`);
}

function startServer(name, script, args) {
  const proc = spawn("node", [join(E2E, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d.toString(); });
  proc.stderr.on("data", (d) => { buf += d.toString(); });
  return { proc, getOutput: () => buf };
}

function messages(state) {
  return state.calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText");
}

// Keyboard dialect: dialogs are brokered by the plugin
// (`tgplus:dlg:<session>:<generation>:<op>[:<arg>]`), where `c/t/v/m` are rows,
// `k` is a key name and `x` is cancel. The raw-key screen-mirror keyboard
// (`tgplus:tui:`) was removed in D2 - stale copies only get the expiry notice.
const DIALOG_PREFIX = "tgplus:dlg:";
const DIALOG_ROW = /^tgplus:dlg:[^:]+:\d+:(?:[ctvm])(?::|$)/;
const DIALOG_KEY = /^tgplus:dlg:[^:]+:\d+:k:/;
const DIALOG_CANCEL = /^tgplus:dlg:[^:]+:\d+:x$/;
const isControllable = (data) => String(data ?? "").startsWith(DIALOG_PREFIX);

function seedEnvironment(host, runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });

  if (host === "pi") {
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
    writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
    writeFileSync(join(agentDir, "models.yml"), [
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
    ].join("\n"));
  }

  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{
      id: `${host}-bot`,
      name: host,
      token: `${host === "pi" ? "333333" : "444444"}:TUI_BRIDGE_TOKEN`,
      allowedUserId: 42,
      apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");

  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`,
    enabled: true,
    activeChatId: 42,
    tuiBridge: "full",
    bashConfirm: "dangerous",
  }, null, 2) + "\n");

  return { agentDir, projectDir };
}

function startHost(host, piCli, projectDir, agentDir, paneLog, session) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = host === "omp"
    ? [OMP_CLI, "-e", PLUGIN_ENTRY, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"]
    : [piCli, "--no-skills", "--no-extensions", "-e", PLUGIN_ENTRY, "--provider", "mock", "--model", "mock-model"];
  // The tmux server's own cwd may be a deleted directory (harness cleanup),
  // which poisons every new pane's initial cwd; cd inside the command instead
  // of relying on -c alone.
  const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  const result = tmux(
    "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir,
    ...envArgs, command,
  );
  if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${paneLog}`);
  return result;
}

async function runHost(host, piCli, label) {
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, "-");
  const session = `pitg-bridge-${slug}`;
  const runDir = join(ROOT, `run-${slug}`);
  const paneLog = join(runDir, "pane.log");
  removeQuietly(runDir);
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");

  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const version = sh(host === "omp" ? OMP_CLI : piCli, ["--version"], { timeout: 30_000 });
  record(`resolve ${host} CLI`, version.status === 0, `${version.stdout ?? ""}${version.stderr ?? ""}`.trim());

  const { agentDir, projectDir } = seedEnvironment(host, runDir);
  const start = startHost(host, piCli, projectDir, agentDir, paneLog, session);
  if (start.status !== 0) {
    record(`start ${host} in tmux`, false, start.stderr?.trim());
    return { steps, ok: false };
  }
  record(`start ${host} in tmux`, true, session);

  let updateId = 7000;
  const injectMessage = (text, messageId) => controlPost("/_control/inject", {
    updates: [{
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "E2E" },
        text,
      },
    }],
  });
  const injectCallback = async (data, messageId) => {
    const callbackId = `cb-${updateId + 1}`;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId,
          from: { id: 42, is_bot: false, first_name: "E2E" },
          message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 42, type: "private" },
          },
          chat_instance: "e2e",
          data,
        },
      }],
    });
    return callbackId;
  };

  try {
    await waitFor("getMe", (state) => state.calls.some((call) => call.method === "getMe"));
    record("plugin authenticates via getMe", true);
  } catch (error) {
    record("plugin authenticates via getMe", false, String(error.message).slice(0, 400));
  }

  const dynamicCandidates = host === "omp"
    ? ["tools", "mcp", "agents", "permissions"]
    : ["trust", "init", "help", "commands", "clear", "cost"];
  try {
    const call = await waitFor("setMyCommands with dynamic host catalog", (value) =>
      value.calls.findLast((entry) =>
        entry.method === "setMyCommands"
        && Array.isArray(entry.body?.commands)
        && entry.body.commands.some((command) => dynamicCandidates.includes(command.command))) ?? false);
    const names = call.body.commands.map((command) => command.command);
    const discovered = dynamicCandidates.filter((command) => names.includes(command));
    record(
      "BotMenu merges the host command catalog",
      discovered.length > 0 && names.length <= 100,
      `${discovered.slice(0, 4).join(", ")} · ${names.length} commands`,
    );
  } catch (error) {
    record("BotMenu merges the host command catalog", false, String(error.message).slice(0, 400));
  }

  // ── Local TUI command is not mirrored to Telegram ──────────────────────
  // A command typed in the local terminal stays local: nothing about it may
  // reach the chat (the old local-command mirror was removed on purpose).
  try {
    await sleep(800);
    const sinceLocal = (await controlGet("/_control/log")).calls.length;
    const typed = tmux("send-keys", "-t", session, "-l", "!true");
    if (typed.status !== 0) throw new Error(typed.stderr || "send-keys failed");
    tmux("send-keys", "-t", session, "Enter");
    await sleep(4000);
    const leaked = messages({ calls: (await controlGet("/_control/log")).calls.slice(sinceLocal) })
      .filter((call) => String(call.body?.text ?? "").includes("!true")
        || String(call.body?.text ?? "").includes("TUI command"));
    if (leaked.length > 0) {
      throw new Error(`local command leaked to Telegram: ${leaked.map((call) => String(call.body?.text ?? "").slice(0, 120)).join(" | ")}`);
    }
    record("local TUI command is not mirrored to Telegram", true, "nothing sent within 4 s");
  } catch (error) {
    record("local TUI command is not mirrored to Telegram", false, String(error.message).slice(0, 400));
  }

  // ── Telegram /settings → interactive TUI selector ──────────────────────
  let mirrorMessageId;
  try {
    await sleep(500);
    await injectMessage("/settings", 7201);
    const found = await waitFor("interactive TUI selector mirror", (state) => {
      const call = messages(state).find((entry) => {
        const rows = entry.body?.reply_markup?.inline_keyboard;
        return Array.isArray(rows)
          && rows.flat().some((button) => isControllable(button.callback_data));
      });
      return call ?? false;
    });
    mirrorMessageId = found.body?.message_id ?? found.message_id;
    if (typeof mirrorMessageId !== "number") throw new Error("mirror message has no id");
    const rows = found.body.reply_markup.inline_keyboard;
    record("Telegram command opens a remotely controllable TUI selector", true, `${rows.flat().length} buttons`);
  } catch (error) {
    record("Telegram command opens a remotely controllable TUI selector", false, String(error.message).slice(0, 400));
  }

  const keyboardOf = async () => {
    const state = await controlGet("/_control/log");
    const call = state.calls
      .filter((entry) => Array.isArray(entry.body?.reply_markup?.inline_keyboard))
      .filter((entry) => (entry.body?.message_id ?? entry.message_id) === mirrorMessageId)
      .at(-1);
    return (call?.body?.reply_markup?.inline_keyboard ?? []).flat();
  };

  const callbackAnswered = async (callbackId) => {
    await waitFor(`${callbackId} answered`, (state) => state.calls.some((entry) =>
      entry.method === "answerCallbackQuery" && entry.body?.callback_query_id === callbackId));
  };

  try {
    if (mirrorMessageId === undefined) throw new Error("no dialog message");
    const buttons = await keyboardOf();
    if (!buttons.some((button) => String(button.callback_data ?? "").startsWith(DIALOG_PREFIX))) {
      throw new Error("settings dialog is not brokered: no tgplus:dlg: keyboard (unadapted dialog, D4)");
    }
    {
      // `full` mode: the keyboard carries semantic buttons resolved against the
      // live component, so the proof is that the terminal reacts to them. The
      // keyboard is re-read before each tap because a brokered action republishes
      // the message with a fresh generation, and buttons are deduped by TEXT:
      // the generation inside the callback data changes on every republish, so
      // data-based dedup lets the same screen slot be tapped twice - OMP lays
      // its paging buttons out by position (current page omitted), which flips
      // the pane back to where it started (3E).
      const pane = () => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      const tapped = [];
      const seenTexts = new Set();
      for (const pattern of [DIALOG_ROW, DIALOG_ROW, DIALOG_KEY]) {
        const button = (await keyboardOf()).find((entry) => {
          const data = String(entry.callback_data ?? "");
          return pattern.test(data) && !seenTexts.has(String(entry.text ?? ""));
        });
        if (!button) continue;
        seenTexts.add(String(button.text ?? ""));
        const label = String(button.text ?? "").trim() || String(button.callback_data);
        const paneBefore = pane();
        await callbackAnswered(await injectCallback(String(button.callback_data), mirrorMessageId));
        await sleep(600);
        tapped.push({ label, changed: pane() !== paneBefore });
      }
      if (tapped.length < 2) throw new Error(`dialog keyboard is not driveable: ${buttons.length} buttons`);
      if (!tapped.some((tap) => tap.changed)) {
        throw new Error(`the terminal ignored ${tapped.map((tap) => `"${tap.label}" pane ${tap.changed ? "changed" : "unchanged"}`).join(", ")}`);
      }
      // §4.5.1: a message that arrives while a dialog owns the terminal input is
      // a dialog action, not a prompt - it must never start a model turn.
      const providerFile = join(ROOT, "provider.jsonl");
      const providerBefore = existsSync(providerFile) ? readFileSync(providerFile, "utf8").length : 0;
      await injectMessage("theme", 7202);
      await sleep(4_000);
      const providerAfter = existsSync(providerFile) ? readFileSync(providerFile, "utf8").length : 0;
      if (providerAfter !== providerBefore) {
        throw new Error("text typed during a dialog was submitted as a prompt");
      }
      record("all TUI key/type/refresh callbacks reach the selector", true,
        `dialog buttons tapped: ${tapped.length}; dialog text kept out of the prompt path`);
    }
  } catch (error) {
    record("all TUI key/type/refresh callbacks reach the selector", false, String(error.message).slice(0, 400));
  }

  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("/settings", 7203);
    const findClose = (buttons) => buttons.find((button) => {
      const data = String(button.callback_data ?? "");
      return DIALOG_CANCEL.test(data);
    });
    const reopened = await waitFor("selector reopened for close callback", (state) => {
      const call = state.calls.slice(callOffset).find((entry) => {
        const rows = entry.body?.reply_markup?.inline_keyboard;
        return Array.isArray(rows) && Boolean(findClose(rows.flat()));
      });
      return call ?? false;
    });
    const reopenedMessageId = reopened.body?.message_id ?? reopened.message_id;
    const closeButton = findClose(reopened.body.reply_markup.inline_keyboard.flat());
    // The invariant of the brokered dialog: cancelling retires the
    // dialog and strips the keyboard, so a stale menu can never be tapped again.
    await injectCallback(String(closeButton.callback_data), reopenedMessageId);
    await waitFor("close callback removes the keyboard", (state) =>
      state.calls.some((call) =>
        call.method === "editMessageReplyMarkup" && call.body?.message_id === reopenedMessageId));
    record("cancel callback retires the dialog keyboard", true, String(closeButton.callback_data));
  } catch (error) {
    record("cancel callback retires the dialog keyboard", false, String(error.message).slice(0, 400));
  }

  // ── Telegram !bash ─────────────────────────────────────────────────────
  try {
    await injectMessage("!printf PTP_BASH_OK", 7210);
    // D3b: the host runs the command; the receipt is the bash component's
    // finished frame - command line plus a separate output line. The output
    // must survive removing the command line, and a "Running…" streaming
    // frame never counts as done.
    await waitFor("!bash receipt shows the output", (state) => messages(state)
      .some((call) => {
        const text = String(call.body?.text ?? "");
        if (!text.includes("$ printf PTP_BASH_OK") || /Running…|Running\.\.\./.test(text)) return false;
        return text.split("\n").filter((line) => !line.includes("$ printf PTP_BASH_OK")).join("\n").includes("PTP_BASH_OK");
      }));
    record("Telegram !bash runs and reports exit 0", true);
  } catch (error) {
    record("Telegram !bash runs and reports exit 0", false, String(error.message).slice(0, 400));
  }

  try {
    await injectMessage("!!false", 7211);
    // The host frame marks a failed command as `(exit 1)`; the removed
    // plugin format said `exit: 1` - either spelling counts.
    await waitFor("!!bash reports nonzero exit", (state) => messages(state)
      .some((call) => {
        const text = String(call.body?.text ?? "");
        return text.includes("$ false") && /\(exit 1\)|exit: 1/.test(text);
      }));
    record("Telegram !!bash reports exit 1", true);
  } catch (error) {
    record("Telegram !!bash reports exit 1", false, String(error.message).slice(0, 400));
  }

  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("!rm -rf /tmp/PTP_E2E_CONFIRM_SENTINEL", 7212);
    const prompt = await waitFor("dangerous bash confirmation buttons", (state) =>
      messages({ calls: state.calls.slice(callOffset) }).find((call) =>
        String(call.body?.text ?? "").includes("Run shell command")
        && Array.isArray(call.body?.reply_markup?.inline_keyboard)) ?? false);
    const promptMessageId = prompt.body?.message_id ?? prompt.message_id;
    const buttons = prompt.body.reply_markup.inline_keyboard.flat();
    const reject = buttons.find((button) => /no|cancel|reject/i.test(button.text));
    if (!reject?.callback_data) throw new Error("dangerous bash prompt has no reject callback");
    await injectCallback(reject.callback_data, promptMessageId);
    await waitFor("dangerous bash rejection", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes("Shell command cancelled")));
    record("dangerous bash confirmation can reject execution", true);
  } catch (error) {
    record("dangerous bash confirmation can reject execution", false, String(error.message).slice(0, 400));
  }

  try {
    const secret = `PTP_EXCLUDED_${slug}`;
    const probe = `PTP_CONTEXT_PROBE_${slug}`;
    await injectMessage(`!!printf ${secret}`, 7213);
    // Any receipt echoing the secret proves the command completed; the
    // exit-marker spelling changed with the host-driven bash frame.
    await waitFor("excluded bash completes", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes(secret)));
    await injectMessage(probe, 7214);
    const request = await waitForProvider("probe after excluded bash", (entries) =>
      entries.findLast((entry) => String(entry.userText ?? "").includes(probe)) ?? false);
    if (String(request.userText ?? "").includes(secret) || String(request.prompt ?? "").includes(secret)) {
      throw new Error("!!bash output leaked into provider context");
    }
    record("Telegram !!bash output is excluded from provider context", true);
  } catch (error) {
    record("Telegram !!bash output is excluded from provider context", false, String(error.message).slice(0, 400));
  }

  // ── /login: the host's own login dialog, drivable from Telegram ────────
  // Both hosts can serve /login with their own UI (pi whenever the bridge runs
  // in `full`/`on` mode, OMP always), so this step accepts either keyboard
  // dialect and proves a Telegram callback reaches the host input path.
  const loginStep = "login opens a remotely controllable host dialog";
  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("/login", 7220);
    await sleep(900);
    const pane = tmux("capture-pane", "-p", "-t", session);
    const paneText = String(pane.stdout ?? "");
    const hit = paneText.split("\n").find((line) => /login|oauth|auth|provider|credential/i.test(line));
    if (!hit) throw new Error(`host pane shows no login UI: ${paneText.slice(-200)}`);
    const loginMirror = await waitFor("login mirror keyboard", (state) =>
      messages({ calls: state.calls.slice(callOffset) }).find((call) =>
        Array.isArray(call.body?.reply_markup?.inline_keyboard)
        && call.body.reply_markup.inline_keyboard.flat()
          .some((button) => isControllable(button.callback_data))) ?? false);
    const loginMirrorMessageId = loginMirror.body?.message_id ?? loginMirror.message_id;
    const loginButtons = (loginMirror.body?.reply_markup?.inline_keyboard ?? []).flat();
    // Selector keyboards carry per-item buttons: the brokered dialog's `c`/`t`
    // rows. Prefer a non-selected item (that proves the pick path), else fall
    // back to an advertised key.
    const probeButton = loginButtons.find((button) => {
      const data = String(button.callback_data ?? "");
      return DIALOG_ROW.test(data)
        && !String(button.text ?? "").startsWith("▸");
    });
    const fallbackButton = probeButton ? undefined : loginButtons.find((button) => {
      const data = String(button.callback_data ?? "");
      return DIALOG_KEY.test(data);
    });
    const probeData = probeButton ? String(probeButton.callback_data)
      : fallbackButton ? String(fallbackButton.callback_data) : undefined;
    if (!probeData) {
      throw new Error(`login keyboard has no driveable button: ${loginButtons.map((button) => button.text).join(" / ").slice(0, 200)}`);
    }
    const callbackId = await injectCallback(probeData, loginMirrorMessageId);
    await waitFor("probe callback answered on login mirror", (state) =>
      state.calls.some((call) =>
        call.method === "answerCallbackQuery" && call.body?.callback_query_id === callbackId));
    const paneAfter = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    if (paneAfter === paneText) {
      throw new Error(`login dialog did not react to ${probeData}`);
    }
    record(loginStep, true,
      `${loginButtons.length} buttons + ${probeButton ? "pick" : "key"} callback routed`);
  } catch (error) {
    record(loginStep, false, String(error.message).slice(0, 400));
  }

  killSession(session);
  const failed = steps.filter((step) => !step.ok);
  if (failed.length > 0 && existsSync(paneLog)) {
    console.log(`\n--- ${label} tmux pane (last 30 lines) ---`);
    console.log(readFileSync(paneLog, "utf8").split("\n").slice(-30).join("\n"));
  }
  return { steps, ok: failed.length === 0, paneLog };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  if (!["pi", "omp", "both"].includes(HOST_ARG)) {
    throw new Error(`invalid --host ${HOST_ARG}; expected pi, omp, or both`);
  }

  // A leftover run (zombie script or foreign mock) holding these ports would
  // silently steal the injected updates; fail fast with a named cause instead.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive — kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }
  const runs = [];
  if (HOST_ARG === "pi" || HOST_ARG === "both") {
    runs.push({ host: "pi", label: "pi", piCli: PI_CLI });
  }
  if (HOST_ARG === "omp" || HOST_ARG === "both") {
    runs.push({ host: "omp", label: "omp", piCli: undefined });
  }

  const tg = startServer("mock-telegram", "mock-telegram.mjs", [
    "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl"),
  ]);
  const provider = startServer("mock-provider", "mock-provider.mjs", [
    "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"),
  ]);
  await sleep(1200);
  if (!tg.getOutput().includes("MOCK_TELEGRAM_READY")) throw new Error(`mock telegram failed:\n${tg.getOutput()}`);
  if (!provider.getOutput().includes("MOCK_PROVIDER_READY")) throw new Error(`mock provider failed:\n${provider.getOutput()}`);
  console.log("mocks ready: telegram + provider\n");

  const results = [];
  try {
    for (const run of runs) {
      console.log(`=== ${run.label} ===`);
      results.push({ host: run.label, ...await runHost(run.host, run.piCli, run.label) });
      console.log("");
    }
  } finally {
    tg.proc.kill();
    provider.proc.kill();
  }

  writeFileSync(join(ROOT, "e2e-tui-bridge-report.json"), JSON.stringify(results, null, 2) + "\n");
  const failed = results.filter((result) => !result.ok);
  for (const result of results) console.log(`${result.ok ? "✓" : "✗"} ${result.host}`);
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} host run(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nTUI_BRIDGE_EXIT=0 (${results.length}/${results.length} host runs passed)`);
  }
  if (!KEEP) removeQuietly(ROOT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
