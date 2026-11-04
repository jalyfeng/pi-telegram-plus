#!/usr/bin/env node
/**
 * Focused scenario: OMP /resume row-scoped actions from Telegram.
 *
 * Seeds three sessions on a real OMP host (tmux + mock Bot API + mock
 * provider), opens /resume, and checks that Delete can be aimed at a chosen
 * row without resuming it, that the confirmation really removes exactly that
 * session file, and what deleting the current session does.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-resume-delete.mjs [--omp <path>] [--tg-port 9962]
 *     [--provider-port 9963] [--keep] [--explore]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");
const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const KEEP = process.argv.includes("--keep");
const EXPLORE = process.argv.includes("--explore");
// Reference run: the same deletion typed in a plain OMP terminal (no plugin, no Telegram).
const TUI_REFERENCE = process.argv.includes("--tui-reference");
const TG_PORT = Number(argValue("--tg-port", "9962"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9963"));
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const ROOT = process.env.PITG_D1_ROOT || "/tmp/pitg-d1-resume-delete";
const SESSION = "pitg-d1-resume";
const STEP_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) => spawnSync("tmux", args, { encoding: "utf8" });
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

async function waitFor(label, predicate, timeoutMs = STEP_MS) {
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
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last).slice(0, 400)})`);
}

function killSession() {
  tmux("pipe-pane", "-t", SESSION);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", SESSION);
}

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const wasRejected = (call) => Array.isArray(call?.rejected) && call.rejected.length > 0;
const plain = (html) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

async function main() {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
  ];
  let mockOut = "";
  for (const mock of mocks) mock.stdout.on("data", (d) => { mockOut += d.toString(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) await sleep(200);
  if (!(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    console.error("mock servers did not start (ports busy?)");
    process.exit(1);
  }
  try {
    await (TUI_REFERENCE ? tuiReference() : scenario());
  } finally {
    if (!KEEP) killSession();
    for (const mock of mocks) mock.kill();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESUME_DELETE ${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

/** The TUI side of the current-session deletion, typed with keys in a plugin-free OMP. */
async function tuiReference() {
  const agentDir = join(ROOT, "agent");
  const projectDir = join(ROOT, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
    "    apiKey: mock", "    api: openai-completions", "    models:",
    "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768",
    "        maxTokens: 4096", "",
  ].join("\n"));
  killSession();
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", TMPDIR: join(ROOT, "tmp"), FORCE_COLOR: "0", NO_COLOR: "1" };
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = [OMP_CLI, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"];
  tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`);
  const pane = () => String(tmux("capture-pane", "-p", "-t", SESSION).stdout ?? "");
  const type = async (text) => { tmux("send-keys", "-t", SESSION, "-l", text); await sleep(300); tmux("send-keys", "-t", SESSION, "Enter"); };
  const waitPane = async (re, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (re.test(pane())) return true; await sleep(300); }
    return false;
  };
  const sessionsDir = join(agentDir, "sessions");
  const files = () => { try { return readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).filter((n) => String(n).endsWith(".jsonl")); } catch { return []; } };
  const show = (tag) => console.log(`--- pane (${tag}) ---\n${pane().split("\n").filter((l) => l.trim() && !/^│ *│$/.test(l)).slice(-16).map((l) => l.slice(0, 120)).join("\n")}\n---`);
  await sleep(6000);
  for (const word of ["alpha", "bravo", "charlie"]) {
    await type(`${word} session`);
    await waitPane(/MOCK_OK/);
    await sleep(1200);
    if (word !== "charlie") {
      await type("/new");
      await waitPane(/Start a new session/);
      tmux("send-keys", "-t", SESSION, "Enter");
      await sleep(2500);
    }
  }
  console.log(`  TUI seeded: ${files().length} files`);
  await type("/resume");
  await waitPane(/Resume Session/);
  await sleep(1500);
  show("tui /resume");
  const before = files().length;
  tmux("send-keys", "-t", SESSION, "BSpace");
  await sleep(1500);
  show("tui after Delete key");
  console.log(`  TUI confirmation shown: ${/Delete session\?/.test(pane())}`);
  tmux("send-keys", "-t", SESSION, "Enter");
  await sleep(5000);
  show("tui after confirming Yes");
  console.log(`  TUI files ${before} -> ${files().length}; charlie present: ${files().some((n) => { try { return readFileSync(join(sessionsDir, n), "utf8").includes("charlie session"); } catch { return false; } })}`);
}

async function scenario() {
  const agentDir = join(ROOT, "agent");
  const projectDir = join(ROOT, "project");
  const paneLog = join(ROOT, "pane.log");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
    "    apiKey: mock", "    api: openai-completions", "    models:",
    "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768",
    "        maxTokens: 4096", "",
  ].join("\n"));
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{ id: "omp-bot", name: "omp", token: "444444:D1_TOKEN", allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}` }],
    defaultBotId: "omp-bot",
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: "omp-bot", enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");

  killSession();
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = [OMP_CLI, "-e", PLUGIN, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"];
  const started = tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`);
  if (started.status !== 0) { record("start host in tmux", false, started.stderr?.trim()); return; }
  tmux("pipe-pane", "-t", SESSION, `cat > ${shq(paneLog)}`);

  let updateId = 5000;
  let messageId = 9000;
  const cursor = async () => (await controlGet()).calls.length;
  const injectMessage = async (text) => {
    const id = messageId++;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" }, text },
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
  const press = async (button, targetMessageId) => {
    const callbackId = await injectCallback(String(button.callback_data), targetMessageId);
    await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId));
  };
  const dispatch = async (command, timeoutMs = 60_000) => {
    const since = await cursor();
    const id = await injectMessage(command);
    return waitFor(`response to ${command}`, (state) => state.calls.slice(since).find((c) =>
      c.method === "sendMessage" && !wasRejected(c) && c.body?.reply_parameters?.message_id === id) ?? false, timeoutMs);
  };
  /** Latest folded state of one Telegram message. */
  const fold = (calls, id) => {
    let current;
    for (const c of calls) {
      if (wasRejected(c) || !c.body) continue;
      if (c.method === "sendMessage" && c.message_id === id) current = { text: String(c.body.text ?? ""), rows: c.body.reply_markup?.inline_keyboard ?? [] };
      else if ((c.method === "editMessageText" || c.method === "editMessageReplyMarkup") && c.body.message_id === id) {
        current = { text: c.method === "editMessageText" ? String(c.body.text ?? "") : (current?.text ?? ""), rows: c.body.reply_markup?.inline_keyboard ?? [] };
      }
    }
    return current;
  };
  const awaitMessage = (label, id, predicate, timeoutMs = STEP_MS) => waitFor(label, (state) => {
    const current = fold(state.calls, id);
    return current && predicate(current) ? current : false;
  }, timeoutMs);
  const flat = (msg) => (msg?.rows ?? []).flat();
  const labels = (msg) => flat(msg).map((b) => String(b.text ?? ""));

  const sessionsDir = join(agentDir, "sessions");
  const sessionFiles = () => {
    try {
      return readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).filter((n) => String(n).endsWith(".jsonl")).sort();
    } catch { return []; }
  };
  const dumpPane = (tag) => console.log(`--- pane (${tag}) ---\n${String(tmux("capture-pane", "-p", "-t", SESSION).stdout ?? "").split("\n").filter((l) => l.trim()).slice(-22).join("\n")}\n---`);

  await waitFor("plugin authenticates", (state) => state.calls.some((c) => c.method === "getMe"), 60_000);
  record("host authenticates", true);

  // Seed three sessions, each holding one turn so its file is flushed.
  const turn = async (text) => {
    const since = await cursor();
    await injectMessage(text);
    await waitFor(`turn ${text}`, (state) => state.calls.slice(since).some((c) =>
      (c.method === "sendMessage" || c.method === "editMessageText") && /MOCK_OK/.test(String(c.body?.text ?? ""))), 60_000);
    await sleep(800);
  };
  const fresh = async () => {
    const ack = await dispatch("/new");
    const id = ack.body?.message_id ?? ack.message_id;
    const yesRe = /Yes$/;
    const dialog = await awaitMessage("new-session confirmation", id, (m) => flat(m).some((b) => yesRe.test(String(b.text ?? ""))));
    await press(flat(dialog).find((b) => yesRe.test(String(b.text ?? ""))), id);
    await sleep(2500);
  };
  await turn("alpha session");
  await fresh();
  await turn("bravo session");
  await fresh();
  await turn("charlie session");
  const seeded = sessionFiles();
  record("three sessions seeded", seeded.length === 3, `${seeded.length} files`);

  const openResume = async () => {
    const since = await cursor();
    const ack = await dispatch("/resume", 30_000);
    const id = ack.body?.message_id ?? ack.message_id;
    const msg = await awaitMessage("resume picker", id, (m) => m.rows.flat().some((b) => /delete/i.test(String(b.text ?? ""))), 30_000);
    void since;
    return { id, msg };
  };
  const { id: pickerId, msg: picker } = await openResume();
  console.log(`  picker text: ${plain(picker.text).slice(0, 300)}`);
  console.log(`  picker buttons: ${labels(picker).join(" | ")}`);
  console.log(`  picker data: ${flat(picker).map((b) => b.callback_data).join(" | ")}`);
  dumpPane("resume open");
  if (EXPLORE) return;
  const buttonLike = (msg, re) => flat(msg).find((b) => re.test(String(b.text ?? "")));
  const CONFIRM = /removes the session file/;
  const filesNamed = (word) => sessionFiles().filter((name) => {
    try { return readFileSync(join(sessionsDir, name), "utf8").includes(`${word} session`); } catch { return false; }
  });
  const sessionBodies = () => sessionFiles().map((name) => {
    try { return readFileSync(join(sessionsDir, name), "utf8"); } catch { return ""; }
  });
  const hasSession = (word) => sessionBodies().some((body) => body.includes(`${word} session`));
  const emptySessions = () => sessionBodies().filter((body) => !/ session"/.test(body)).length;
  const sinceFilesBefore = sessionFiles();

  // 1. Delete asks which session, and does not resume or delete anything.
  const picked = await (async () => {
    await press(buttonLike(picker, /^Delete/), pickerId);
    return awaitMessage("pick mode", pickerId, (m) => /choose a session/.test(m.text) || labels(m).includes("Back"));
  })();
  record("Delete switches the dialog to a session choice",
    labels(picked).includes("Back") && !labels(picked).includes("Resume") && /Delete: choose a session/.test(plain(picked.text)) && !CONFIRM.test(picked.text),
    `${plain(picked.text).slice(0, 90)} | ${labels(picked).join(" / ")}`);
  record("choice mode changes no session file", sessionFiles().join() === sinceFilesBefore.join());

  // 2. Back restores the list with Delete.
  await press(buttonLike(picked, /^Back$/), pickerId);
  const listAgain = await awaitMessage("list after Back", pickerId, (m) => labels(m).includes("Delete") && !labels(m).includes("Back"));
  record("Back returns to the session list", Boolean(listAgain));

  // 3. Delete a non-current session; Cancel keeps it.
  await press(buttonLike(listAgain, /^Delete/), pickerId);
  const choice = await awaitMessage("pick mode again", pickerId, (m) => labels(m).includes("Back"));
  await press(buttonLike(choice, /alpha session/), pickerId);
  const ask = await awaitMessage("confirm for alpha", pickerId, (m) => CONFIRM.test(m.text));
  record("choosing a row asks to delete that session", /alpha session/.test(ask.text), plain(ask.text).slice(0, 100));
  await press(buttonLike(ask, /Cancel/) ?? flat(ask).at(-1), pickerId);
  const afterCancel = await awaitMessage("list after cancel", pickerId, (m) => !CONFIRM.test(m.text) && labels(m).includes("Delete"));
  await sleep(800);
  record("Cancel keeps the chosen session", hasSession("alpha") && sessionFiles().length === 3, `${sessionFiles().length} files`);

  // 4. Delete it for real: exactly that file goes, the current session is untouched.
  await press(buttonLike(afterCancel, /^Delete/), pickerId);
  const choice2 = await awaitMessage("pick mode third", pickerId, (m) => labels(m).includes("Back"));
  await press(buttonLike(choice2, /alpha session/), pickerId);
  const ask2 = await awaitMessage("second confirm for alpha", pickerId, (m) => CONFIRM.test(m.text));
  await press(buttonLike(ask2, /^Delete$/), pickerId);
  const afterDelete = await awaitMessage("list without alpha", pickerId, (m) => !CONFIRM.test(m.text) && !labels(m).some((l) => /alpha session/.test(l)) && labels(m).some((l) => /bravo session/.test(l)), 30_000)
    .catch(() => undefined);
  await sleep(1500);
  record("confirm removes exactly the chosen session file",
    !hasSession("alpha") && hasSession("bravo") && hasSession("charlie") && sessionFiles().length === 2,
    `${sessionFiles().length} files; alpha gone: ${!hasSession("alpha")}`);
  record("deleting another session keeps the current one and refreshes the list", Boolean(afterDelete),
    afterDelete ? labels(afterDelete).join(" / ") : "list not refreshed");

  // 5. Delete the current session (charlie): OMP detaches to a fresh session first.
  await press(buttonLike(afterDelete, /^Delete/), pickerId);
  const choice3 = await awaitMessage("pick mode fourth", pickerId, (m) => labels(m).includes("Back"));
  const currentRow = buttonLike(choice3, /charlie session/);
  record("the current session is offered in the choice", Boolean(currentRow), labels(choice3).join(" / "));
  await press(currentRow, pickerId);
  const ask3 = await awaitMessage("confirm for charlie", pickerId, (m) => CONFIRM.test(m.text));
  await press(buttonLike(ask3, /^Delete$/), pickerId);
  await sleep(5000);
  const lastCurrent = fold((await controlGet()).calls, pickerId);
  console.log(`  after deleting the current session: files=${sessionFiles().length} (charlie present: ${hasSession("charlie")}, empty replacement sessions: ${emptySessions()})`);
  console.log(`  telegram picker: ${plain(lastCurrent?.text).slice(0, 160)} | ${labels(lastCurrent).join(" / ")}`);
  dumpPane("after deleting the current session");
  record("deleting the current session removes its file", !hasSession("charlie"));
}

main().catch((error) => { console.error(error); process.exit(1); });
