# pi-telegram-plus

## Overview

**Full Telegram control of [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — commands, interactive UI, model/session management, file transfer, multi-instance switching, and real-time streaming output, all from Telegram.**

`pi-telegram-plus` is a pi extension that turns Telegram into a full-featured remote control surface for the pi coding agent. It's not just a notification bot — it gives Telegram the same interaction as the pi (or OMP) terminal, with interactive menus, inline keyboards, file attachments, live agent output rendering, and safe coordination when several local pi processes share one bot token.

---

## Compatibility

- Requires Node.js `>=22.19.0`.
- Supports exactly one version of each host: **pi coding agent `1.4.0`** and **OMP
  `18.12.x`**. On any other version, or when the version cannot be read, the extension
  refuses to start and says so in the status bar and in Telegram. There is no fallback
  mode and no multi-version support; a new host version is enabled only after its source
  has been reviewed and the E2E suites pass on it.
- The publish gate (`prepublishOnly` + the publish workflow) runs `npm test`,
  `npm run typecheck` and `npm run changelog:check`.
- Details, including the OMP-specific notes, live in
  [docs/compatibility.md](docs/compatibility.md).

### Verification

| Suite | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Unit / regression | `npm test` |
| Round trip (pi in `tmux` + mock Telegram Bot API + mock provider) | `npm run test:e2e` |
| OMP round trip | `npm run test:e2e:omp` |
| TUI bridge (pi and OMP) | `npm run test:e2e:tui-bridge` |
| Command acceptance (both hosts) | `npm run test:e2e:commands` |
| Dialog round trip (both hosts) | `npm run test:e2e:dialogs` |
| Interaction parity | `npm run test:e2e:parity` |
| State equivalence (terminal vs Telegram) | `npm run test:e2e:state` |
| Real Bot API smoke | `npm run test:e2e:real` |

The E2E suites run the pi in `node_modules` (`1.4.0`); `--pi-bin` points them at another
binary. The mock Bot API enforces Telegram's payload contract and answers 400 on
violations, and every recorded call is re-validated independently. E2E is not part of the
publish gate because each run starts isolated `tmux` sessions.

If this repository is also installed as a global OMP plugin (`omp plugin link`), OMP loads the plugin a
second time next to the copy under test and the two instances fight over the same dialogs. The E2E scripts
start the hosts with `--no-extensions` for that reason; do the same if you start OMP by hand with `-e`.
The `/login` steps in `test:e2e:dialogs` put a stub `open` on `PATH` so no browser opens.

---

## Features

### 🤖 Bot Connectivity
- **Long polling** — receives messages and callback queries in real time
- **Multi-instance switching** — multiple local pi processes can share one bot token; only one instance is active at a time, selected with `/tg` → 🔄 Switch instance (see **Multi-instance Coordination**)
- **Isolated outbound routing** — standby instances cannot leak local assistant output, tool results, UI notifications, typing actions, or `tg_attach` files into the active Telegram chat
- **Full branch replay** — switching automatically replays the target session's current branch from its first message, including images and the configured `tool` / `thinking` detail levels, then resumes normal routing
- **Heartbeat failover** — when the active local instance disappears, another live instance claims ownership after its heartbeat expires
- **Automatic reconnection** — exponential backoff on transient polling failures; a file-based polling lock remains the final safety guard against dual pollers
- **Shared update cursor** — instances sharing a token keep a coordinated `lastUpdateId`, so handoffs do not re-deliver or skip Telegram updates; a cursor that ends up outside the bot's id stream (re-created bot, reused token) is detected on the next start and rewound instead of silently discarding messages
- **Startup auto-enable** — if a bot token is already configured, Telegram is enabled automatically when pi starts (no manual reconnect on every launch)
- **Bot command menu sync** — automatically syncs available commands to Telegram's BotMenu (up to 100 commands), including `/tg`; when the catalog exceeds the cap the last slot becomes `/more`, which opens a paged inline keyboard of the overflow commands
- **Authorized user** — setup generates a one-time local pairing code; the Telegram user must send `/pair <code>` before their user id is persisted; all other users are rejected
- **TUI status line** — a right-aligned `telegram+` footer preserves connected / active / awaiting pairing / disconnected / not configured / error states; the owning instance shows `connected(current)` when idle or `active(current)` while processing, together with the bot username
- **Typing indicator** — sends `typing` chat-action pulses while a turn is active so the Telegram chat shows the bot is working
- **Forum topic aware** — messages, inline prompts, tool output, attachments, and typing actions preserve Telegram `message_thread_id` so supergroup topics do not cross streams
- **Quoted message context** — when you reply to a Telegram message, the quoted text/caption and attachment summary are included in the prompt sent to pi so the agent understands what “this” refers to

### 🎮 Host Commands, Run by the Host
A slash command sent from Telegram is typed into the host's own editor and executed by the host, exactly as if you had typed it in the terminal: `/model`, `/resume`, `/tree`, `/fork`, `/settings`, `/login`, `/compact`, `/export` and every other command the host advertises. The plugin does not reimplement any of them. Their output is relayed back as a reply to your message, and any dialog they open appears in Telegram as buttons (see **Dialogs in Telegram**). The Telegram bot menu is built from the host's live command catalog plus `/tg`.

Shell commands work the same way: `!cmd` and `!!cmd` (output kept out of the model context) are handed to the host's shell path after the **Shell confirm** policy (`/tg` → Config) approves them, so extensions that guard shell commands still see them. The final output is sent back once the command finishes.

### 📨 Message Delivery (TUI Parity)
Messages sent from Telegram behave **exactly like typing in the pi terminal**:

- **Main thread running** — the message steers into the main turn, like typing while the agent works.
- **Background workflow running** (main loop idle) — the message is held (`⏳ π is busy — holding your message…`) and delivered as a **fresh main-thread turn** with a plain prompt once the main loop settles. It is never injected into a workflow agent's conversation.
- **Everything idle** — the message starts a fresh main-thread turn immediately.

### 🤖 Workflow Rendering (TUI Parity)
The terminal never shows subagent turns as part of the main conversation — workflow progress lives in its own panel. Telegram does the same:

- Subagent turns, messages, and tool calls are **never rendered** to the chat.
- A single `🤖 Workflow running…` line appears per workflow window.
- The main thread's own messages (before and after a workflow) render normally.

Tool and thinking rendering stay configurable via `/tg` → Config (`hidden|brief|full`).

### 🖥️ Dialogs in Telegram
When a command or turn you started from Telegram makes the host ask something, the host draws the dialog in the terminal **and** the same question appears in Telegram as inline buttons. Whoever answers first wins; the other side's dialog or keyboard is withdrawn. Dialogs raised by a local terminal turn stay in the terminal.

| Dialog | How it reaches Telegram |
|--------|-------------------------|
| Extension `select` / `confirm` / `input` (both hosts), and OMP's `editor`, `ask` tool and tool approvals | The Telegram answer is handed straight to the waiting call and the host's copy is closed through the call's own cancel signal — no keystrokes are simulated |
| pi built-in pickers: models, scoped models, sessions (`/resume`), session tree (`/tree`), fork/clone messages, settings (with search and submenus), project trust, login providers | Read from the component's own fields; your choice is applied through the host's input path |
| pi login prompts (API key, pasted codes) | Always treated as secrets: your reply is deleted from the chat right after it is used and never echoed back. Remembered secrets are masked as `***` in everything the plugin sends afterwards; see [docs/compatibility.md](docs/compatibility.md#secrets) for the limits |
| OMP built-in pickers and settings (`/model` including the role assignment step, `/settings`, `/login`, `/agents`, …) | Read from the components' semantic description and answered with structured events |
| [`@capyup/pi-goal`](https://www.npmjs.com/package/@capyup/pi-goal) `custom()` dialogs (draft confirmation, `goal_question`, `goal_questionnaire`) | A dedicated adapter turns them into option buttons, a typed-answer path and Submit/Cancel |
| Anything the plugin cannot model | A plain notice — "the terminal shows a dialog Telegram cannot handle, please answer it there" — with a single Cancel button. The plugin never guesses keystrokes or mirrors screen text |

A new command from the same chat while one of its dialogs is open closes that dialog first; `/stop` cancels it.

### 🎨 Message Rendering
- **Markdown → Telegram HTML** — Full conversion via `marked` (tables, code blocks, blockquotes, lists, inline formatting)
- **Native table rendering** — an answer containing a GitHub-style table is delivered as a Telegram **Rich Message** (`sendRichMessage` / `rich_message` on `editMessageText`, Bot API 10.1+), so the client draws a real bordered table instead of ASCII art. Answers without a real table keep the HTML path unchanged, and any server that rejects Rich Messages automatically falls back to the mobile-first layouts below
- **Mobile-first table fallback** — box-drawing and card layouts with pseudo-table protection and header repetition across split chunks, so wide tables stay readable on phone screens
- **Tool execution rendering** — Configurable level (`hidden` / `brief` / `full`) for tool call visibility
- **Thinking rendering** — Configurable level (`hidden` / `brief` / `full`) for agent thinking blocks
- **Output splitting** — Safe UTF-8-aware splitting at Telegram's 4096-byte limit
- **Oversized code blocks** — automatically sent as downloadable files instead of being split across many `<pre>` messages
- **Image output** — Automatically sends agent-generated images as Telegram photos

### 📎 File Attachments

**Upload (agent → Telegram):**
- Custom `tg_attach` tool available to the agent
- Sends files/documents/photos to the active Telegram chat
- Size limit enforcement (default 50 MB)
- Sensitive path blocking (e.g., `/etc`, `~/.ssh`)
- Automatic photo detection (jpg/png/webp → send as photo, fallback to document)

**Download (Telegram → user → agent):**
- Automatically saves incoming photos, documents, videos, audio, voice, stickers to the working directory
- Reports saved paths back to the user
- Handles name sanitization and deduplication

---

## Usage Guide

### Command naming

- Host commands keep their host names (`/model`, `/resume`, `/settings`, …) and are executed by the host.
- Everything about the Telegram bridge itself lives in one menu, `/tg` (bots, project binding, config, instance switching). The old flat `/tg-*` commands are gone; typing one gets a pointer to `/tg`.
- Plugin-only commands: `/tg`, `/stop`, `/status`, `/cwd`, `/cd`. Where a plugin feature would share a name with a host command it lives inside `/tg` instead (for example `/tg` → 🛠 Debug info), so `/debug` and the like reach the host.
- `/pair <code>` is a Telegram-only bootstrap message handled before normal dispatch, because the setup prompt is copied into Telegram before any user is authorized.
- Telegram command menus do not allow hyphens; the controller accepts both `_` and `-` forms. When the catalog exceeds Telegram's 100-entry cap, the last menu slot becomes `/more`, a paged keyboard of the overflow.

### Multi-instance Coordination

Several local pi processes can share one bot (the **default bot** or a bot bound to a shared project). Coordination keeps Telegram traffic attached to exactly one owner at a time. The **default bot** (`/tg` → Bots → ⭐ Default bot) is the equivalent of the former "global" bot — projects without an explicit binding fall back to it.

1. **Registration** — each enabled process advertises itself under `~/.pi/agent/` with cwd, session, model, busy state, and a heartbeat.
2. **Single active owner** — only the active instance polls Telegram and is allowed to send outbound messages. Standby instances stay quiet even if their local agent is streaming.
3. **Explicit switch** — from the currently active instance, open `/tg` → 🔄 Switch instance and pick a live instance (`project · session · model · id`).
4. **History replay** — after a switch, the new owner stops polling briefly, posts a switch banner (cwd / model / message count), replays the current session branch (user/assistant text, images, and tool/thinking blocks at the configured render levels), then posts `History replay complete` and resumes polling.
5. **Automatic failover** — if the active process dies or stops heartbeating, another live instance claims ownership (`reason: failover`) without a manual switch.
6. **Safety locks** — coordinator state and the polling lock both clean up abandoned candidate/tombstone artifacts automatically. A live `tg-poll-*.lock` directory is still the last line of defense against two pollers.

TUI footer states for the current process:

| Status text | Meaning |
|-------------|---------|
| `telegram+ connected(current) @bot` | This process owns the bot and is idle |
| `telegram+ active(current) @bot` | This process owns the bot and a turn is in progress |
| `telegram+ connected @bot` | Bot is up, but another local process is the owner |
| `telegram+ active @bot` | Another local process owns the bot and is processing |
| `telegram+ awaiting pairing` | Token present, pairing code not yet consumed |
| `telegram+ disconnected` / `not configured` / `error …` | Disabled, missing token, or last connection error |

### Replying to Telegram messages

When an incoming Telegram message is a reply, `pi-telegram-plus` prepends a bounded quote block to the prompt:

```text
[telegram quoted message]
message_id: 123
from: @alice id:456
text:
quoted text...

[telegram message]
your reply...
```

Quoted attachments are represented as metadata (`[telegram quoted attachment]`, file name/type/frame count) but are not downloaded again. If Telegram provides selected-quote metadata instead of a full replied-to message, the selected quote is included as `[telegram quoted text]`. If Telegram only provides a reply message id, the prompt still includes that id with `content: unavailable from Telegram update`. Replies to active `input`/`editor`/`custom` prompts are still consumed as UI input instead of being sent as agent prompts.

### Session, Model and Authentication Commands

These are the host's own commands, run by the host (see **Host Commands, Run by the Host**). Their pickers and prompts appear in Telegram as described in **Dialogs in Telegram**:

- Sessions: `/new`, `/resume`, `/tree`, `/fork`, `/clone`, `/compact`, `/name`, `/session`, `/export`, `/import`, `/share`
- Models: `/model`, `/scoped-models` (pi), `/thinking` (pi); on OMP the thinking level is under `/tg` → Config
- Authentication: `/login`, `/logout` — API keys typed in Telegram are deleted from the chat after use

`/new` and `/reload` replace the host session in-process; the plugin saves its Telegram position first so the command is never run twice.

### Telegram Connection: the `/tg` menu

All bot registry, project binding, config and instance-switching actions live in the **`/tg` menu**.

#### `/tg` — Telegram management menu

Opens an inline-keyboard menu with four submenus (each with a **⬅️ Back** option to return to the parent level):

| Menu | Actions |
|------|--------|
| **🤖 Bots** | **➕ Add bot** — prompt for name + token, create a pairing code · **Bot list** — every registered bot with `⭐ default` and `paired` / `not paired` markers; pick one for **Update** (token / name / allowedUserId / apiBase), **Pairing** (show the pairing code and issue a new one, or **Unpair** after a confirmation — the chat stops working until you pair again) and **Remove** (confirm; warns if it is the default) · **⭐ Default bot: <name>** — pick the bot every unbound project uses, or **Clear default** |
| **📁 Project** | **Bot: <name>** (or `<name> (default)` when the folder follows the default bot) — bind this folder to another bot or **Unbind** · the connection state, read from the running instance: **🟢 Connected → Disconnect**, **🔄 Connecting → Disconnect**, **🟡 In use by another instance**, **⚪ Disconnected → Connect**. Disconnecting asks first, is saved (also for folders that follow the default bot) and survives restarts; Telegram then stops responding, so you reconnect from the terminal with `/tg` |
| **⚙️ Config** | **🔧 Tool** — hidden / brief / full · **💭 Thinking** — hidden / brief / full · **🧠 Thinking level** — model reasoning effort (OMP only, shown when the model supports it; on pi use `/thinking`) · **🔄 Retry** — 0–10 · **🐚 Shell confirm** — dangerous / always / never |
| **🔄 Switch instance** | List live pi instances sharing this bot token; select one to switch. Must be run on the currently active instance. |
| **🛠 Debug info** | The plugin's own diagnostics (model, thinking, streaming, entries, cwd). `/debug` itself runs the host's command. |
| **❌ Close** | Exit the menu. |

The menu uses the same UI abstraction that renders Telegram inline keyboards (`ctx.ui.select` / `input` / `inputSecret` / `confirm`). In Telegram, navigation edits **one message in place** — moving between levels updates that message instead of posting a new one per level. A leaf action that needs its own prompt (input, confirm, a value picker) appears below it, and the menu then continues as a fresh message under that prompt. The local TUI falls back to ordinary selects. Each leaf action shows a result notification, then returns to its submenu.

**How it works:** Bots are registered once (`/tg` → Bots → Add bot; token, username and pairing are stored centrally in `~/.pi/agent/tg.json`). Projects reference a bot by id (`/tg` → Project → Bot: <current> → pick a bot, stored in `<project>/.pi/telegram.json`) — no token re-paste or re-pairing. Unbound projects fall back to the **default bot** (`/tg` → Bots → ⭐ Default bot, which also offers **Clear default**).

#### Pairing / authorization

| Command | Description |
|---------|-------------|
| `/pair <code>` | Pair the sending Telegram user with this pi instance. The one-time code is shown locally after setup and is consumed on success. `/pair@BotUsername <code>` is also accepted in groups. |

### Plugin Commands

| Command | Description |
|---------|-------------|
| `/tg` | Telegram management menu |
| `/stop` | Abort the current agent turn and cancel this chat's open dialog |
| `/status` | Show a runtime snapshot (workspace, model, context, messages) |
| `/cwd` | Show the current working directory |
| `/cd` | Switch pi's working directory |

Every other command in the bot menu is a host command and behaves as it does in the terminal.

---

## Troubleshooting

Common issues and diagnostic steps. The extension writes a structured JSON Lines log to `<agent dir>/logs/pi-telegram-plus-YYYY-MM-DD.log` (default `~/.pi/agent/logs/`). Set `PI_TELEGRAM_PLUS_LOG_LEVEL=debug|info|warn|error` to control verbosity. See [docs/logging.md](docs/logging.md) for the full logging design.

### The bot does not respond to my messages
- Verify the bot token is correct: register it via `/tg` → Bots → Add bot with the token from [@BotFather](https://t.me/BotFather), or fix an existing bot's token via `/tg` → Bots → Bot list → <bot> → Update.
- Confirm the bot is connected: `/tg` → **Project** shows the current binding and the real connection state. If it says **⚪ Disconnected**, connect it there from the terminal — a disconnect is remembered across restarts, so it does not come back on its own.
- Make sure you are the authorized user. After setup, pi prints a one-time pairing code locally; send `/pair <code>` to the bot from your Telegram account. To reset authorization, remove the bot (`/tg` → Bots → Bot list → <bot> → Remove) and re-add it.
- When several local pi processes share the token, check the local TUI footer: only `connected(current)` / `active(current)` owns polling and outbound traffic. From that owner, open `/tg` → 🔄 Switch instance to inspect and select another live instance. Dead owners fail over automatically after their heartbeat expires.
- The file-based polling lock remains a final safety guard. If the expected instance is already active but polling still reports a lock conflict, restart the conflicting older process or remove only the confirmed stale `tg-poll-*.lock` directory under `~/.pi/agent/`. Retired/candidate lock leftovers are cleaned automatically and should not need manual deletion.

### Messages arrive but the agent output is not streamed
- Confirm pi has an active model and valid credentials: run `/model` and `/status` from Telegram.
- Confirm this local process is the Telegram owner (`telegram+ connected(current)` / `active(current)` in the TUI). Standby instances deliberately suppress outbound assistant/tool/UI/`tg_attach` traffic.
- If an instance switch just completed, wait until the history-replay banner finishes (`History replay complete`) before expecting new streamed output; outbound sends are gated until replay ends.
- If `tool` / `thinking` rendering is set to `hidden`, output may look silent. Open `/tg` → Config and set Tool / Thinking back to `brief` to surface activity (these levels also control what history replay includes).
- Long single messages may exceed Telegram's 4096-byte limit; the extension splits them automatically, but if delivery still fails, check your network and the pi log for upstream API errors.

### Switching instances fails or history replay looks wrong
- Switching only works on the currently active instance. If you see `This pi instance is not the active Telegram instance`, switch from the owner process or wait for failover.
- The selector only lists processes that are still heartbeating. Restart the missing pi if it does not appear.
- Replay targets the new owner's current session branch and the chat/topic where the switch was requested. Empty sessions produce a banner with `0 messages` and no body replay.
- A failed replay posts `History replay failed` in Telegram and still completes the handoff so the new owner can accept fresh messages; check the pi log for details.

### A dialog does not appear in Telegram
- Only dialogs raised by a command or turn started from Telegram are sent to Telegram; dialogs from a local terminal turn stay in the terminal.
- A dialog the plugin cannot model arrives as a plain "please answer it in the terminal" notice with a Cancel button. That is expected; answer it in the terminal.
- Inline keyboards are removed once the dialog is answered on either side or cancelled with `/stop`. Re-run the command to get a fresh keyboard.
- Check the log at `PI_TELEGRAM_PLUS_LOG_LEVEL=debug`: `tui-broker` lines show which adapter claimed the dialog and who owned it.

### The bot says the host version is not supported
- The plugin only runs on pi `1.4.0` and OMP `18.12.x` and stops on anything else (see **Compatibility**). Install a supported host version.

### `/tg` is missing
- The extension must be registered as a pi package. Re-run `pi install npm:pi-telegram-plus` (or `pi packages add .` from source) and restart pi.
- Run `/reload` to refresh command registration without a full restart.

### File attachments fail to send or are rejected
- Outbound `tg_attach` blocks sensitive paths (`/etc`, `~/.ssh`, etc.). Move the file to a non-sensitive location and retry.
- Default upload size limit is 50 MB. Files exceeding it are rejected; reduce the file size or split the content.
- For download failures (Telegram → working directory), check that the working directory is writable and that the filename was sanitized correctly. Saved paths are reported back in the chat.

### Polling reconnects repeatedly or reports transient failures
- The extension uses exponential backoff on transient errors. If failures persist, verify network reachability to `api.telegram.org` and that the bot token has not been revoked in BotFather.
- A revoked/regenerated token will keep failing until you update it via `/tg` → Bots → Bot list → <bot> → Update.

### The bot stops seeing new messages, or a message is repeated
- If polling looks healthy (the TUI shows `connected(current)`) but new Telegram messages are ignored, check the log for `poll cursor is ahead of the update stream; rewinding`. The shared cursor was seeded from an `update_id` sequence this bot no longer belongs to, so polling asked for updates past the end of the stream. Polling probes the unconfirmed backlog once per start and rewinds the cursor on the first batch it receives, so a restart repairs this — no action needed.
- If messages are still ignored after that, the Bot API server in use refuses out-of-range requests rather than answering them, so anything that arrived while the bad cursor was live was discarded. Reset the cursor by hand: delete `~/.pi/agent/tg-runtime/<token-hash>/cursor.json` and the `lastUpdateId` field in `<project>/.pi/telegram.json`, then restart pi — Telegram re-delivers whatever it still holds.
- If the bot repeats the same message several times, a prompt was rejected by a busy session and the delivery path retried it; the log shows `main-delivery prompt raced with a new turn` per attempt. Wait for the current turn to finish (or send `/stop`) before resending.

### Configuration changes are not picked up
- The bot registry lives in `~/.pi/agent/tg.json` (version 3). Project bindings live in `<project>/.pi/telegram.json`. After editing by hand, run `/reload` (or restart pi) so the extension re-reads config.
- If the wrong bot responds, open `/tg` → **Project** to check the current binding, and change or remove the binding there to fall back to the default bot.
- The v2 → v3 migration runs automatically on first read: global config becomes the default bot, workspaces become per-project `.pi/telegram.json` files with token dedup.
