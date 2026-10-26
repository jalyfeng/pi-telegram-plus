#!/usr/bin/env node
/**
 * Round-trip dialog acceptance (docs/tui-parity-refactor-plan.md §7.1, phase 2).
 *
 * Every dialog a host or an extension can raise must be answerable from
 * Telegram *and* from the terminal, and the answer must reach the host with the
 * same value a terminal keystroke would have produced. The probe extension
 * (scripts/e2e/probe-extension.ts) records the value each `ctx.ui.*` call
 * resolved to, so assertions read that value instead of a rendered screen: how
 * the keyboard was drawn (mirror `tgplus:tui:`, broker `tgplus:dlg:`, or the
 * legacy Telegram-native `tgplus:ui:` menu) is recorded as audit detail only.
 * The tool-approval step runs OMP in `write` approval mode, so the mock's
 * `bash` call raises OMP's approval prompt and Telegram answers it (deny).
 *
 * Stack: real pi / OMP in tmux + mock Bot API + mock provider, all state under
 * /tmp, same isolation as the other acceptance scripts.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-dialogs.mjs [--host pi|omp|both]
 *     [--goal confirm|question|questionnaire] [--tg-port 9970] [--provider-port 9971]
 *     [--timeout 40] [--keep] [--pi-bin <path>] [--omp <path>]
 *
 * Exit code is non-zero when a failed step is not on scripts/e2e/pending-migration.json;
 * DIALOGS_ACCEPTANCE reports the regression count (expected gaps do not count).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { classify, loadPending } from "./pending.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const PROBE_EXTENSION = join(REPO, "scripts", "e2e", "probe-extension.ts");
const E2E = join(REPO, "scripts", "e2e");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const HOST_ARG = argValue("--host", "both");
const KEEP = process.argv.includes("--keep");
const GOAL = argValue("--goal", "");
const TG_PORT = Number(argValue("--tg-port", "9970"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9971"));
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "40")) * 1000;
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const ROOT = process.env.PITG_E2E_DIALOGS_ROOT || "/tmp/pitg-e2e-dialogs";
const GOAL_ENTRY = join(ROOT, "..", "pitg-probe-goal", "node_modules", "@capyup", "pi-goal", "extensions", "goal.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Injected update ids must keep rising. The plugin persists the last id it saw and
// asks getUpdates for the next one, so a random id that lands lower than an earlier
// injection is invisible until the plugin notices and rewinds its cursor - callbacks
// simply never arrive.
let nextUpdateId = 5_000_000;
const injectedUpdateId = () => nextUpdateId++;

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const dialectOf = (call) => {
  const data = buttonsOf(call).map((b) => String(b.callback_data ?? ""));
  if (data.some((d) => d.startsWith("tgplus:dlg:"))) return "broker";
  if (data.some((d) => d.startsWith("tgplus:tui:"))) return "mirror";
  if (data.some((d) => d.startsWith("tgplus:ui:"))) return "telegram-native";
  return "none";
};
const isDrivable = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:"));
// Brokered dialog keyboards: `x` is cancel, the only button an unsupported
// dialog is allowed to offer (§4.6.5 #13).
const DIALOG_CANCEL = /^tgplus:dlg:[^:]+:\d+:x$/;

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

function startServer(name, script, args) {
  const proc = spawn("node", [join(E2E, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d.toString(); });
  proc.stderr.on("data", (d) => { buf += d.toString(); });
  return { name, proc, getOutput: () => buf };
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
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet();
      const value = predicate(last);
      if (value) return value === true ? last : value;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Probe document (written by the plugin's probe recorder, read as the oracle)
// ---------------------------------------------------------------------------

function probeDoc(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // partially written
  }
}

/** Every recorded entry, whatever bucket the recorder filed it under. */
function probeEntries(doc) {
  if (!doc) return [];
  const out = [];
  for (const [key, value] of Object.entries(doc)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) out.push({ bucket: key, ...entry });
  }
  return out;
}

function findExtensionResult(doc, name) {
  return probeEntries(doc).filter((entry) =>
    entry.kind === "extension-result" && String(entry.data?.name ?? "") === name);
}

/**
 * Component types the host focused after `sinceMs`, editor excluded: raw
 * evidence for whether the terminal had a dialog of its own to answer.
 */
function focusedCtors(path, sinceMs) {
  const doc = probeDoc(path);
  const names = new Set();
  for (const event of Array.isArray(doc?.focusEvents) ? doc.focusEvents : []) {
    if (Number(event?.at ?? 0) < sinceMs) continue;
    const ctor = String(event?.data?.focus?.ctor ?? "");
    if (ctor && ctor !== "CustomEditor") names.add(ctor);
  }
  return [...names];
}

async function waitForExtensionResult(path, name, needle, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const doc = probeDoc(path);
    last = doc;
    const hits = findExtensionResult(doc, name);
    if (hits.length > 0) {
      if (needle === undefined) return hits[hits.length - 1];
      const hit = hits.find((entry) => JSON.stringify(entry).includes(needle));
      if (hit) return hit;
    }
    await sleep(250);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function seed(host, runDir, probePath) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(join(agentDir, "logs"), { recursive: true });
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
      "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock", "    api: openai-completions", "    models:",
      "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768",
      "        maxTokens: 4096", "",
    ].join("\n"));
  }
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{
      id: `${host}-bot`, name: host,
      token: `${host === "pi" ? "555555" : "666666"}:DIALOG_TOKEN`,
      allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`, enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir, probePath };
}

function hostArgs(host, pluginArgs) {
  return host === "omp"
    ? [OMP_CLI, ...pluginArgs, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules",
       "--no-lsp", "--approval-mode", "write", "--no-title"]
    : [PI_CLI, "--no-skills", "--no-extensions", ...pluginArgs, "--provider", "mock", "--model", "mock-model"];
}

async function runHost(host, servers) {
  const session = `pitg-dlg-${host}`;
  const runDir = join(ROOT, `run-${host}`);
  const probePath = join(runDir, "probe.json");
  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");

  const { agentDir, projectDir } = seed(host, runDir, probePath);
  const pluginArgs = ["-e", PLUGIN, "-e", PROBE_EXTENSION];
  if (GOAL) {
    if (!existsSync(GOAL_ENTRY)) {
      throw new Error(`pi-goal not installed at ${GOAL_ENTRY}; run: cd ${join(ROOT, "..", "pitg-probe-goal")} && npm install --no-save @capyup/pi-goal`);
    }
    pluginArgs.push("-e", GOAL_ENTRY);
  }
  // Browser stub: OMP's login dialog calls `open` / `xdg-open` for the sign-in URL. Put
  // logging no-ops first on PATH so no real browser opens on this machine.
  const stubBin = join(runDir, "bin");
  const openLog = join(runDir, "open-calls.log");
  mkdirSync(stubBin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    const stub = join(stubBin, name);
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${openLog}"\nexit 0\n`);
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
    PITG_PROBE: probePath,
    PITG_PROBE_HOST: host,
    PITG_PROBE_LABEL: `${host}${GOAL ? `-goal-${GOAL}` : ""}`,
    PITG_PROBE_VERSION: "local",
    PI_GOAL_AUTO_CONFIRM: "0",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  // The shell that runs the command may rebuild PATH from its profile (macOS path_helper puts
  // /usr/bin first), which would hide the stub; export it again right before the host starts.
  const command = `cd ${shq(projectDir)} && export PATH=${shq(env.PATH)} && exec ${hostArgs(host, pluginArgs).map(shq).join(" ")}`;
  const started = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50",
    "-c", projectDir, ...envArgs, command);
  if (started.status !== 0) {
    throw new Error(`failed to start ${host}: ${started.stderr}`);
  }
  const settle = () => sleep(1500);
  const clearDialog = async () => {
    // Escape twice: the first closes a dialog, the second a leftover overlay.
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
  const keyboardAfter = async (label, since, timeoutMs = 25_000) => {
    const call = await waitFor(label, (state) =>
      state.calls.slice(since).findLast((entry) =>
        Array.isArray(rowsOf(entry)) && isDrivable(entry)
        && (entry.body?.reply_markup?.inline_keyboard ?? []).flat().length > 0) ?? false,
    { timeoutMs }).catch(() => undefined);
    return call;
  };
  const clickButton = async (button, targetMessageId) => {
    const callbackId = `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const since = await cursor();
    await controlPost("/_control/inject", {
      updates: [{
        update_id: injectedUpdateId(),
        callback_query: {
          id: callbackId,
          from: { id: 42, is_bot: false, first_name: "E2E" },
          message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
          chat_instance: "e2e",
          data: String(button.callback_data),
        },
      }],
    });
    const answered = await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId),
      { timeoutMs: 15_000 }).then(() => true).catch(() => false);
    // The follow-up for this click: a fresh send, or an edit of the same message.
    await waitFor(`follow-up after ${button.text}`, (state) =>
      state.calls.slice(since).findLast((entry) =>
        (entry.method === "sendMessage" || entry.method === "editMessageText")
        && (entry.body?.message_id === targetMessageId || entry.method === "sendMessage")) ?? false,
      { timeoutMs: answered ? 20_000 : 2_000 }).catch(() => undefined);
    // False means the plugin never even acknowledged the press: the update was lost
    // or belonged to a flow it no longer knows, which is a real defect, not a slow
    // dialog.
    return answered;
  };
  const keyboardGone = async (messageId, timeoutMs = 15_000) => {
    // Withdrawn means: an edit of that message whose keyboard has no rows left
    // (the broker edits the summary with empty rows, then strips the markup).
    const call = await waitFor("keyboard removed", (state) =>
      state.calls.findLast((entry) =>
        entry.body?.message_id === messageId
        && (entry.method === "editMessageText" || entry.method === "editMessageReplyMarkup")
        && (entry.body?.reply_markup?.inline_keyboard ?? []).length === 0) ?? false,
    { timeoutMs }).catch(() => undefined);
    return call;
  };
  const providerEntries = () => {
    const path = join(ROOT, "provider.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  };
  const waitForProvider = async (label, predicate, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = predicate(providerEntries());
      if (hit) return hit;
      await sleep(250);
    }
    return undefined;
  };
  const paneText = () => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");

  try {
    await waitFor("getMe", (state) => state.calls.some((c) => c.method === "getMe"), { timeoutMs: 60_000 });
    record("plugin authenticates", true);
  } catch (error) {
    record("plugin authenticates", false, String(error.message).slice(0, 200));
    killSession(session);
    return { results, ok: false };
  }

  // Wait for the probe recorder to describe the host once (proves the probe
  // extension and the plugin's probe recorder are both live).
  const modeSeen = await (async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const doc = probeDoc(probePath);
      if (doc?.prototype?.mode?.length > 0) return doc;
      await sleep(400);
    }
    return undefined;
  })();
  record("probe recorder live", Boolean(modeSeen), modeSeen
    ? `${modeSeen.prototype.mode.length} prototype names` : "no probe document written");
  await settle();

  // ── model round trip (also records the advertised tool list) ───────────
  {
    const before = providerEntries().length;
    await injectText("reply with the single word warmup");
    const request = await waitForProvider("provider request recorded", (entries) =>
      (entries.length > before ? entries[before] : undefined), 45_000);
    const replied = request
      ? await waitFor("assistant reply in Telegram", (state) =>
        state.calls.some((entry) => entry.method === "sendMessage"
          && String(entry.body?.text ?? "").includes("MOCK_OK")), { timeoutMs: 45_000 }).catch(() => undefined)
      : undefined;
    record("model round trip", Boolean(replied),
      request ? `${(request.tools ?? []).length} tools advertised` : "no provider request");
  }

  // ── the plugin is authenticated and the host bridge is up (v6: the bridge
  //    is the only path, so there is no configured mode to read back) ──────
  {
    const since = await cursor();
    await injectText("/tg");
    const menu = await waitFor("/tg management menu", (state) =>
      state.calls.slice(since).find((entry) =>
        String(entry.body?.text ?? "").includes("Telegram Management")) ?? false, { timeoutMs: 25_000 })
      .catch(() => undefined);
    let configShown;
    if (menu) {
      const config = buttonsOf(menu).find((b) => /Config/i.test(String(b.text ?? "")));
      if (config) await clickButton(config, menu.body?.message_id ?? menu.message_id);
      const configLine = (entry) =>
        `${String(entry?.body?.text ?? "")} ${buttonsOf(entry ?? {}).map((b) => String(b.text ?? "")).join(" ")}`;
      configShown = await waitFor("config screen", (state) =>
        state.calls.slice(since).find((entry) => /🔧 Tool: \w+/.test(configLine(entry))) ?? false,
        { timeoutMs: 25_000 }).catch(() => undefined);
    }
    const outage = await waitFor("outage notice scan", (state) =>
      state.calls.find((entry) => /TUI bridge unavailable|The host bridge is unavailable/.test(String(entry?.body?.text ?? ""))) ?? false,
      { timeoutMs: 1 }).catch(() => undefined);
    record("plugin authenticated and bridge available", Boolean(configShown) && outage === undefined,
      outage ? `outage notice: ${String(outage.body?.text ?? "").slice(0, 60)}`
        : (configShown ? "config rendered, no outage notice" : "config screen not shown"));
  }

  // A host that greets the session with a dialog of its own (OMP's update
  // notification) queues every later command behind it: clear the terminal
  // before asking a dialog to appear.
  await clearDialog();

  // ── select: answered from Telegram ─────────────────────────────────────
  try {
    const since = await cursor();
    await injectText("/probe-select");
    const kb = await keyboardAfter("select keyboard", since);
    if (!kb) throw new Error("no keyboard offered for /probe-select");
    const messageId = kb.body?.message_id ?? kb.message_id;
    const labels = buttonsOf(kb).map((b) => String(b.text ?? ""));
    const beta = buttonsOf(kb).find((b) => /beta/.test(String(b.text ?? "")));
    if (!beta) throw new Error(`no beta row; labels: ${labels.slice(0, 6).join(" / ")}`);
    await clickButton(beta, messageId);
    const result = await waitForExtensionResult(probePath, "select", "beta", 20_000);
    record("select answered from Telegram", Boolean(result),
      `${dialectOf(kb)} · ${labels.slice(0, 4).join(" / ")}${result ? ` · resolved ${JSON.stringify(result.data?.value)}` : " · never resolved"}`);
  } catch (error) {
    record("select answered from Telegram", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── confirm: answered in the terminal while Telegram shows the keyboard ─
  try {
    const stepStartedAt = Date.now();
    const since = await cursor();
    await injectText("/probe-confirm");
    const kb = await keyboardAfter("confirm keyboard", since);
    if (!kb) throw new Error("no keyboard offered for /probe-confirm");
    if (dialectOf(kb) === "telegram-native") {
      // The mode kept this prompt in the plugin, so the terminal has no component to
      // press: there is no race to measure.
      record("terminal answer wins the race", true, "skipped: the plugin answers this prompt itself");
    } else {
      const messageId = kb.body?.message_id ?? kb.message_id;
      await sleep(600);
      // Which keystroke answers a host dialog is the host's own business: a confirm may
      // take Enter on the highlighted row, a y/n shortcut, or Down then Enter. Send what
      // a terminal user would send, in that order, and stop at the one that resolves the
      // dialog - what is under test is that a terminal answer wins and the Telegram
      // keyboard is withdrawn, not which key happens to do it.
      let result;
      let answeredBy = "";
      for (const keys of [["Enter"], ["y"], ["Down", "Enter"]]) {
        for (const key of keys) tmux("send-keys", "-t", session, key);
        result = await waitForExtensionResult(probePath, "confirm", undefined, 4_000);
        if (result) { answeredBy = keys.join("+"); break; }
      }
      const cleared = result ? await keyboardGone(messageId) : undefined;
      const late = result ? undefined : findExtensionResult(probePath, "confirm").at(-1);
      record("terminal answer wins the race", Boolean(result),
        `${dialectOf(kb)} · answered by ${answeredBy || "no key"} · resolved ${JSON.stringify(result?.data?.value)}`
        + (result
          ? (cleared ? " · keyboard withdrawn" : " · keyboard left on screen")
          : ` · host focused ${focusedCtors(probePath, stepStartedAt).join("/") || "nothing"}`
            + (late ? ` · resolved ${JSON.stringify(late.data?.value)} only after the dialog was cancelled` : " · never resolved")));
    }
  } catch (error) {
    record("terminal answer wins the race", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── input: answered by typed Telegram text ─────────────────────────────
  try {
    const since = await cursor();
    await injectText("/probe-input");
    const kb = await keyboardAfter("input keyboard", since);
    if (!kb) throw new Error("no keyboard offered for /probe-input");
    await sleep(500);
    const providerBefore = providerEntries().length;
    await injectText("hello-from-telegram");
    const result = await waitForExtensionResult(probePath, "input", "hello-from-telegram", 20_000);
    const sentToModel = providerEntries().slice(providerBefore).some((entry) =>
      JSON.stringify(entry).includes("hello-from-telegram"));
    record("typed text answers the input dialog", Boolean(result),
      `${dialectOf(kb)}${result ? ` · resolved ${JSON.stringify(result.data?.value)}` : " · not resolved"}`
      + `${sentToModel ? " · ALSO sent to the model" : ""}`);
  } catch (error) {
    record("typed text answers the input dialog", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── secret input: resolved, and never echoed to Telegram ───────────────
  try {
    const since = await cursor();
    await injectText("/probe-input-secret");
    const kb = await keyboardAfter("secret input keyboard", since);
    if (!kb) throw new Error("no keyboard offered for /probe-input-secret");
    await sleep(500);
    await injectText("s3cr3t-value");
    const result = await waitForExtensionResult(probePath, "inputSecret", undefined, 20_000);
    const state = await controlGet();
    const leaked = state.calls.filter((entry) => JSON.stringify(entry.body ?? {}).includes("s3cr3t-value"));
    record("secret input resolves without echoing", Boolean(result) && leaked.length === 0,
      `${dialectOf(kb)} · resolved ${JSON.stringify(result?.data?.value)}`
      + `${leaked.length > 0 ? ` · LEAKED in ${leaked.length} call(s)` : ""}`);
  } catch (error) {
    record("secret input resolves without echoing", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── custom overlay: answered in the terminal ───────────────────────────
  try {
    const stepStartedAt = Date.now();
    const since = await cursor();
    await injectText("/probe-custom");
    const kb = await keyboardAfter("custom overlay keyboard", since);
    if (kb && dialectOf(kb) === "telegram-native") {
      record("custom overlay resolves", true, "skipped: the plugin answers this prompt itself");
    } else {
      await sleep(800);
      tmux("send-keys", "-t", session, "Enter");
      const result = await waitForExtensionResult(probePath, "custom", undefined, 20_000);
      const late = result ? undefined : findExtensionResult(probePath, "custom").at(-1);
      record("custom overlay resolves", Boolean(result),
        `${kb ? dialectOf(kb) : "no keyboard"} · resolved ${JSON.stringify(result?.data?.value)}`
        + (result ? "" : ` · host focused ${focusedCtors(probePath, stepStartedAt).join("/") || "nothing"}`
          + (late ? ` · resolved ${JSON.stringify(late.data?.value)} only after the dialog was cancelled` : " · never resolved")));
    }
  } catch (error) {
    record("custom overlay resolves", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── unknown custom dialog: announced, never mirrored (T4.6) ────────────
  // A `ctx.ui.custom` component no adapter recognises must not be mirrored: the
  // chat gets a notice naming it plus one way out, and pressing that way out
  // sends Escape to the component.
  try {
    const since = await cursor();
    await injectText("/probe-custom-unknown");
    const notice = await waitFor("unsupported dialog notice", (state) =>
      state.calls.slice(since).findLast((entry) =>
        /Dialog Telegram can't handle/.test(String(entry.body?.text ?? ""))
        && Array.isArray(rowsOf(entry))) ?? false, { timeoutMs: 25_000 })
      .catch(() => undefined);
    if (!notice) throw new Error("no unsupported-dialog notice for /probe-custom-unknown");
    const buttons = buttonsOf(notice);
    const labels = buttons.map((b) => String(b.text ?? "")).join(" / ");
    const cancel = buttons.find((b) => DIALOG_CANCEL.test(String(b.callback_data ?? "")));
    if (!cancel) throw new Error(`no cancel button on the notice; buttons: ${labels || "(none)"}`);
    await clickButton(cancel, notice.body?.message_id ?? notice.message_id);
    const result = await waitForExtensionResult(probePath, "custom-unknown", "cancelled", 20_000);
    const state = await controlGet();
    const mirrored = state.calls.slice(since)
      .filter((entry) => JSON.stringify(entry.body ?? {}).includes("PROBE UNKNOWN WIDGET"));
    record("unknown custom dialog is announced, not mirrored",
      Boolean(result) && buttons.length === 1 && mirrored.length === 0,
      `${dialectOf(notice)} · ${buttons.length} button(s): ${labels || "(none)"}`
      + `${result ? ` · resolved ${JSON.stringify(result.data?.value)}` : " · never resolved"}`
      + (mirrored.length > 0 ? ` · MIRRORED in ${mirrored.length} call(s)` : ""));
  } catch (error) {
    record("unknown custom dialog is announced, not mirrored", false, String(error.message).slice(0, 200));
  }
  await clearDialog();

  // ── ask tool (only where the host advertises it) ───────────────────────
  const offersAsk = providerEntries().some((entry) => (entry.tools ?? []).includes("ask"));
  if (!offersAsk) {
    record("ask tool round trip", true, "skipped: host offers no ask tool");
  } else {
    for (const [label, marker, needles] of [
      ["ask tool round trip", "ASK_TOOL_PROBE", ["green"]],
      ["multi-question ask round trip", "ASK_TOOL_PROBE_MULTI", ["cheese", "size"]],
    ]) {
      try {
        const since = await cursor();
        const providerBefore = providerEntries().length;
        await injectText(`please run the probe ${marker}`);
        const kb = await keyboardAfter(`${marker} keyboard`, since, 30_000);
        if (!kb) throw new Error("no ask keyboard offered");
        const labelOf = (b) => String(b.text ?? "");
        // "Already pressed" must survive a redraw: the callback value carries the dialog's
        // generation, so every edit hands out new values and comparing those makes the driver
        // tick the same box over and over (☐ to ☑ to ☐), leaving Submit permanently hidden.
        // The row's own text, minus the state marks the host moves around, is stable.
        const identity = (b) => String(b.text ?? "").replace(/[☐☑○●◉□▸❯→\s]/g, "");
        // A Submit affordance appears only once every question is answered, and a
        // multi-select question needs its own "Done selecting" row before the next tab
        // can be finished - pressing either is progress, not an answer. The Broker
        // draws these rows in English ("⏎ Submit all", "Next question ▶").
        const SKIP_ROW = /^\s*(Cancel|Other\b|⬅|Back|Next\b|Prev\b|✏️)/i;
        const isSubmit = (text) => /\b(Submit|Done|Enter)\b/i.test(text)
          && !/selecting/i.test(text);
        const isAdvance = (text) => /done selecting|\b(Prev|Next) question\b|^Question \d+\/\d+$/i.test(text);
        const labels = buttonsOf(kb).map(labelOf);
        const messageId = kb.body?.message_id ?? kb.message_id;
        // The Broker edits at most once a second, and a dialog is redrawn as soon as the host
        // finishes painting it (OMP draws the option rows a beat after focus), which retires
        // the keyboard captured the moment it opened. A user always taps the keyboard that is
        // on screen, so from here the driver only presses rows of the newest drivable one.
        let seenCalls = (await controlGet()).calls.length;
        const latestKeyboard = async (waitMs = 3_000) => {
          const deadline = Date.now() + waitMs;
          for (;;) {
            const calls = (await controlGet()).calls;
            const fresh = calls.slice(seenCalls)
              .findLast((entry) => Array.isArray(rowsOf(entry)) && isDrivable(entry));
            if (fresh) { seenCalls = calls.length; return fresh; }
            if (Date.now() >= deadline) return undefined;
            await sleep(150);
          }
        };
        let current = await latestKeyboard(2_500) ?? kb;
        // A toggle row must only tick a box: the dialog stays open until Submit.
        const toggle = buttonsOf(current).find((b) => /cheese/i.test(labelOf(b)));
        let toggleSubmitted = false;
        if (toggle) {
          await clickButton(toggle, current.body?.message_id ?? current.message_id ?? messageId);
          toggleSubmitted = providerEntries().slice(providerBefore).some((entry) =>
            entry.lastRole === "tool" || entry.lastRole === "toolResult");
        }
        const clicked = new Set(toggle ? [identity(toggle)] : []);
        let submit;
        for (let hop = 0; hop < 8 && !submit; hop += 1) {
          const rows = buttonsOf(current);
          submit = rows.find((b) => isSubmit(labelOf(b))) ?? rows.find((b) => /green/i.test(labelOf(b)));
          if (submit) break;
          // Answer everything the current tab offers before moving on: an unanswered
          // tab is what keeps Submit hidden.
          // Prefer a row that actually moves forward: the tab strip ("Question 1/2") also counts
          // as an advance, and pressing the tab already on screen changes nothing.
          const forward = (text) => /done selecting|\bNext\b|\bPrev\b|▶|⬅|◀/i.test(text);
          const option = rows.find((b) => !SKIP_ROW.test(labelOf(b)) && !isAdvance(labelOf(b)) && !clicked.has(identity(b)))
            ?? rows.find((b) => isAdvance(labelOf(b)) && forward(labelOf(b)) && !clicked.has(identity(b)))
            ?? rows.find((b) => isAdvance(labelOf(b)) && !clicked.has(identity(b)));
          if (!option) break;
          clicked.add(identity(option));
          if (!await clickButton(option, current.body?.message_id ?? current.message_id)) {
            throw new Error(`pressing "${labelOf(option)}" was never acknowledged`);
          }
          current = await latestKeyboard() ?? current;
        }
        // Some flows resolve the moment the last question is answered; others wait for
        // an explicit Submit. Press it only when the dialog offers one.
        if (submit && !await clickButton(submit, current.body?.message_id ?? current.message_id ?? messageId)) {
          throw new Error(`pressing "${String(submit.text ?? "")}" was never acknowledged`);
        }
        // The answer reaching the host is read off the next request's final
        // message (the tool result): OMP's system prompt pushes everything else
        // past the slice the mock records, so a whole-document search is blind.
        const answered = await waitForProvider(`${marker} answer reaches the model`, (entries) =>
          entries.slice(providerBefore).find((entry) =>
            needles.every((needle) => String(entry.lastText ?? "").includes(needle))), 30_000);
        const replied = await waitFor(`${marker} reply in Telegram`, (state) =>
          state.calls.slice(since).some((entry) => entry.method === "sendMessage"
            && String(entry.body?.text ?? "").includes("MOCK_OK")), { timeoutMs: 30_000 })
          .catch(() => undefined);
        const newest = providerEntries().slice(providerBefore).at(-1);
        if (!answered && !submit) {
          throw new Error(`no Submit row and no answer reached the model; labels: ${labels.slice(0, 6).join(" / ")}`);
        }
        record(label, Boolean(answered) && Boolean(replied) && !toggleSubmitted,
          `${dialectOf(kb)} · ${labels.slice(0, 4).join(" / ")} · pressed ${[...clicked].join("+") || "nothing"}`
          + (answered ? ` · tool result carried ${needles.join("+")}`
            : ` · last ${newest?.lastRole ?? "nothing"}: ${String(newest?.lastText ?? "").slice(0, 90)}`)
          + (toggleSubmitted ? " · toggle submitted the dialog" : "")
          + (replied ? "" : " · no model reply"));
      } catch (error) {
        record(label, false, String(error.message).slice(0, 200));
      }
      await clearDialog();
    }
  }

  // ── tool approval: OMP's exec prompt answered by "Deny" from Telegram ─
  // Runs only on OMP: pi has no tool-approval dialog. `write` mode auto-approves
  // read/write tools but asks before exec, so the mock's `touch` only reaches the
  // shell if the denial is ignored.
  if (host !== "omp") {
    record("tool approval answered from Telegram", true, "skipped: pi has no tool approval");
  } else {
    try {
      const markerPath = join(projectDir, "approval-marker");
      rmSync(markerPath, { force: true });
      const since = await cursor();
      await injectText(`please run PROBE_APPROVAL_BASH:${markerPath}`);
      const kb = await waitFor("approval keyboard", (state) =>
        state.calls.slice(since).findLast((entry) =>
          dialectOf(entry) === "broker"
          && buttonsOf(entry).some((b) => String(b.text ?? "").includes("Allow once"))
          && buttonsOf(entry).some((b) => String(b.text ?? "").includes("Deny"))) ?? false);
      const labels = buttonsOf(kb).map((b) => String(b.text ?? ""));
      const deny = buttonsOf(kb).find((b) => String(b.text ?? "").includes("Deny"));
      const messageId = kb.body?.message_id ?? kb.message_id;
      if (!await clickButton(deny, messageId)) {
        throw new Error(`pressing "Deny" was never acknowledged; labels: ${labels.join(" / ")}`);
      }
      await sleep(3_000);
      const executed = existsSync(markerPath);
      const cleared = await keyboardGone(messageId, 10_000);
      record("tool approval answered from Telegram", !executed && Boolean(cleared),
        `${dialectOf(kb)} · ${labels.join(" / ")}`
        + (executed ? " · marker file created despite the denial" : " · tool never ran")
        + (cleared ? " · keyboard withdrawn" : " · keyboard left on screen"));
    } catch (error) {
      record("tool approval answered from Telegram", false, String(error.message).slice(0, 200));
    }
    await clearDialog();
  }

  // ── sub-agent run: OMP's `task` tool spawns a child session that loads the plugin again ─
  // Issues #13/#15: the child must not forward its own replies to Telegram, and the
  // main session's Telegram runtime (connection and /tg) must survive the child's start.
  if (host === "omp") {
    const offersTask = providerEntries().some((entry) => (entry.tools ?? []).includes("task"));
    if (!offersTask) {
      record("sub-agent run leaves the Telegram runtime intact", true, "skipped: host offers no task tool");
    } else {
      try {
        const textOfCall = (call) => [call.body?.text, call.body?.rich_message?.markdown, call.body?.caption]
          .filter((part) => typeof part === "string").join("\n");
        const outboundMethods = ["sendMessage", "editMessageText", "sendRichMessage"];
        // ① The child's reply forwarded as a standalone assistant message. The main
        // turn's tool result may echo the child's reply inside a tool-output block, so
        // only a message whose whole visible text is the reply counts as forwarded.
        const subReplyCalls = async (since) => (await controlGet()).calls.slice(since)
          .filter((c) => outboundMethods.includes(c.method) && textOfCall(c).includes("SUBAGENT_E2E_REPLY"));

        const since = await cursor();
        const providerBefore = providerEntries().length;
        await injectText("please run the probe TASK_TOOL_PROBE");
        // OMP's write mode asks before `task`: answer "Allow once" from Telegram (not
        // "Approve task for this session"), the same allow button the exec approval uses.
        const isAllowOnce = (b) => String(b.text ?? "").trim() === "Allow once";
        const approvalCall = await waitFor("task approval keyboard", (state) =>
          state.calls.slice(since).findLast((entry) => buttonsOf(entry).some(isAllowOnce)) ?? false,
        { timeoutMs: 30_000 }).catch(() => undefined);
        if (!approvalCall) {
          const seen = (await controlGet()).calls.slice(since)
            .flatMap((c) => buttonsOf(c).map((b) => String(b.text ?? "")));
          throw new Error(`no task approval keyboard offered; buttons seen: ${seen.join(" / ")}`.slice(0, 200));
        }
        const approve = buttonsOf(approvalCall).find(isAllowOnce);
        const approvalText = String(approve.text ?? "");
        const approvalMessageId = approvalCall.body?.message_id ?? approvalCall.message_id;
        if (!await clickButton(approve, approvalMessageId)) {
          throw new Error(`pressing "${approvalText}" was never acknowledged`);
        }
        const childRequest = await waitForProvider("sub-agent request", (entries) =>
          entries.slice(providerBefore).find((entry) =>
            String(entry.userText ?? "").includes("SUBAGENT_E2E_PROMPT") && entry.lastRole === "user"), 60_000);
        if (!childRequest) throw new Error("the sub-agent never sent its request to the model");
        // The main turn is over once the model has been sent the task tool's result and
        // Telegram has been silent for 3 seconds.
        const toolResultRequest = await waitForProvider("task tool result reaches the model", (entries) =>
          entries.slice(providerBefore).find((entry) =>
            entry.lastRole === "tool" || entry.lastRole === "toolResult"), 60_000);
        if (!toolResultRequest) throw new Error("the task tool result never reached the model");
        const deadline = Date.now() + 60_000;
        let seenCount = (await controlGet()).calls.length;
        let quietSince = Date.now();
        while (Date.now() < deadline && Date.now() - quietSince < 3_000) {
          const count = (await controlGet()).calls.length;
          if (count !== seenCount) { seenCount = count; quietSince = Date.now(); }
          await sleep(250);
        }
        const forwarded = await subReplyCalls(since);
        const standalone = forwarded.filter((c) =>
          textOfCall(c).replace(/<[^>]+>/g, "").trim() === "SUBAGENT_E2E_REPLY");
        const replyObserved = forwarded.map((c) =>
          `${c.method}: ${JSON.stringify(textOfCall(c).slice(0, 80))}`).join(" | ") || "none";
        const detailOne = `child reply in ${forwarded.length} outbound call(s) [${replyObserved}]`
          + (standalone.length > 0 ? ` · ${standalone.length} forwarded as a standalone message` : " · none forwarded as a standalone message");

        // ② The Telegram runtime still answers /tg and a plain message after the child ran.
        const since2 = await cursor();
        await injectText("/tg");
        const menu = await waitFor("/tg reply after the sub-agent", (state) =>
          state.calls.slice(since2).some((c) => c.method === "sendMessage" || c.method === "sendRichMessage"),
        { timeoutMs: 30_000 })
          .then(() => true).catch(() => false);
        const since3 = await cursor();
        const providerBefore2 = providerEntries().length;
        await injectText("hello after the sub-agent");
        const newRequest = await waitForProvider("request after the sub-agent", (entries) =>
          entries.slice(providerBefore2).find((entry) =>
            String(entry.lastText ?? "").includes("hello after the sub-agent")), 30_000);
        const replied = await waitFor("reply after the sub-agent", (state) =>
          state.calls.slice(since3).some((c) => c.method === "sendMessage"
            && textOfCall(c).includes("MOCK_OK")), { timeoutMs: 30_000 })
          .then(() => true).catch(() => false);
        const detailTwo = `/tg menu ${menu ? "sent" : "missing"} · plain message ${newRequest ? "reached the model" : "never reached the model"} · reply ${replied ? "sent" : "missing"}`;

        record("sub-agent run leaves the Telegram runtime intact",
          standalone.length === 0 && menu && Boolean(newRequest) && replied,
          `task approval answered from Telegram: ${approvalText} · ${detailOne} · ${detailTwo}`);
      } catch (error) {
        record("sub-agent run leaves the Telegram runtime intact", false, String(error.message).slice(0, 200));
      }
      await clearDialog();
    }
  }

  // ── login: OMP's /login dialog shows the sign-in link in Telegram (issue #14) ─
  // The dialog opens the URL through `open`; the stub on PATH only logs the call.
  if (host === "omp") {
    const plainText = (call) => [call.body?.text, call.body?.caption, call.body?.rich_message?.markdown]
      .filter((part) => typeof part === "string").join("\n").replace(/<[^>]+>/g, "");
    const outboundMethods = ["sendMessage", "editMessageText"];
    const labelOf = (b) => String(b.text ?? "").trim().replace(/^▸\s*/, "").trim();
    const isCancel = (b) => String(b.text ?? "").trim() === "Cancel";

    // Opens /login and clicks the provider button `matches` picks. Page 1 is tried first;
    // with `search`, the keyword is typed into the list (search-as-typing, as /settings
    // search does) and the filtered list is read. Returns the cursor from before the click.
    const pickLoginProvider = async ({ label, matches, search }) => {
      const since = await cursor();
      await injectText("/login");
      const menu = await keyboardAfter(`${label}: /login list`, since, 30_000);
      if (!menu) throw new Error(`no /login list offered for ${label}`);
      if (search) await injectText(search);
      const listCall = await waitFor(`${label} in the sign-in list`, (state) =>
        state.calls.slice(since).findLast((entry) => buttonsOf(entry).some((b) => matches(labelOf(b)))) ?? false,
      { timeoutMs: 30_000 }).catch(() => undefined);
      if (!listCall) {
        const seen = (await controlGet()).calls.slice(since)
          .flatMap((c) => buttonsOf(c).map((b) => String(b.text ?? "")));
        throw new Error(`no ${label} in the sign-in list; buttons seen: ${seen.join(" / ").slice(0, 200)}`);
      }
      const since2 = await cursor();
      const provider = buttonsOf(listCall).find((b) => matches(labelOf(b)));
      await clickButton(provider, listCall.body?.message_id ?? listCall.message_id);
      return since2;
    };

    // One sign-in: pick the provider, then check the link message, the Cancel button, and
    // the stub log. Always closes the dialog and waits for it to go away before returning.
    const runLoginSignIn = async ({ name, label, matches, search, wordPattern, wordLabel }) => {
      try {
        const since2 = await pickLoginProvider({ label, matches, search });
        const linkCall = await waitFor(`${label} sign-in link in Telegram output`, (state) =>
          state.calls.slice(since2).findLast((entry) =>
            outboundMethods.includes(entry.method) && /https?:\/\/\S+/.test(plainText(entry))) ?? false,
        { timeoutMs: 30_000 }).catch(() => undefined);
        if (!linkCall) {
          const lastOut = (await controlGet()).calls.slice(since2)
            .filter((c) => outboundMethods.includes(c.method)).map(plainText).pop() ?? "none";
          throw new Error(`no sign-in link sent to Telegram; last outbound text: ${lastOut.slice(0, 200)}`);
        }
        const linkText = plainText(linkCall);
        const url = linkText.match(/https?:\/\/\S+/)[0];
        const hasWord = wordPattern.test(linkText);
        const outbound = (await controlGet()).calls.slice(since2)
          .filter((c) => outboundMethods.includes(c.method)).map(plainText);
        const promptLine = outbound.flatMap((text) => text.split("\n")).find((line) => /key|token/i.test(line));
        const promptDetail = promptLine ? `input prompt: "${promptLine.trim().slice(0, 120)}"` : "no input prompt in the text";

        const dialogCall = await waitFor(`${label} sign-in dialog with Cancel`, (state) =>
          state.calls.slice(since2).findLast((entry) => buttonsOf(entry).some(isCancel)) ?? false,
        { timeoutMs: 15_000 }).catch(() => undefined);
        if (!dialogCall) throw new Error("no Cancel button left on the sign-in dialog");
        await clickButton(buttonsOf(dialogCall).find(isCancel), dialogCall.body?.message_id ?? dialogCall.message_id);
        await sleep(1500);

        // Read after Cancel: the stub's open() call can land after the link message.
        const openLogPath = join(runDir, "open-calls.log");
        const openedLog = existsSync(openLogPath) ? readFileSync(openLogPath, "utf8") : "";
        const stubDetail = openedLog.includes("https://")
          ? `host tried to open the browser (caught by the stub): ${openedLog.match(/https?:\/\/\S+/)[0].slice(0, 80)}`
          : "no open() call recorded";

        record(name, hasWord,
          `link ${url.slice(0, 80)} · "${wordLabel}" ${hasWord ? "present" : "missing"} · ${promptDetail} · ${stubDetail}`);
      } catch (error) {
        record(name, false, String(error.message).slice(0, 200));
      }
      await clearDialog();
      await sleep(1500);
    };

    await runLoginSignIn({
      name: "login (api key) sign-in link is shown in Telegram",
      label: "DeepSeek",
      matches: (text) => /deepseek/i.test(text),
      search: "deepseek",
      wordPattern: /browser|key/i,
      wordLabel: "browser or key",
    });
    await runLoginSignIn({
      name: "login sign-in link is shown in Telegram",
      label: "OpenRouter",
      matches: (text) => text === "OpenRouter",
      wordPattern: /browser/i,
      wordLabel: "browser",
    });
  }

  // ── pi-goal dialogs (extension `custom`, the /goals parity case) ───────
  if (GOAL) {
    const trigger = GOAL === "confirm" ? "PROBE_GOAL_CONFIRM"
      : (GOAL === "question" ? "PROBE_GOAL_QUESTION" : "PROBE_GOAL_QUESTIONNAIRE");
    try {
      const since = await cursor();
      await injectText(`/goals ${trigger}`);
      const kb = await keyboardAfter(`/goals keyboard`, since, 30_000);
      if (!kb) throw new Error("no keyboard offered for /goals");
      const first = buttonsOf(kb).find((b) => !/Cancel|Back/i.test(String(b.text ?? "")));
      const messageId = kb.body?.message_id ?? kb.message_id;
      await clickButton(first, messageId);
      const cleared = await keyboardGone(messageId, 10_000);
      record(`/goals ${GOAL} answered from Telegram`, Boolean(cleared),
        `${dialectOf(kb)} · ${buttonsOf(kb).map((b) => b.text).slice(0, 4).join(" / ")}`
        + `${cleared ? " · keyboard withdrawn" : " · keyboard left on screen"}`);
    } catch (error) {
      record(`/goals ${GOAL} answered from Telegram`, false, String(error.message).slice(0, 200));
    }
    await clearDialog();
  }

  killSession(session);
  return { results, ok: results.every((r) => r.ok) };
}


async function main() {
  if (HOST_ARG !== "pi" && HOST_ARG !== "omp" && HOST_ARG !== "both") {
    throw new Error(`--host must be pi, omp or both, got ${HOST_ARG}`);
  }

  // A leftover run (--keep, or a zombie script) holding these ports would silently steal
  // the injected updates: this suite would then read another host's chat. Fail with a name.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive - kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(ROOT, { recursive: true });
  const servers = [
    startServer("mock-telegram", "mock-telegram.mjs", ["--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")]),
    startServer("mock-provider", "mock-provider.mjs", ["--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"), "--reply", "MOCK_OK"]),
  ];
  await sleep(1_200);
  try {
    const state = await controlGet("/_control/state");
    if (!state) throw new Error("mock Telegram did not answer /_control/state");
  } catch (error) {
    for (const server of servers) server.proc.kill();
    throw new Error(`mock servers unavailable on ${TG_PORT}/${PROVIDER_PORT}: ${error.message}`);
  }
  console.log("mocks ready: telegram + provider\n");

  const hosts = HOST_ARG === "both" ? ["pi", "omp"] : [HOST_ARG];
  const pending = loadPending();
  let regressions = 0;
  let pendingSteps = 0;
  for (const host of hosts) {
    if (!existsSync(join(REPO, "node_modules/.bin/pi"))) {
      throw new Error("node_modules/.bin/pi is missing; run npm install first");
    }
    console.log(`=== ${host} ===`);
    const run = await runHost(host, servers);
    const verdict = classify(pending, "dialogs", host, run.results);
    console.log(`${verdict.regressions.length === 0 ? "PASS" : "FAIL"} ${host}`
      + (verdict.expected.length ? ` (${verdict.expected.length} pending)` : "") + "\n");
    for (const step of verdict.regressions) console.log(`  ✗ ${step.name} — ${step.detail}`);
    for (const step of verdict.expected) console.log(`  ○ ${step.name} — pending ${step.task}`);
    for (const step of verdict.nowPassing) {
      console.log(`  ↑ ${step.name} — passes now; remove from pending-migration.json (${step.task})`);
    }
    regressions += verdict.regressions.length;
    pendingSteps += verdict.expected.length;
  }

  for (const server of servers) server.proc.kill();
  if (!KEEP) rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  console.log(`PENDING=${pendingSteps}`);
  console.log(`DIALOGS_ACCEPTANCE=${regressions}`);
  process.exit(regressions === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
