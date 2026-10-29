#!/usr/bin/env node
/**
 * Full command acceptance: isolated tmux + real pi/OMP + mock Bot API + mock
 * provider. Drives every command the bot advertises (setMyCommands), the
 * plugin's hidden management commands, and every nested menu level reachable
 * from /tg, /model, /scoped-models, /login, /logout, /settings.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-commands.mjs [--host pi|omp|both]
 *     [--pi-bin <path>] [--tg-port 9950] [--provider-port 9951]
 *     [--timeout 30] [--keep]
 *
 * Exit code is non-zero when a step that is not on scripts/e2e/pending-migration.json fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { classify, loadPending } from "./pending.mjs";
import { validateTelegramCalls } from "./telegram-contract.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const HOST_ARG = argValue("--host", "both");
const KEEP = process.argv.includes("--keep");
const PHASE_ARG = argValue("--phase", "");
const TG_PORT = Number(argValue("--tg-port", "9950"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9951"));
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "30")) * 1000;
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const ROOT = process.env.PITG_E2E_COMMANDS_ROOT || "/tmp/pitg-e2e-commands";

// Commands that reach an external service or upload the test session (share links,
// collaboration sessions, self-update). The suite never runs them.
const NETWORK_COMMANDS = new Set(["/share", "/collab", "/join", "/leave", "/update", "/upgrade"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const RESPONSE_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendDocument", "editMessageText", "editMessageReplyMarkup",
]);

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
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last).slice(0, 600)})`);
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function seed(host, runDir) {
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
      token: `${host === "pi" ? "333333" : "444444"}:COMMANDS_TOKEN`,
      allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`, enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function startHost(host, projectDir, agentDir, paneLog, session) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...(host === "omp" ? { PITG_TREE_DUMP: join(dirname(paneLog), "tree-dump.jsonl") } : {}),
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = host === "omp"
    ? [OMP_CLI, "-e", PLUGIN, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"]
    : [PI_CLI, "--no-skills", "--no-extensions", "-e", PLUGIN, "--provider", "mock", "--model", "mock-model"];
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  const result = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
  if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${shq(paneLog)}`);
  return result;
}

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
// The mock records a rejected send with a non-empty `rejected` array: that
// message never reached the chat, so its keyboard must never be picked.
const wasRejected = (call) => Array.isArray(call?.rejected) && call.rejected.length > 0;
// Brokered dialogs carry `tgplus:dlg:` keyboards whose `c/t/v/m` ops are list
// rows, `k` a key name and `x` cancel. The old screen-mirror keyboard
// (`tgplus:tui:`) was removed (D2): a stale copy only gets the expiry notice.
const DIALOG_CANCEL = /^tgplus:dlg:[^:]+:\d+:x$/;
const hasDialog = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:dlg:"));
const isControllable = (call) => hasDialog(call);
const hasUi = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:ui:"));
const lastKeyboardCall = (state, since = 0) => state.calls.slice(since).findLast((c) => Array.isArray(rowsOf(c)) && !wasRejected(c));
const signature = (call) => `${String(call?.body?.text ?? "").slice(0, 200)}|${buttonsOf(call).map((b) => `${b.text}:${b.callback_data}`).join(",")}`;

async function runHost(host, label, phase = "main") {
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, "-");
  const session = `pitg-cmd-${slug}`;
  const runDir = join(ROOT, `run-${slug}`);
  const paneLog = join(runDir, "pane.log");
  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");

  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const { agentDir, projectDir } = seed(host, runDir);
  const start = startHost(host, projectDir, agentDir, paneLog, session);
  if (start.status !== 0) {
    record("start host in tmux", false, start.stderr?.trim());
    return { results, ok: false, session, runDir };
  }
  record("start host in tmux", true, session);

  let updateId = 5000;
  let messageId = 9000;
  const injectMessage = async (text) => {
    const id = messageId++;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        message: {
          message_id: id, date: Math.floor(Date.now() / 1000),
          chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" },
          text,
        },
      }],
    });
    return id;
  };

  const injectCallback = async (data, targetMessageId) => {
    const callbackId = `cb-${updateId}`;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId, from: { id: 42, is_bot: false, first_name: "E2E" },
          message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
          chat_instance: "e2e", data,
        },
      }],
    });
    return callbackId;
  };

  const paneHas = (needle) => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "").includes(needle);
  const hostAlive = () => tmux("has-session", "-t", session).status === 0;

  try {
    await waitFor("plugin authenticates", (state) => state.calls.some((c) => c.method === "getMe"), 60_000);
    record("plugin authenticates", true);
  } catch (error) {
    record("plugin authenticates", false, String(error.message).slice(0, 300));
    return { results, ok: false, session, runDir };
  }

  // ── Bot menu inventory ────────────────────────────────────────────────
  let menuCommands = [];
  try {
    const call = await waitFor("BotMenu published", (state) =>
      state.calls.findLast((entry) => entry.method === "setMyCommands" && Array.isArray(entry.body?.commands)), 30_000);
    menuCommands = call.body.commands.map((c) => `/${c.command}`);
    record("BotMenu published", menuCommands.length > 0, `${menuCommands.length} commands`);
  } catch (error) {
    record("BotMenu published", false, String(error.message).slice(0, 300));
  }

  const cursor = async () => (await controlGet()).calls.length;

  /**
   * Latest state of one Telegram message, folded from every later send and edit of it.
   * Telegram semantics: an edit without reply_markup removes the keyboard.
   */
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
      ? {
        method: "sendMessage",
        message_id: messageId,
        body: { message_id: messageId, text: current.text, reply_markup: { inline_keyboard: current.rows } },
      }
      : undefined;
  };
  const latestState = async (messageId) => foldState((await controlGet()).calls, messageId);
  /** Wait until a command's own message (the ack, edited in place) satisfies `predicate`. */
  const awaitMessage = (label, messageId, predicate, timeoutMs = STEP_TIMEOUT_MS) => waitFor(label, (state) => {
    const current = foldState(state.calls, messageId);
    return current && predicate(current) ? current : false;
  }, timeoutMs);
  const isNav = (button) => /^tgplus:dlg:[^:]+:\d+:p(?::|$)/.test(String(button.callback_data ?? ""));
  // A text panel's own Close button (described-panel adapter, `c:close`) is the way out of it.
  const PANEL_CLOSE = /^tgplus:dlg:[^:]+:\d+:c:close$/;
  const isCancel = (button) => DIALOG_CANCEL.test(String(button.callback_data ?? ""))
    || (PANEL_CLOSE.test(String(button.callback_data ?? "")) && /^Close$/.test(String(button.text ?? "")));
  /** Buttons that choose something: no paging, no cancel, no `n/m` marker. */
  const choicesOf = (call) => buttonsOf(call).filter((b) => !isNav(b) && !isCancel(b) && !/^\d+\/\d+$/.test(String(b.text ?? "")));
  /** Visible text of a command message without its `▶️ /cmd` header and `✓ Done` marker. */
  const panelBody = (text) => String(text ?? "")
    .replace(/^\s*<b>▶️[^<]*<\/b>/, "")
    .replace(/✓ Done/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  /**
   * Dispatch a command and return its acknowledgement: the sendMessage that replies to the
   * injected update. The command's dialog or result is an edit of that same message, read
   * with awaitMessage/latestState.
   */
  const dispatch = async (command, { timeoutMs = STEP_TIMEOUT_MS } = {}) => {
    const since = await cursor();
    const injectedId = await injectMessage(command);
    return waitFor(`response to ${command}`, (state) => state.calls.slice(since).find((entry) =>
      entry.method === "sendMessage"
      && !wasRejected(entry)
      && entry.body?.reply_parameters?.message_id === injectedId) ?? false, timeoutMs);
  };

  /** Click a button and wait for the next keyboard/text produced for it. */
  const click = async (button, targetMessageId, { timeoutMs = STEP_TIMEOUT_MS } = {}) => {
    const since = await cursor();
    const callbackId = await injectCallback(String(button.callback_data), targetMessageId);
    await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId), timeoutMs);
    const call = await waitFor(`follow-up after ${button.text}`, (state) => {
      // Only this menu's message (or a fresh send) answers the click; stray
      // mirror edits from leftover TUI overlays must not be mistaken for it.
      const hit = state.calls.slice(since).findLast((entry) =>
        !wasRejected(entry) && RESPONSE_METHODS.has(entry.method) && entry.body
        && (entry.method === "sendMessage" || entry.body.message_id === targetMessageId)
        && (Array.isArray(entry.body.reply_markup?.inline_keyboard) || typeof entry.body.text === "string"));
      return hit ?? false;
    }, timeoutMs);
    return call;
  };
  /** A cancel whose follow-up may legitimately not come: never throws, short wait. */
  const cancelQuietly = (button, messageId) => click(button, messageId, { timeoutMs: 6_000 }).catch(() => undefined);

  /**
   * Wait until a command's own message stops changing: its dialog or result arrives as edits
   * after the ack, so settling before that would miss the dialog it opens.
   */
  const quiesce = async (messageId, { quietMs = 1500, maxMs = 15_000 } = {}) => {
    const started = Date.now();
    let key;
    let changedAt = Date.now();
    while (Date.now() - started < maxMs) {
      const current = await latestState(messageId);
      const next = JSON.stringify(current?.body ?? null);
      if (next !== key) {
        key = next;
        changedAt = Date.now();
      } else if (Date.now() - changedAt >= quietMs) {
        return;
      }
      await sleep(300);
    }
  };

  const findButton = (call, pattern) => buttonsOf(call).find((b) => pattern.test(String(b.text ?? "")));

  /**
   * Leave any open dialog or menu so the next command starts clean. Every message the bot
   * sent is checked, newest first: a dialog is an edit of its command's message, so an open
   * dialog can sit on any of them. Page-only keyboards are ignored.
   */
  const settle = async () => {
    const tried = new Set();
    let clicks = 0;
    let escaped = false;
    while (clicks < 8) {
      const state = await controlGet();
      // Recovery: a dialog the host opened that Telegram never brokered blocks every later
      // command, and the plugin then says so. Close it in the terminal (Escape) once per settle.
      const blocked = state.calls.slice(-6).some((c) => c.method === "sendMessage"
        && /unanswered dialog/i.test(String(c.body?.text ?? "")));
      if (blocked && !escaped) {
        escaped = true;
        tmux("send-keys", "-t", session, "Escape");
        await sleep(800);
        continue;
      }
      const sent = [...new Set(state.calls
        .filter((c) => c.method === "sendMessage" && !wasRejected(c))
        .map((c) => c.message_id))].reverse();
      let open;
      for (const id of sent) {
        const current = foldState(state.calls, id);
        const cancel = current && buttonsOf(current).find(isCancel);
        if (cancel && !tried.has(`${id}|${cancel.callback_data}`)) {
          open = { id, cancel };
          break;
        }
      }
      if (open) {
        tried.add(`${open.id}|${open.cancel.callback_data}`);
        clicks += 1;
        await cancelQuietly(open.cancel, open.id);
        continue;
      }
      // Plain keyboards (the /tg menus): Back, Close or Cancel as before.
      const call = lastKeyboardCall(state);
      if (!call || hasDialog(call)) return;
      const back = findButton(call, /^(⬅️ Back|❌ Close|Cancel)$/);
      if (!back) return;
      const target = call.body?.message_id ?? call.message_id;
      const key = `menu|${target}|${back.callback_data}`;
      if (tried.has(key)) return;
      tried.add(key);
      clicks += 1;
      await cancelQuietly(back, target);
    }
  };

  if (phase === "quit" || phase === "exit" || phase === "disconnect") {
    if (phase === "quit") {
      try {
        const prompt = await dispatch("/quit");
        const yes = findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i);
        const labels = buttonsOf(prompt).map((b) => b.text).join(" / ");
        if (yes) await click(yes, prompt.body?.message_id ?? prompt.message_id).catch(() => undefined);
        const outcome = await waitFor("quit outcome", (state) => {
          if (!hostAlive()) return "exited";
          const note = state.calls.findLast((c) => /Shutdown requested/i.test(String(c.body?.text ?? "")));
          return note ? "requested" : false;
        }, 20_000).catch(() => undefined);
        record("command /quit shuts down", outcome === "exited" || outcome === "requested",
          `${outcome ?? "no outcome"} · buttons: ${labels || "(none)"}`);
      } catch (error) {
        record("command /quit shuts down", !hostAlive(), String(error.message).slice(0, 200));
      }
    } else if (phase === "exit") {
      const menu = await waitFor("BotMenu published", (state) =>
        state.calls.findLast((entry) => entry.method === "setMyCommands" && Array.isArray(entry.body?.commands)), 30_000).catch(() => undefined);
      const advertised = menu?.body?.commands?.some((entry) => entry.command === "exit");
      if (!advertised) {
        record("command /exit (not advertised by this host)", true, "skipped: host has no /exit");
      } else {
        try {
          // /exit confirms before it shuts the host down, so the prompt has to be
          // answered from Telegram before anything else can happen.
          const prompt = await dispatch("/exit");
          const yes = findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i);
          const labels = buttonsOf(prompt).map((b) => b.text).join(" / ");
          if (yes) await click(yes, prompt.body?.message_id ?? prompt.message_id).catch(() => undefined);
          const outcome = await waitFor("exit outcome", (state) => {
            if (!hostAlive()) return "exited";
            const note = state.calls.findLast((c) => /Shutdown requested/i.test(String(c.body?.text ?? "")));
            return note ? "requested" : false;
          }, 20_000).catch(() => undefined);
          record("command /exit shuts down", outcome === "exited" || outcome === "requested",
            `${outcome ?? "no outcome"} · buttons: ${labels || "(none)"}`);
        } catch (error) {
          record("command /exit shuts down", !hostAlive(), String(error.message).slice(0, 200));
        }
      }
    } else {
      // The flat tg-cwd-disconnect command is gone (T4.10): disconnect goes
      // through the /tg menu - /tg → 📁 Project → Disconnect row → confirm.
      try {
        const since = await cursor();
        await dispatch("/tg");
        const mainMenu = await waitFor("/tg main menu", (state) =>
          state.calls.slice(since).findLast((entry) => !wasRejected(entry) && findButton(entry, /🤖 Bots/)) ?? false);
        const projectButton = findButton(mainMenu, /📁 Project/);
        if (!projectButton) throw new Error(`no 📁 Project entry: ${buttonsOf(mainMenu).map((b) => b.text).join(" / ")}`);
        const project = await click(projectButton, mainMenu.body?.message_id ?? mainMenu.message_id);
        const disconnectButton = findButton(project, /→ Disconnect$/);
        if (!disconnectButton) throw new Error(`no disconnect row: ${buttonsOf(project).map((b) => b.text).join(" / ")}`);
        const prompt = await click(disconnectButton, project.body?.message_id ?? project.message_id);
        const yes = findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i);
        if (!yes) throw new Error(`no confirm button: ${buttonsOf(prompt).map((b) => b.text).join(" / ")}`);
        await click(yes, prompt.body?.message_id ?? prompt.message_id).catch(() => undefined);
        // Confirming first strips the menu keyboard (editMessageReplyMarkup,
        // no text); the notice the user actually sees is a separate
        // sendMessage afterwards - judge on that, not the click's response.
        const notice = await waitFor("disable notice", (state) =>
          state.calls.slice(since).find((entry) => entry.method === "sendMessage"
            && /Telegram disconnected for this folder/i.test(String(entry.body?.text ?? ""))) ?? false)
          .catch(() => undefined);
        record("menu Project → Disconnect disables the project", Boolean(notice),
          notice ? String(notice.body?.text ?? "").replace(/\s+/g, " ").slice(0, 90) : "no disable notice after confirm");
        await sleep(1500);
        record("host stays alive after disconnect", hostAlive());
      } catch (error) {
        record("menu Project → Enabled disables the project", false, String(error.message).slice(0, 200));
      }
    }
    const paneTail = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(paneTail));
    if (!KEEP) { killSession(session); try { await controlPost("/_control/reset"); } catch { /* ignore */ } }
    return { results, ok: results.every((r) => r.ok), session, runDir };
  }

  if (phase === "window") {
    // Compare the /new -> /name hand-off window across hosts/versions, and
    // prove a single Telegram /new yields exactly one new session. The next
    // command is sent immediately after /new's confirmation/ack.
    const sessionsDir = join(runDir, "agent", "sessions");
    const countSessionFiles = () => {
      try {
        return readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
          .filter((name) => String(name).endsWith(".jsonl")).length;
      } catch {
        return 0;
      }
    };
    const sessionsBefore = countSessionFiles();
    const startedAt = Date.now();
    let prompt;
    try {
      prompt = await dispatch("/new");
    } catch (error) {
      record("window /new response", false, String(error.message).slice(0, 160));
    }
    const yes = prompt ? findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i) : undefined;
    if (yes) await click(yes, prompt.body?.message_id ?? prompt.message_id, { timeoutMs: 20_000 }).catch(() => undefined);
    const clickAt = Date.now();
    let reply;
    try {
      reply = await dispatch("/name window-probe", { timeoutMs: 60_000 });
    } catch {
      reply = undefined;
    }
    const text = String(reply?.body?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120);
    record("window /new -> /name hand-off", Boolean(reply),
      `${Date.now() - clickAt}ms after /new, ${Date.now() - startedAt}ms total · ${text}`);

    // A single Telegram /new must create exactly one new session and emit one
    // ack. A turn flushes the new session's .jsonl, so the file count shows how
    // many sessions /new created; the ack count shows how many times it ran. A
    // second file or ack means the unconfirmed /new update was re-delivered to
    // the replacement runtime and run again, because the cursor was not
    // committed before the in-process session replacement.
    await dispatch("after new flush", { timeoutMs: 60_000 }).catch(() => undefined);
    await sleep(1000);
    const sessionsAfter = countSessionFiles();
    const newAcks = (await controlGet()).calls
      .filter((c) => c.method === "sendMessage" && /▶️\s*\/new/.test(String(c.body?.text ?? ""))).length;
    record("window /new creates exactly one session",
      sessionsAfter - sessionsBefore === 1 && newAcks === 1,
      `sessions +${sessionsAfter - sessionsBefore}, /new acks=${newAcks}`);

    // Z1: pi edits the "▶️ /new" ack in place once the new runtime is up, so
    // the outcome reaches the chat instead of only the terminal.
    if (host === "pi") {
      try {
        await waitFor("/new result delivered", (state) =>
          state.calls.some((c) => c.method === "editMessageText"
            && /New session started/.test(String(c.body?.text ?? ""))), 30_000);
        record("/new result delivered", true);
      } catch (error) {
        record("/new result delivered", false, String(error.message).slice(0, 200));
      }
      await settle();
    }

    const paneTail = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(paneTail));
    if (!KEEP) { killSession(session); try { await controlPost("/_control/reset"); } catch { /* ignore */ } }
    return { results, ok: results.every((r) => r.ok), session, runDir };
  }

  // ── Stage 3: OMP /mcp report reaches the chat as command output ───────
  if (host === "omp") {
    const bodyText = (entry) => String(entry?.body?.text ?? "");
    const label = "stage3 /mcp report reaches the chat";
    try {
      const since = await cursor();
      await dispatch("/mcp");
      const body = await waitFor(label, (state) =>
        state.calls.slice(since).find((entry) =>
          !wasRejected(entry)
          && (entry.method === "sendMessage" || entry.method === "editMessageText")
          && /MCP Server Management[\s\S]*\/mcp add/.test(bodyText(entry))) ?? false, 15_000).catch(() => undefined);
      record(label, Boolean(body),
        bodyText(body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record(label, false, String(error.message).slice(0, 200));
    }
  }

  // ── Stage 3: OMP /agents dashboard reaches the chat (list or text) ────
  if (host === "omp") {
    const bodyText = (entry) => String(entry?.body?.text ?? "");
    const label = "stage3 /agents dashboard reaches the chat";
    try {
      const since = await cursor();
      await dispatch("/agents");
      const body = await waitFor(label, (state) =>
        state.calls.slice(since).find((entry) =>
          !wasRejected(entry)
          && (entry.method === "sendMessage" || entry.method === "editMessageText")
          // The TSP adapter presents /agents as an actionable `tgplus:dlg:`
          // list; the old read-only <pre> dashboard also still counts.
          && (/Agents/i.test(bodyText(entry)) && hasDialog(entry)
            || /Agents[\s\S]*<pre>[\s\S]*All agents/.test(bodyText(entry)))) ?? false, 15_000).catch(() => undefined);
      record(label, Boolean(body),
        bodyText(body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record(label, false, String(error.message).slice(0, 200));
    }
    // The list stays open after this step; without settling, the next
    // injected chat line would be consumed as the list's search term
    // (search-as-typing is the expected Z2 behaviour).
    await settle();
  }

  // ── Scripted `ask` tool round trip ─────────────────────────────────────
  // The mock provider answers the marker message with a real tool_call for the
  // host's `ask` tool, so the model→tool→UI→answer→model loop is exercised.
  try {
    const since = await cursor();
    await injectMessage("please run the ask probe ASK_TOOL_PROBE");
    const mirror = await waitFor("ask prompt mirrored", (state) =>
      state.calls.slice(since).findLast((entry) =>
        !wasRejected(entry) && Array.isArray(rowsOf(entry)) && (isControllable(entry) || hasUi(entry))), 25_000)
      .catch(() => undefined);
    if (!mirror) {
      const providerLog = join(ROOT, "provider.jsonl");
      const askedTool = existsSync(providerLog)
        && readFileSync(providerLog, "utf8").split("\n").filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return {}; } })
          .some((entry) => (entry.tools ?? []).includes("ask"));
      record("ask tool prompt reaches Telegram", !askedTool,
        askedTool ? "tool offered but nothing reached the chat" : "skipped: host offers no ask tool");
    } else {
      const labels = buttonsOf(mirror).map((b) => String(b.text ?? ""));
      record("ask tool prompt reaches Telegram", /red|green|blue/.test(labels.join(" ")),
        String(mirror.body?.text ?? "").replace(/<[^>]+>/g, "") + " · " + labels.slice(0, 4).join(" / "));
      const green = buttonsOf(mirror).find((b) => /green/.test(String(b.text ?? ""))) ?? buttonsOf(mirror)[0];
      const mirrorId = mirror.body?.message_id ?? mirror.message_id;
      if (green) {
        const pickSince = await cursor();
        await click(green, mirrorId);
        const reply = await waitFor("ask answer reaches the model", (state) =>
          state.calls.slice(pickSince).findLast((c) => c.method === "sendMessage" && /MOCK_OK/i.test(String(c.body?.text ?? ""))) ?? false,
          30_000).catch(() => undefined);
        record("ask answered from Telegram", Boolean(reply),
          `${hasDialog(mirror) ? "broker" : "native"} · ${reply ? "turn completed" : "no follow-up reply"}`);
      }
    }
    await settle();
  } catch (error) {
    record("ask tool round trip", false, String(error.message).slice(0, 220));
  }

  // ── Stage 1: output-only commands must return real body text ──────────
  // These assertions run before /reload and /new so the gateway has a stable
  // host. A response that is only the command ack does not pass.
  if (host === "pi") {
    const bodyText = (entry) => String(entry?.body?.text ?? "");
    const waitBody = (label, since, pattern, timeoutMs = 25_000) =>
      waitFor(label, (state) =>
        state.calls.slice(since).find((entry) =>
          (entry.method === "sendMessage" || entry.method === "editMessageText")
          && pattern.test(bodyText(entry))) ?? false, timeoutMs).catch(() => undefined);

    try {
      let since = await cursor();
      await dispatch("/session");
      const sessionBody = await waitBody("session body", since, /Session Info|Messages:/i);
      record("stage1 /session body has session details", Boolean(sessionBody),
        bodyText(sessionBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /session body has session details", false, String(error.message).slice(0, 200));
    }

    try {
      let since = await cursor();
      await dispatch("/name stage-one");
      await sleep(800);
      since = await cursor();
      await dispatch("/session");
      const namedBody = await waitBody("named session body", since, /Name:\s*stage-one/i);
      record("stage1 /name x is reflected by /session", Boolean(namedBody),
        bodyText(namedBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /name x is reflected by /session", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/changelog");
      const changelogBody = await waitBody("changelog body", since, /\b\d+\.\d+\.\d+\b/);
      record("stage1 /changelog body has a version", Boolean(changelogBody),
        bodyText(changelogBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /changelog body has a version", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/export");
      const exportBody = await waitBody("export body", since, /Session exported to:/i);
      const text = bodyText(exportBody);
      const path = text.match(/Session exported to:\s*([^<\s]+)/)?.[1];
      const resolved = path
        ? (existsSync(path) ? path : join(projectDir, path))
        : undefined;
      const doc = await waitFor("export document upload", (state) =>
        state.calls.slice(since).find((entry) => entry.method === "sendDocument" && Number(entry.body?._bytes ?? 0) > 0) ?? false,
        20_000).catch(() => undefined);
      record("stage1 /export returns an existing file", Boolean(resolved && existsSync(resolved) && doc),
        `${resolved ?? path ?? "(no path)"} · uploaded=${Boolean(doc)}`);
    } catch (error) {
      record("stage1 /export returns an existing file", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/compact");
      const compactBody = await waitBody("compact completion", since, /\/compact[\s\S]*(?:Compaction|compacted|Nothing to compact|✓ Done)/i, 30_000);
      record("stage1 /compact returns completion output", Boolean(compactBody),
        bodyText(compactBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /compact returns completion output", false, String(error.message).slice(0, 200));
    }
  }

  // ── Every advertised command ──────────────────────────────────────────
  const terminating = new Set(["/quit", "/exit"]);
  // What one command sent back to its own update, and to its own ack message.
  const footprintOf = (command, calls, replyId, ackId) => {
    const own = calls.filter((c) => !wasRejected(c) && c.body && (
      (c.method === "sendMessage" && replyId !== undefined && c.body.reply_parameters?.message_id === replyId)
      || ((c.method === "editMessageText" || c.method === "editMessageReplyMarkup") && c.body.message_id === ackId)));
    return {
      command,
      sends: own.filter((c) => c.method === "sendMessage").length,
      boxed: own.filter((c) => /[╭╮╰╯│─]/.test(String(c.body.text ?? ""))).length,
    };
  };
  const footprints = [];
  // Network commands are advertised but never sent; see NETWORK_COMMANDS.
  for (const command of menuCommands) {
    if (terminating.has(command)) continue; // covered by their own phases
    if (NETWORK_COMMANDS.has(command)) {
      record(`command ${command}`, true, "skipped: network command, not run in tests");
      continue;
    }
    try {
      const since = await cursor();
      const ack = await dispatch(command);
      await quiesce(ack.message_id);
      await settle();
      await sleep(500);
      const calls = (await controlGet()).calls;
      const final = foldState(calls, ack.message_id);
      const shown = panelBody(final?.body.text ?? ack.body?.text).slice(0, 80);
      const buttons = final ? buttonsOf(final).length : 0;
      record(`command ${command}`, true, `${shown}${buttons ? ` [${buttons} buttons]` : ""}`);
      footprints.push(footprintOf(command, calls.slice(since), ack.body?.reply_parameters?.message_id, ack.message_id));
    } catch (error) {
      record(`command ${command}`, false, String(error.message).slice(0, 240));
    }
    if (!hostAlive()) {
      record(`host alive after ${command}`, false, "tmux session went away");
      return { results, ok: false, session, runDir };
    }
  }

  // ── Goal: one message per command ─────────────────────────────────────
  {
    const bad = footprints.filter((f) => f.sends > 1 || f.boxed > 0);
    record("goal: one message per command", bad.length === 0,
      bad.length === 0
        ? `${footprints.length} commands: each sent at most one message, no box drawing`
        : `${bad.length}/${footprints.length} commands: ${bad.slice(0, 8).map((f) => `${f.command} sent=${f.sends} box=${f.boxed}`).join(" · ")}`);
  }

  // ── Goal: command text panels carry content (OMP) / Session Info (pi) ─
  {
    const panelCommands = host === "omp" ? ["/session", "/changelog", "/jobs"] : ["/session"];
    const panels = [];
    for (const command of panelCommands) {
      if (!menuCommands.includes(command)) {
        panels.push({ command, text: "", ok: false, why: "not advertised" });
        continue;
      }
      try {
        const ack = await dispatch(command);
        const filled = await awaitMessage(`${command} panel content`, ack.message_id,
          (cur) => panelBody(cur.body.text).length > 0, 20_000).catch(() => undefined);
        await settle();
        const final = filled ?? await latestState(ack.message_id);
        const text = panelBody(final?.body.text);
        panels.push({ command, text, ok: text.length > 0, why: "" });
      } catch (error) {
        panels.push({ command, text: "", ok: false, why: String(error.message).slice(0, 120) });
      }
    }
    const describe = (p) => `${p.command}: ${p.ok ? `"${p.text.slice(0, 70)}"` : `empty${p.why ? ` (${p.why})` : ""}`}`;
    if (host === "omp") {
      record("goal: OMP text panels have content", panels.every((p) => p.ok), panels.map(describe).join(" · "));
    } else {
      const session = panels.find((p) => p.command === "/session");
      record("goal: pi chat-area command text", Boolean(session?.text.includes("Session Info")), session ? describe(session) : "no /session");
    }
  }

  // ── Goal: long output is paged in place (one message, Next ▶ edits it) ─
  try {
    const since = await cursor();
    const ack = await dispatch("/changelog");
    const replyId = ack.body?.reply_parameters?.message_id;
    const paged = await awaitMessage("changelog pages", ack.message_id,
      (cur) => buttonsOf(cur).some((b) => /Next ▶/.test(String(b.text ?? ""))), 25_000).catch(() => undefined);
    const sends = (await controlGet()).calls.slice(since)
      .filter((c) => c.method === "sendMessage" && !wasRejected(c) && replyId !== undefined && c.body?.reply_parameters?.message_id === replyId).length;
    const next = paged ? findButton(paged, /^Next ▶$/) : undefined;
    let page2;
    if (next) {
      await click(next, ack.message_id).catch(() => undefined);
      await sleep(1000);
      page2 = foldState((await controlGet()).calls, ack.message_id);
    }
    const onPage2 = /Page 2\//.test(String(page2?.body.text ?? ""));
    record("goal: long output is paged in place", Boolean(paged) && sends === 1 && Boolean(next) && onPage2,
      `sendMessage replies=${sends} · ${next ? "Next ▶ present" : "no Next ▶ button"} · after tap: ${onPage2 ? "Page 2 in same message" : `"${panelBody(page2?.body.text).slice(0, 80)}"`}`);
    await settle();
  } catch (error) {
    record("goal: long output is paged in place", false, String(error.message).slice(0, 220));
  }

  // ── Nested menus: /tg → level 2 → level 3 → level 4 ───────────────────
  const openMain = async () => {
    const since = await cursor();
    const call = await dispatch("/tg");
    const state = await controlGet();
    // Scope to this dispatch: panel mirrors from earlier commands now carry
    // keyboards (⎋ Close) and must not be mistaken for the /tg menu.
    const menu = state.calls.slice(since).findLast((entry) => !wasRejected(entry) && findButton(entry, /🤖 Bots/));
    return menu ?? lastKeyboardCall(state, since) ?? call;
  };
  const menuStep = async (label, parentCall, buttonPattern, checks) => {
    const target = parentCall.body?.message_id ?? parentCall.message_id;
    const button = findButton(parentCall, buttonPattern);
    if (!button) {
      record(`menu ${label}`, false, `button not found: ${buttonPattern}`);
      return parentCall;
    }
    try {
      const call = await click(button, target);
      const text = String(call.body?.text ?? "");
      const labels = buttonsOf(call).map((b) => String(b.text ?? ""));
      const ok = checks.every((check) => (check instanceof RegExp ? check.test(text) || labels.some((l) => check.test(l)) : labels.includes(check)));
      record(`menu ${label}`, ok, `${text.replace(/\s+/g, " ").slice(0, 60)} · ${labels.slice(0, 6).join(" / ")}`);
      return call;
    } catch (error) {
      record(`menu ${label}`, false, String(error.message).slice(0, 240));
      return parentCall;
    }
  };

  const workedConfig = new Set();
  try {
    // Level 1: the hub.
    let main = await openMain();
    record("menu /tg opens", buttonsOf(main).length >= 5,
      buttonsOf(main).map((b) => b.text).join(" / "));

    // Level 2-4: Bots → Bot list → per-bot actions.
    let bots = await menuStep("Bots", main, /🤖 Bots/, [/🤖 Bots/, "➕ Add bot", "Bot list"]);
    let list = await menuStep("Bots → Bot list", bots, /^Bot list$/, [/Bot list/]);
    const botEntry = buttonsOf(list).find((b) => new RegExp(`(pi|omp) ?(⭐|·)|${host}-bot|· (paired|not paired)`, "i").test(String(b.text ?? "")));
    if (botEntry) {
      const detail = await menuStep("Bots → list → detail", list, new RegExp(String(botEntry.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), [/Update/, /Pairing/, /Remove/]);
      const back = findButton(detail, /^(⬅️ Back)$/);
      if (back) await click(back, detail.body?.message_id ?? detail.message_id).catch(() => undefined);
    } else {
      record("menu Bots → list → detail", false, `no bot entry: ${buttonsOf(list).map((b) => b.text).join(" / ")}`);
    }
    await settle();

    // Level 2-3: Project → bind picker.
    main = await openMain();
    const project = await menuStep("Project", main, /📁 Project/, [/Project/, /^Bot: /, /Disconnect|Connect|In use/]);
    const bindButton = buttonsOf(project).find((b) => /^Bot: /.test(String(b.text ?? "")));
    if (bindButton) {
      await menuStep("Project → bind", project, new RegExp(String(bindButton.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), [/Bind project to bot/]);
    } else {
      record("menu Project → bind", false, "no bot row");
    }
    await settle();

    // Level 2-3: Config → every flow, choosing the current value (no change).
    main = await openMain();
    let config = await menuStep("Config", main, /⚙️ Config/, [/Telegram Config/]);
    for (let rounds = 0; rounds < 8; rounds += 1) {
      const entries = buttonsOf(config)
        .map((b) => String(b.text ?? ""))
        .filter((label) => /^(🔧 Tool|💭 Thinking|🔄 Retry|🖥 TUI bridge|🐚 Shell confirm|🧠 Thinking level):/.test(label));
      const pending = entries.find((label) => !workedConfig.has(label));
      if (!pending) break;
      workedConfig.add(pending);
      const current = pending.split(":").slice(1).join(":").trim();
      const entry = findButton(config, new RegExp(`^${pending.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      if (!entry) { record(`config ${pending}`, false, "entry vanished"); continue; }
      const target = config.body?.message_id ?? config.message_id;
      try {
        const step3 = await click(entry, target);
        if (/Retry/.test(pending)) {
          // Regression: the number is answered by the host's own input dialog
          // (§4.5) from plain Telegram text, so type a value that differs from
          // the current one and require the notice to come back.
          const since = await cursor();
          const typed = String((Number(current.replace(/\D+/g, "")) || 3) + 1);
          await injectMessage(typed);
          const done = await waitFor(`config ${pending} applied`, (state) =>
            state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /set to/.test(String(c.body?.text ?? ""))) ?? false);
          record(`config ${pending} answered by typing ${typed}`, Boolean(done),
            String(done.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
        } else {
          const option = buttonsOf(step3).find((b) => String(b.text ?? "").replace(/^● /, "").trim() === current);
          if (!option) {
            record(`config ${pending}`, false, `current "${current}" not offered: ${buttonsOf(step3).map((b) => b.text).join(" / ")}`);
          } else {
            const since = await cursor();
            await click(option, step3.body?.message_id ?? step3.message_id);
            const applied = await waitFor(`config ${pending} notice`, (state) =>
              state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /set to/.test(String(c.body?.text ?? ""))) ?? false, 10_000)
              .catch(() => undefined);
            // A host may reject setting the already-current value (e.g. a
            // model without thinking support); the level-3 menu opening and
            // offering the value is the navigation contract under test.
            const levelMenu = buttonsOf(step3).length > 0;
            record(`config ${pending}`, Boolean(applied) || levelMenu,
              String(applied?.body?.text ?? `menu offered ${buttonsOf(step3).map((b) => b.text).join(" / ")}`).replace(/\s+/g, " ").slice(0, 140));
          }
        }
      } catch (error) {
        record(`config ${pending}`, false, String(error.message).slice(0, 200));
      }
      const state = await controlGet();
      config = lastKeyboardCall(state) ?? config;
      if (!/Telegram Config/.test(String(config?.body?.text ?? ""))) {
        // A flow may close the menu; reopen it for the remaining entries.
        main = await openMain();
        config = await menuStep("Config (reopen)", main, /⚙️ Config/, [/Telegram Config/]);
      }
    }
    await settle();

    // Level 2-3: Commands → pick /status and verify its output. The catalog is
    // paginated (OMP advertises ~90 commands), so walk pages first.
    main = await openMain();
    let commands = await menuStep("Commands", main, /⌨️ Commands/, [/Commands \(/]);
    let statusButton = findButton(commands, /^\/status\b/);
    for (let page = 0; !statusButton && page < 12; page += 1) {
      const next = findButton(commands, /^Next ▶$/);
      if (!next) break;
      commands = await click(next, commands.body?.message_id ?? commands.message_id);
      statusButton = findButton(commands, /^\/status\b/);
    }
    if (statusButton) {
      record("menu Commands paging finds /status", true, `page with ${buttonsOf(commands).length} entries`);
    } else {
      const first = buttonsOf(commands).find((b) => /^\/[a-z_-]+ —/.test(String(b.text ?? "")) && !/^\/exit\b|^\/quit\b/.test(String(b.text ?? "")));
      record("menu Commands lists entries", Boolean(first), first ? String(first.text).slice(0, 50) : "none");
      statusButton = first;
    }
    if (statusButton) {
      const since = await cursor();
      await click(statusButton, commands.body?.message_id ?? commands.message_id);
      const status = await waitFor("status output from menu", (state) =>
        state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /TUI Status|Workspace|Session Info/i.test(String(c.body?.text ?? ""))) ?? false);
      record("menu Commands → /status", true, String(status.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    } else {
      record("menu Commands → /status", false, "status not in catalog");
    }
    await settle();

    // Level 2: Switch instance.
    main = await openMain();
    const sw = await menuStep("Switch instance", main, /🔄 Switch instance/, [/Switch Telegram pi instance|not the active|No live/i]);
    const swBack = findButton(sw, /^⬅️ Back$/);
    if (swBack) await click(swBack, sw.body?.message_id ?? sw.message_id).catch(() => undefined);
    await settle();
  } catch (error) {
    record("menu walk", false, String(error.message).slice(0, 300));
  }

  // ── Provider/model menus ──────────────────────────────────────────────
  try {
    const ack = await dispatch("/model");
    const ackId = ack.message_id;
    // D2/D3 + one message: the host's picker is an edit of the command's own message.
    const dialog = await awaitMessage("model dialog after ack", ackId, hasDialog, 15_000).catch(() => undefined);
    if (!dialog) {
      record("menu /model selects", false, "no dialog after ack");
      record("goal: /model is a paged button list", false, "no picker on the command message");
    } else {
      const dialogMessageId = ackId;
      const models = choicesOf(dialog);
      const paged = /Page \d+\/\d+/.test(String(dialog.body.text ?? ""));
      const pagedDetail = `${models.length} model buttons · ${paged ? "Page x/y marker" : "no Page x/y marker"} · ${panelBody(dialog.body.text).slice(0, 60)}`;
      const option = models.find((b) => /mock/i.test(String(b.text ?? ""))) ?? models[0];
      if (!option) {
        record("menu /model selects", false, `no model buttons: ${buttonsOf(dialog).map((b) => b.text).join(" / ").slice(0, 90)}`);
        record("goal: /model is a paged button list", false, pagedDetail);
      } else {
        // Labels carry picker markers (▸ cursor, ✓ current); the model name is the part after the provider.
        const modelLabel = String(option.text ?? "").replace(/^[▸●✓\s]+/, "").trim();
        const modelName = modelLabel.split("/").pop();
        const clickCursor = await cursor();
        await click(option, dialogMessageId).catch(() => undefined);
        // Goal check right after the tap: the same message names the model and drops its keyboard.
        await sleep(1500);
        const picked = foldState((await controlGet()).calls, dialogMessageId);
        const pickedButtons = picked ? buttonsOf(picked).length : -1;
        const named = Boolean(picked) && panelBody(picked.body.text).includes(modelName);
        // OMP's own next step (the purpose picker "Assign <model> to …") may
        // replace the picker on the same message; the TUI shows that step too,
        // so it counts as the host's next dialog step, not a failed tap.
        const hostNextStep = Boolean(picked) && (/Assign .* to/i.test(String(picked.body?.text ?? ""))
          || buttonsOf(picked).some((b) => /^default\b/i.test(String(b.text ?? ""))));
        const settled = pickedButtons === 0 || hostNextStep;
        record("goal: /model is a paged button list", paged && models.length > 0 && named && settled,
          `${pagedDetail} · tap "${modelLabel}" → ${pickedButtons === 0 ? "keyboard removed" : hostNextStep ? "host's next dialog step on the same message" : `keyboard still has ${pickedButtons} buttons`} · ${named ? "names the model" : "no model name"} · text: "${panelBody(picked?.body.text).slice(0, 100)}"`);
        // F5: OMP asks for a purpose after the model — the model click opens
        // a second dialog ("Assign <model> to", first item `default`) and
        // nothing applies until that is answered too (3E).
        const purposeDialog = await waitFor("model purpose dialog", (state) =>
          state.calls.slice(clickCursor).findLast((entry) => !wasRejected(entry) && Array.isArray(rowsOf(entry)) && isControllable(entry)
            && (/Assign .* to/i.test(String(entry.body?.text ?? ""))
              || buttonsOf(entry).some((b) => /^default\b/i.test(String(b.text ?? ""))))) ?? false,
          4_000).catch(() => undefined);
        let purposeMessageId;
        let purposeLabel;
        let purposeCursor;
        if (purposeDialog) {
          purposeMessageId = purposeDialog.body?.message_id ?? purposeDialog.message_id;
          // 3E: OMP's purpose options are toggles - an already-assigned one
          // (✓ prefix) unassigns and only closes the option strip, so pick the
          // first non-cancel option whose text carries no ✓ (e.g. `smol`).
          const purposeButton = buttonsOf(purposeDialog).find((b) => !DIALOG_CANCEL.test(String(b.callback_data ?? ""))
            && !String(b.text ?? "").includes("✓"));
          if (!purposeButton) {
            throw new Error(`no unassigned purpose: ${buttonsOf(purposeDialog).map((b) => String(b.text ?? "").replace(/\s+/g, " ")).join(" / ").slice(0, 90)}`);
          }
          purposeLabel = String(purposeButton.text ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
          // Take the cursor before the click: `click` awaits the follow-up edit,
          // so the strip closing is already in the log by the time we look.
          purposeCursor = await cursor();
          await click(purposeButton, purposeMessageId).catch(() => undefined);
        }
        // Applied means a host status message naming the new model, the Broker
        // retiring the dialog message (summary edit + strip), or the purpose
        // strip closing back into the model panel. With the purpose step the
        // edited message can be the purpose dialog.
        const dialogIds = [dialogMessageId, purposeMessageId];
        const applied = await waitFor("model selection applied", (state) => {
          const after = state.calls.slice(clickCursor);
          if (after.some((entry) => entry.method === "sendMessage" && /mock-model/.test(String(entry.body?.text ?? "")))) return true;
          // Third signal (3E): closing the purpose strip edits the same dialog
          // message back to the model panel, so its text stops matching
          // /Assign .* to/ even though the panel keeps its own buttons.
          if (purposeCursor !== undefined && state.calls.slice(purposeCursor).some((entry) =>
            entry.method === "editMessageText" && entry.body?.message_id === purposeMessageId
            && typeof entry.body?.text === "string" && !/Assign .* to/i.test(entry.body.text))) return true;
          return after.some((entry) =>
            (entry.method === "editMessageText" || entry.method === "editMessageReplyMarkup")
            && dialogIds.includes(entry.body?.message_id)
            && !buttonsOf(entry).some((b) => String(b.callback_data ?? "").startsWith("tgplus:dlg:")));
        }, 15_000).catch(() => undefined);
        record("menu /model selects", Boolean(applied),
          applied ? `dialog${purposeLabel ? ` +purpose:${purposeLabel}` : ""} · ${panelBody(dialog.body.text).slice(0, 60)}` : "selection not confirmed");
      }
    }
  } catch (error) {
    record("menu /model selects", false, String(error.message).slice(0, 200));
  }
  await settle();

  if (host === "omp") {
    // /scoped-models is pi-only; sending it to OMP falls through to the model
    // as a plain prompt instead of opening a dialog, so don't send it.
    record("menu /scoped-models opens", true, "skipped: OMP has no /scoped-models");
  } else {
    try {
      const ack = await dispatch("/scoped-models");
      const dialog = await awaitMessage("scoped-models dialog after ack", ack.message_id, hasDialog, 15_000).catch(() => undefined);
      record("menu /scoped-models opens", Boolean(dialog) && buttonsOf(dialog).length > 0,
        dialog ? `dialog · ${buttonsOf(dialog).slice(0, 3).map((b) => b.text).join(" / ").slice(0, 60)}` : "no dialog after ack");
      // Close the picker: an open dialog would block every later command in the run.
      const close = dialog ? buttonsOf(dialog).find(isCancel) : undefined;
      if (close) await cancelQuietly(close, dialog.body?.message_id ?? dialog.message_id);
      await settle();
    } catch (error) {
      record("menu /scoped-models opens", false, String(error.message).slice(0, 200));
    }
  }

  // ── Login / logout / settings ─────────────────────────────────────────
  try {
    const ack = await dispatch("/login");
    const current = await awaitMessage("login menu", ack.message_id,
      (cur) => buttonsOf(cur).length > 0 || panelBody(cur.body.text).length > 0, 15_000).catch(() => ack);
    const isDialog = hasDialog(current);
    const isNative = hasUi(current);
    record("menu /login opens", isDialog || isNative || /login|provider/i.test(panelBody(current.body.text)),
      `${isDialog ? "dialog" : isNative ? "native" : "text"} · ${buttonsOf(current).map((b) => b.text).join(" / ").slice(0, 90)}`);
    await settle();
  } catch (error) {
    record("menu /login opens", false, String(error.message).slice(0, 200));
  }

  try {
    const ack = await dispatch("/logout");
    const current = await awaitMessage("logout result", ack.message_id,
      (cur) => buttonsOf(cur).length > 0 || panelBody(cur.body.text).length > 0, 15_000).catch(() => ack);
    record("menu /logout opens", /logout|credential|No stored/i.test(panelBody(current.body.text)) || buttonsOf(current).length > 0,
      panelBody(current.body.text).slice(0, 70));
    await settle();
  } catch (error) {
    record("menu /logout opens", false, String(error.message).slice(0, 200));
  }

  try {
    const ack = await dispatch("/settings");
    // The gateway acks the command ("▶️ /settings"); the dialog itself is an edit of
    // that message with the brokered `tgplus:dlg:` keyboard (§0.1 #4: the host
    // executes, the Broker presents the dialog it raises).
    const mirror = await awaitMessage("settings dialog", ack.message_id, hasDialog, 15_000).catch(() => undefined);
    record("menu /settings opens", Boolean(mirror),
      mirror ? `dialog · ${buttonsOf(mirror).slice(0, 4).map((b) => b.text).join(" / ")}` : panelBody(ack.body?.text).slice(0, 60));
    // Cross-check the brokered dialog against the host's real terminal, so this
    // step cannot pass on a fabricated screen: the Broker builds its buttons
    // from the host component's own labels, so every label has to exist
    // verbatim in the terminal.
    if (mirror && hasDialog(mirror)) {
      const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      const words = [...new Set(buttonsOf(mirror)
        .map((b) => String(b.text ?? "").replace(/^[^A-Za-z]+/, "").slice(0, 12))
        .filter((word) => word.length >= 5))];
      const hits = words.filter((word) => pane.includes(word));
      record("settings dialog matches the host screen", hits.length >= 3,
        `${hits.length}/${words.length} dialog labels found in pane · ${hits.slice(0, 3).join(" / ")}`);
    }
    await settle();
  } catch (error) {
    record("menu /settings opens", false, String(error.message).slice(0, 200));
  }

  // ── Goal: /login offers providers, then asks for a key on the same message ─
  try {
    const ack = await dispatch("/login");
    const loginId = ack.message_id;
    let list = await awaitMessage("login choices", loginId, (cur) => choicesOf(cur).length > 0, 20_000);
    const path = [];
    if (host === "omp") {
      // OMP lists ~85 providers over nine pages; the provider search narrows it to an API-key one.
      const search = findButton(list, /🔍 Search/);
      if (!search) throw new Error(`no Search button: ${buttonsOf(list).map((b) => b.text).join(" / ").slice(0, 120)}`);
      path.push("🔍 Search DeepSeek");
      // Search only switches the picker into typing mode; it may not edit the message.
      await cancelQuietly(search, loginId);
      await injectMessage("DeepSeek");
      list = await awaitMessage("login search result", loginId,
        (cur) => choicesOf(cur).some((b) => /DeepSeek/i.test(String(b.text ?? ""))), 20_000);
    } else if (host === "pi") {
      // pi first asks for the sign-in method; the API-key method leads to the provider list.
      const method = choicesOf(list).find((b) => /api ?key/i.test(String(b.text ?? "")));
      if (!method) throw new Error(`no API-key method: ${choicesOf(list).map((b) => b.text).join(" / ")}`);
      const before = panelBody(list.body.text);
      path.push(method.text);
      await click(method, loginId);
      list = await awaitMessage("login provider list", loginId,
        (cur) => choicesOf(cur).length > 0 && panelBody(cur.body.text) !== before, 20_000);
    }
    const provider = choicesOf(list).find((b) => /DeepSeek/i.test(String(b.text ?? ""))) ?? choicesOf(list)[0];
    if (!provider) throw new Error("no provider button");
    path.push(provider.text);
    await click(provider, loginId);
    const prompt = await awaitMessage("login key prompt", loginId,
      (cur) => choicesOf(cur).length === 0 && /key/i.test(panelBody(cur.body.text)) && buttonsOf(cur).some(isCancel), 20_000).catch(() => undefined);
    const shown = prompt ?? await latestState(loginId);
    record("goal: /login provider then key prompt", Boolean(prompt),
      `${path.join(" → ")} · text: "${panelBody(shown?.body.text).slice(0, 100)}" · buttons: ${buttonsOf(shown).map((b) => b.text).join(" / ") || "(none)"}`);
    await settle();
  } catch (error) {
    record("goal: /login provider then key prompt", false, String(error.message).slice(0, 220));
    // An open dialog would block every later turn: close whatever the failed flow left behind.
    await settle();
  }

  // ── Goal: agent tool output never lands in a command's reply (#20) ─────
  try {
    const turnSince = await cursor();
    await injectMessage("PROBE_SLOW_BASH: run the slow probe");
    await sleep(1500);
    const login = await dispatch("/login");
    const loginId = login.message_id;
    const loginReply = login.body?.reply_parameters?.message_id;
    const leaks = (state) => state.calls
      .filter((c) => !wasRejected(c) && c.body && ((c.method === "sendMessage" && loginReply !== undefined && c.body.reply_parameters?.message_id === loginReply)
        || ((c.method === "editMessageText" || c.method === "editMessageReplyMarkup") && c.body.message_id === loginId)))
      .map((c) => String(c.body.text ?? ""))
      .filter((text) => /SLOW_DONE|sleep 6|^\$ /m.test(text));
    const open = await awaitMessage("login open during slow tool", loginId, (cur) => buttonsOf(cur).length > 0, 20_000).catch(() => undefined);
    await sleep(2000);
    const whileOpen = leaks(await controlGet());
    await settle();
    const turnDone = await waitFor("slow probe turn finishes", (state) => state.calls.slice(turnSince).some((c) =>
      (c.method === "sendMessage" || c.method === "editMessageText") && /MOCK_OK/.test(String(c.body?.text ?? "")))
      , 40_000).then(() => true, () => false);
    await sleep(500);
    const afterCancel = leaks(await controlGet());
    const sample = [...whileOpen, ...afterCancel].slice(0, 1).map((t) => ` · leaked: "${t.slice(0, 80)}"`).join("");
    record("goal: agent tool output stays out of command replies",
      Boolean(open) && turnDone && whileOpen.length === 0 && afterCancel.length === 0,
      `/login open: ${Boolean(open)} · slow turn finished: ${turnDone} · leaks while open: ${whileOpen.length} · leaks after cancel: ${afterCancel.length}${sample}`);
  } catch (error) {
    record("goal: agent tool output stays out of command replies", false, String(error.message).slice(0, 220));
  }

  // ── Goal: a command typed in the local terminal stays local ─────────────
  {
    const localSince = await cursor();
    tmux("send-keys", "-t", session, "-l", "/session");
    tmux("send-keys", "-t", session, "Enter");
    await sleep(4000);
    const hits = (await controlGet()).calls.slice(localSince).filter((c) =>
      (c.method === "sendMessage" || c.method === "editMessageText") && !wasRejected(c)
      && /Session Info|Messages:/.test(String(c.body?.text ?? "")));
    record("goal: local terminal command stays local", hits.length === 0,
      hits.length === 0 ? "no session text sent within 4 s" : `${hits.length} session message(s) sent: "${panelBody(hits[0].body.text).slice(0, 80)}"`);
    await settle();
  }

  // ── Management mutations (isolated dirs; exercises the real flows) ────
  // Adding a bot goes through the /tg menu: the flat tg-bot-* commands were
  // removed (T4.10) and the menu is what users actually have. The name is
  // asked by the host's own input dialog (brokered), the token by the plugin's
  // secret prompt, so this exercises both answer paths.
  try {
    const mainForAdd = await openMain();
    const botsMenu = await menuStep("Bots (add flow)", mainForAdd, /🤖 Bots/, [/🤖 Bots/, "➕ Add bot"]);
    const add = findButton(botsMenu, /^➕ Add bot$/);
    if (!add) throw new Error(`no ➕ Add bot entry: ${buttonsOf(botsMenu).map((b) => b.text).join(" / ")}`);
    await click(add, botsMenu.body?.message_id ?? botsMenu.message_id);
    await waitFor("bot name prompt", (state) =>
      state.calls.findLast((c) => RESPONSE_METHODS.has(c.method) && /Bot name/i.test(String(c.body?.text ?? ""))) ?? false);
    await injectMessage("e2e-extra");
    await waitFor("bot token prompt", (state) =>
      state.calls.findLast((c) => RESPONSE_METHODS.has(c.method) && /token/i.test(String(c.body?.text ?? ""))) ?? false);
    const since = await cursor();
    await injectMessage("555555:E2E_TOKEN");
    const added = await waitFor("bot added", (state) =>
      state.calls.slice(since).findLast((c) => RESPONSE_METHODS.has(c.method) && /Bot added/i.test(String(c.body?.text ?? ""))) ?? false);
    record("menu Bots → Add bot answered from Telegram", true, String(added.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));

    // The add flow leaves the bot-name prompt behind; settle cancels it, then
    // removal goes through the /tg menu (Bots → Bot list → e2e-extra → Remove).
    await settle();
    const mainForRemove = await openMain();
    const botsForRemove = await menuStep("Bots (remove flow)", mainForRemove, /🤖 Bots/, [/🤖 Bots/, "➕ Add bot"]);
    const listForRemove = await menuStep("Bots → Bot list (remove flow)", botsForRemove, /^Bot list$/, [/Bot list/]);
    const extraEntry = buttonsOf(listForRemove).find((b) => /e2e-extra/.test(String(b.text ?? "")));
    if (!extraEntry) throw new Error(`no e2e-extra entry: ${buttonsOf(listForRemove).map((b) => b.text).join(" / ")}`);
    const detail = await click(extraEntry, listForRemove.body?.message_id ?? listForRemove.message_id);
    const remove = findButton(detail, /^Remove$/);
    if (!remove) throw new Error(`no Remove entry: ${buttonsOf(detail).map((b) => b.text).join(" / ")}`);
    const rmPrompt = await click(remove, detail.body?.message_id ?? detail.message_id);
    const rmYes = findButton(rmPrompt, /^(Yes|Confirm|OK|✅.*)$/i);
    if (!rmYes) throw new Error(`no confirm on remove prompt: ${buttonsOf(rmPrompt).map((b) => b.text).join(" / ")}`);
    const removed = await click(rmYes, rmPrompt.body?.message_id ?? rmPrompt.message_id);
    record("menu Bots → list → Remove answered from Telegram", /removed/i.test(String(removed.body?.text ?? "")),
      String(removed.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
  } catch (error) {
    record("management bot CRUD", false, String(error.message).slice(0, 220));
  }
  await settle();

  try {
    // Bind / unbind go through the /tg menu (the flat commands are gone, T4.10).
    let main = await openMain();
    const project = await menuStep("Project (bind flow)", main, /📁 Project/, [/Project/, /^Bot: /, /Disconnect|Connect|In use/]);
    const botRow = findButton(project, /^Bot: /);
    if (!botRow) throw new Error(`no Bot row: ${buttonsOf(project).map((b) => b.text).join(" / ")}`);
    const picker = await click(botRow, project.body?.message_id ?? project.message_id);
    const botButton = buttonsOf(picker).find((b) => /(pi|omp)-bot|bi\(|★|·/.test(String(b.text ?? "")));
    if (!botButton) throw new Error(`no bot option: ${buttonsOf(picker).map((b) => b.text).join(" / ")}`);
    const bound = await click(botButton, picker.body?.message_id ?? picker.message_id);
    record("menu Project → Bind bot", /bound|Switching bot/i.test(String(bound.body?.text ?? "")) || buttonsOf(bound).length > 0,
      `picked ${botButton.text} · ${String(bound.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
    await settle();

    main = await openMain();
    const project2 = await menuStep("Project (unbind flow)", main, /📁 Project/, [/Project/, /^Bot: /, /Disconnect|Connect|In use/]);
    const botRow2 = findButton(project2, /^Bot: /);
    if (!botRow2) throw new Error(`no Bot: row: ${buttonsOf(project2).map((b) => b.text).join(" / ")}`);
    const picker2 = await click(botRow2, project2.body?.message_id ?? project2.message_id);
    const unbindButton = findButton(picker2, /^Unbind$/);
    if (!unbindButton) throw new Error(`no Unbind entry: ${buttonsOf(picker2).map((b) => b.text).join(" / ")}`);
    const unbindPrompt = await click(unbindButton, picker2.body?.message_id ?? picker2.message_id);
    const unbindYes = findButton(unbindPrompt, /^(Yes|Confirm|OK|✅.*)$/i);
    if (!unbindYes) throw new Error(`no confirm on unbind prompt: ${buttonsOf(unbindPrompt).map((b) => b.text).join(" / ")}`);
    const unbound = await click(unbindYes, unbindPrompt.body?.message_id ?? unbindPrompt.message_id);
    record("menu Project → Unbind", /Removed|unbind/i.test(String(unbound.body?.text ?? "")),
      String(unbound.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    await settle();

    // Switch instance opens the live-instance picker; go Back without switching.
    main = await openMain();
    const switchMenu = await menuStep("Switch instance", main, /🔄 Switch instance/, [/Switch Telegram pi instance/, /⬅️ Back/]);
    const back = findButton(switchMenu, /^⬅️ Back$/);
    if (back) await click(back, switchMenu.body?.message_id ?? switchMenu.message_id).catch(() => undefined);
    record("menu Switch instance picker", buttonsOf(switchMenu).length >= 2,
      buttonsOf(switchMenu).map((b) => b.text).join(" / ").slice(0, 70));
  } catch (error) {
    record("management bind/unbind/switch via menu", false, String(error.message).slice(0, 220));
  }
  await settle();

  // ── Follow-ups: picker tabs, resume list, settings search (OMP) ──────
  if (host === "omp") {
    // Z2: the picker's tab strip reaches Telegram and a tab press re-renders
    // with the pressed tab marked active (`● ` prefix, tsp adapter labels).
    try {
      const treeSince = await cursor();
      await dispatch("/tree", { timeoutMs: 30_000 });
      const tree = await waitFor("/tree tab keyboard", (state) =>
        state.calls.slice(treeSince).findLast((c) => !wasRejected(c) && Array.isArray(rowsOf(c)) && findButton(c, /^(● )?All$/)) ?? false, 30_000);
      const allTab = findButton(tree, /^(● )?All$/);
      if (!allTab) throw new Error(`no All tab: ${buttonsOf(tree).map((b) => b.text).join(" / ").slice(0, 120)}`);
      const clickSince = await cursor();
      await click(allTab, tree.body?.message_id ?? tree.message_id, { timeoutMs: 30_000 });
      const active = await waitFor("/tree All tab active", (state) =>
        state.calls.slice(clickSince).findLast((c) => !wasRejected(c) && Array.isArray(rowsOf(c)) && findButton(c, /^● All$/)) ?? false, 30_000);
      record("omp /tree tabs", Boolean(active),
        `tabs: ${buttonsOf(tree).map((b) => b.text).join(" / ").slice(0, 90)}`);
    } catch (error) {
      record("omp /tree tabs", false, String(error.message).slice(0, 200));
    }
    await settle();

    // The window/main /new steps created sessions, so /resume must present a
    // real picker, not an empty-state notice.
    try {
      const resumeSince = await cursor();
      await dispatch("/resume", { timeoutMs: 30_000 });
      const list = await waitFor("/resume picker", (state) =>
        state.calls.slice(resumeSince).findLast((c) => !wasRejected(c) && Array.isArray(rowsOf(c))) ?? false, 30_000);
      const listText = String(list.body?.text ?? "");
      const rows = buttonsOf(list).filter((b) =>
        !/^tgplus:dlg:[^:]+:\d+:(x|p|k)$/.test(String(b.callback_data ?? ""))
        && !/Cancel|Close|Back|Prev|Next|Submit|^\d+\/\d+$/.test(String(b.text ?? "")));
      record("omp /resume lists sessions", !/No sessions/i.test(listText) && rows.length >= 1,
        `${rows.length} rows · ${listText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80)}`);
    } catch (error) {
      record("omp /resume lists sessions", false, String(error.message).slice(0, 200));
    }
    await settle();

    // H20: Delete in the /resume picker asks for confirmation on Telegram, as the
    // TUI does ("Delete ... This removes the session file."). Cancel keeps the
    // session file; Yes removes it. Both answers go through the picker message.
    try {
      const sessionsDir = join(runDir, "agent", "sessions");
      const countSessionFiles = () => {
        try {
          return readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
            .filter((name) => String(name).endsWith(".jsonl")).length;
        } catch {
          return 0;
        }
      };
      const CONFIRM_TEXT = "removes the session file";
      const isConfirm = (call) => String(call?.body?.text ?? "").includes(CONFIRM_TEXT);
      const openDeletePicker = async () => {
        const since = await cursor();
        await dispatch("/resume", { timeoutMs: 30_000 });
        // The picker is the newest keyboard that offers Delete; an emptied keyboard
        // left by an earlier edit does not count.
        const picker = await waitFor("/resume picker for delete", (state) =>
          state.calls.slice(since).findLast((c) => !wasRejected(c) && buttonsOf(c).some((b) => /delete/i.test(String(b.text ?? "")))) ?? false, 30_000);
        const deleteButton = buttonsOf(picker).find((b) => /delete/i.test(String(b.text ?? "")));
        if (!deleteButton) {
          throw new Error(`no Delete action: ${buttonsOf(picker).map((b) => String(b.text ?? "")).join(" / ").slice(0, 200)}`);
        }
        return { picker, messageId: picker.body?.message_id ?? picker.message_id, deleteButton };
      };
      // Raw callback: a press may legitimately produce no reply of its own.
      const pressRaw = async (button, messageId) => {
        const callbackId = await injectCallback(String(button.callback_data), messageId);
        await waitFor(`callback answered: ${button.text}`, (state) =>
          state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId), STEP_TIMEOUT_MS);
      };
      const latestMessage = (state, since, messageId) => state.calls.slice(since).findLast((c) =>
        !wasRejected(c) && (c.method === "sendMessage" || c.method === "editMessageText")
        && (c.method === "sendMessage" || c.body?.message_id === messageId) && c.body);
      const text = (call) => String(call?.body?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

      // 1. Delete shows the confirmation with its text and Yes / Cancel buttons.
      const first = await openDeletePicker();
      const beforeAsk = countSessionFiles();
      const askSince = await cursor();
      await pressRaw(first.deleteButton, first.messageId);
      const ask = await waitFor("delete confirmation shown", (state) => {
        const hit = latestMessage(state, askSince, first.messageId);
        return hit && isConfirm(hit) ? hit : false;
      }, STEP_TIMEOUT_MS);
      const askButtons = buttonsOf(ask).map((b) => String(b.text ?? ""));
      const yesButton = buttonsOf(ask).find((b) => /Yes/.test(String(b.text ?? "")));
      const cancelButton = buttonsOf(ask).find((b) => /Cancel/.test(String(b.text ?? "")) || DIALOG_CANCEL.test(String(b.callback_data ?? "")));
      record("omp /resume delete asks for confirmation",
        Boolean(yesButton && cancelButton) && countSessionFiles() === beforeAsk,
        `text: "${text(ask).slice(0, 120)}" · buttons: ${askButtons.join(" / ").slice(0, 120)}`);

      // 2. Cancel closes the confirmation and keeps the session file.
      const cancelSince = await cursor();
      await pressRaw(cancelButton, first.messageId);
      await waitFor("picker back after cancel", (state) => {
        const hit = latestMessage(state, cancelSince, first.messageId);
        return hit && !isConfirm(hit) && Array.isArray(rowsOf(hit)) ? hit : false;
      }, STEP_TIMEOUT_MS);
      await sleep(1000);
      const afterCancel = countSessionFiles();
      record("omp /resume cancel keeps the session file", afterCancel === beforeAsk,
        afterCancel === beforeAsk ? `${afterCancel} session files kept` : `${beforeAsk} -> ${afterCancel}`);

      // 3. Delete again, then Yes removes the selected session file.
      const second = await openDeletePicker();
      const confirmSince = await cursor();
      await pressRaw(second.deleteButton, second.messageId);
      const again = await waitFor("second delete confirmation", (state) => {
        const hit = latestMessage(state, confirmSince, second.messageId);
        return hit && isConfirm(hit) ? hit : false;
      }, STEP_TIMEOUT_MS);
      const yesAgain = buttonsOf(again).find((b) => /Yes/.test(String(b.text ?? "")));
      if (!yesAgain) throw new Error(`no Yes button: ${buttonsOf(again).map((b) => String(b.text ?? "")).join(" / ").slice(0, 160)}`);
      const beforeYes = countSessionFiles();
      await pressRaw(yesAgain, second.messageId);
      await sleep(4000);
      const afterYes = countSessionFiles();
      record("omp /resume confirm removes the session file", afterYes === beforeYes - 1,
        afterYes === beforeYes - 1 ? `${beforeYes} -> ${afterYes} session files` : `${beforeYes} -> ${afterYes} (expected one less)`);
    } catch (error) {
      record("omp /resume delete asks for confirmation", false, String(error.message).slice(0, 200));
    }
    await settle();

    // Z3/Z3b: text typed while the settings page is open is its search term;
    // the keyboard refreshes to the filtered rows.
    try {
      const settingsSince = await cursor();
      await dispatch("/settings", { timeoutMs: 30_000 });
      await waitFor("/settings dialog", (state) => lastKeyboardCall(state, settingsSince) ?? false, 20_000);
      const searchSince = await cursor();
      await injectMessage("thinking");
      const hit = await waitFor("/settings search refresh", (state) =>
        state.calls.slice(searchSince).findLast((c) => !wasRejected(c) && Array.isArray(rowsOf(c))
          && buttonsOf(c).some((b) => /thinking/i.test(String(b.text ?? "")))) ?? false, 20_000);
      const labels = hit ? buttonsOf(hit).filter((b) => /thinking/i.test(String(b.text ?? ""))).map((b) => b.text) : [];
      record("omp /settings search", Boolean(hit), labels.join(" / ").slice(0, 120));
    } catch (error) {
      record("omp /settings search", false, String(error.message).slice(0, 200));
    }
    await settle();
  }

  // ── Inventory (issue #18, diagnostic): TUI text that Telegram does not show ──
  // For each dialog command, the described tree read by the plugin (PITG_TREE_DUMP)
  // is compared with the Telegram text and buttons. Texts missing from Telegram are
  // listed per command and written to inventory-omp.json; nothing is fixed here.
  if (host === "omp") {
    const INVENTORY_COMMANDS = ["/login", "/settings", "/model", "/extensions", "/tree", "/agents", "/hub", "/logout", "/mcp add", "/usage"];
    const TEXT_PROPS = new Set(["title", "subtitle", "lead", "hint", "text", "label", "message", "warning", "detail", "description",
      "preview", "body", "notice", "badge", "badges", "facts", "status", "empty", "summary", "placeholder", "heading", "caption"]);
    const readDumps = () => {
      try {
        return readFileSync(join(dirname(paneLog), "tree-dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    // Every human-readable prop of the tree, with the node kind and role it comes from.
    const collectTexts = (value, kind, found = []) => {
      if (Array.isArray(value)) {
        for (const item of value) collectTexts(item, kind, found);
        return found;
      }
      if (typeof value !== "object" || value === null) return found;
      const nodeKind = typeof value.k === "string" ? value.k : kind;
      const role = typeof value.p?.role === "string" ? `${nodeKind}/${value.p.role}` : nodeKind;
      for (const [prop, raw] of Object.entries(value)) {
        if (TEXT_PROPS.has(prop)) {
          const text = typeof raw === "string" ? raw : Array.isArray(raw) && raw.every((x) => typeof x === "object" && x !== null && "t" in x)
            ? raw.map((x) => String(x.t)).join("") : undefined;
          if (text && text.trim()) found.push({ kind: role, prop, text: text.trim() });
        }
        if (typeof raw === "object" && raw !== null) collectTexts(raw, nodeKind, found);
      }
      return found;
    };
    const norm = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();
    const inventory = [];
    for (const command of INVENTORY_COMMANDS) {
      const row = { command, missing: [], texts: 0, adapter: "", telegram: "", buttons: [], error: "" };
      inventory.push(row);
      const dumpsBefore = readDumps().length;
      try {
        const ack = await dispatch(command, { timeoutMs: 30_000 });
        await quiesce(ack.message_id);
        await sleep(500);
        const final = foldState((await controlGet()).calls, ack.message_id);
        const telegramText = String(final?.body.text ?? "");
        row.telegram = norm(telegramText).slice(0, 300);
        row.buttons = buttonsOf(final).map((b) => String(b.text ?? ""));
        const described = readDumps().slice(dumpsBefore).filter((d) => d.tree).at(-1);
        row.adapter = described?.adapter ?? "(no described tree)";
        const shown = norm([telegramText, ...row.buttons].join("\n"));
        const seen = new Map();
        for (const entry of described ? collectTexts(described.tree, "") : []) seen.set(`${entry.kind}|${entry.text}`, entry);
        row.texts = seen.size;
        row.missing = [...seen.values()].filter((entry) => !shown.includes(norm(entry.text)));
        record(`omp inventory ${command}`, true,
          `${row.missing.length} of ${row.texts} described texts missing from Telegram (${row.adapter})`);
      } catch (error) {
        row.error = String(error.message).slice(0, 200);
        record(`omp inventory ${command}`, false, row.error);
      }
      await settle();
    }
    writeFileSync(join(runDir, "inventory-omp.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    for (const row of inventory) {
      for (const entry of row.missing) console.log(`    ${row.command} | ${entry.kind} | ${entry.prop} | ${entry.text.slice(0, 120)}`);
    }
  }

  // ── Reload, then verify the plugin still serves ────────────────────────
  try {
    const reloadSince = await cursor();
    await dispatch("/reload");
    // Z1: the reloaded runtime answers the command in the chat itself.
    await waitFor("/reload result delivered", (state) =>
      state.calls.slice(reloadSince).some((c) => c.method === "sendMessage"
        && /Reloaded/.test(String(c.body?.text ?? ""))), 30_000);
    record("/reload result delivered", true);
  } catch (error) {
    record("/reload result delivered", false, String(error.message).slice(0, 200));
  }
  await settle();
  try {
    await sleep(2500);
    const call = await dispatch("/status");
    record("survives /reload", /status|session/i.test(String(call.body?.text ?? "")), String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
  } catch (error) {
    record("survives /reload", false, String(error.message).slice(0, 200));
  }

  // ── Bot API payload contract ───────────────────────────────────────────
  // The mock accepts anything; these are the limits the real API enforces.
  try {
    const all = (await controlGet()).calls ?? [];
    const violations = validateTelegramCalls(all);
    record("telegram payload contract", violations.length === 0,
      violations.length === 0
        ? `${all.length} calls valid`
        : `${violations.length} violations · ${violations.slice(0, 3).join(" | ").slice(0, 260)}`);
  } catch (error) {
    record("telegram payload contract", false, String(error.message).slice(0, 200));
  }

  const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
  record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(pane));

  if (!KEEP) {
    killSession(session);
    try { await controlPost("/_control/reset"); } catch { /* ignore */ }
  }
  const ok = results.every((r) => r.ok);
  return { results, ok, session, runDir };
}

async function main() {
  const hosts = HOST_ARG === "both" ? ["pi", "omp"] : [HOST_ARG];

  // A leftover run (--keep, or a zombie script) holding these ports would silently steal
  // the injected updates: the next suite then reads another host's chat. Fail with a name.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive - kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }
  rmSync(join(ROOT, "tmp"), { recursive: true, force: true });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
  ];
  let mockOut = "";
  for (const mock of mocks) mock.stdout.on("data", (d) => { mockOut += d.toString(); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    await sleep(200);
  }
  if (!(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    console.error("mock servers did not start:", mockOut);
    process.exit(1);
  }

  const summary = [];
  try {
    for (const host of hosts) {
      for (const phase of (PHASE_ARG ? [PHASE_ARG] : ["main", "quit", "exit", "disconnect"])) {
        console.log(`\n=== ${host} (${phase}) ===`);
        await controlPost("/_control/reset");
        const result = await runHost(host, `${host}-${phase}`, phase);
        summary.push({ host: `${host}:${phase}`, ...result });
      }
    }
  } finally {
    for (const mock of mocks) mock.kill();
  }

  const pending = loadPending();
  let failed = 0;
  let pendingSteps = 0;
  for (const host of summary) {
    const { regressions, expected, nowPassing } = classify(pending, "commands", host.host, host.results);
    const passed = host.results.filter((r) => r.ok).length;
    console.log(`\n${regressions.length === 0 ? "PASS" : "FAIL"} ${host.host} — ${passed}/${host.results.length} steps`
      + (expected.length ? ` (${expected.length} pending)` : ""));
    for (const step of regressions) console.log(`  ✗ ${step.name} — ${step.detail}`);
    for (const step of expected) console.log(`  ○ ${step.name} — pending ${step.task}`);
    for (const step of nowPassing) {
      console.log(`  ↑ ${step.name} — passes now; remove from pending-migration.json (${step.task})`);
    }
    failed += regressions.length;
    pendingSteps += expected.length;
  }
  console.log(`\nPENDING=${pendingSteps}`);
  console.log(failed === 0 ? "COMMANDS_ACCEPTANCE=0" : `COMMANDS_ACCEPTANCE=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
