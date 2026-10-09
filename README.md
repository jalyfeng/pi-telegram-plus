# pi-telegram-plus

## Overview

**Full Telegram control of [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — commands, interactive UI, model/session management, file transfer, multi-instance switching, and real-time streaming output, all from Telegram.**

`pi-telegram-plus` is a pi extension that turns Telegram into a full-featured remote control surface for the pi coding agent. It's not just a notification bot — it mirrors the core pi TUI experience into Telegram, with interactive menus, inline keyboards, file attachments, live agent output rendering, and safe coordination when several local pi processes share one bot token.

---

## Compatibility

- Requires Node.js `>=22.19.0`.
- Supported pi coding agent range: `@earendil-works/pi-coding-agent >=0.80.7 <0.85.0 || >=0.85.1 <0.86.0`.
- Release validation uses temporary clean installs for representative pi versions and a manual Telegram smoke test on the latest verified pi.
- pi `0.74.x` is intentionally unsupported because its public TypeScript surface is incompatible with this extension.
- pi versions older than `0.80.7` are no longer supported.
- pi `0.85.0` is excluded because its published package imports the undeclared `@earendil-works/pi-server` runtime dependency.
- Future pi minor versions should be treated as unverified until the compatibility matrix passes.

| pi coding agent | Automated clean install (`typecheck` + tests) | Manual Telegram end-to-end test |
|-----------------|-----------------------------------------------|---------------------|
| `0.80.7` | passed | not run |
| `0.80.10` | passed | not run |
| `0.81.1` | passed | passed — `/status`, `/debug`, agent prompt, `read`, `bash` + `/stop`, `tg_attach`, inbound attachment save, `/tg-config` inline callback |
| `0.84.0` | passed | not run |
| `0.85.0` | excluded — published package imports undeclared `@earendil-works/pi-server` runtime dependency | not run |
| `0.85.1` | passed | passed — Telegram command handling and UI notifications |

---

## Features

### 🤖 Bot Connectivity
- **Long polling** — receives messages and callback queries in real time
- **Multi-instance switching** — multiple local pi processes can share one bot token; only one instance is active at a time, selected with `/tg-switch` (see **Multi-instance Coordination**)
- **Isolated outbound routing** — standby instances cannot leak local assistant output, tool results, UI notifications, typing actions, or `tg_attach` files into the active Telegram chat
- **Full branch replay** — switching automatically replays the target session's current branch from its first message, including images and the configured `tool` / `thinking` detail levels, then resumes normal routing
- **Heartbeat failover** — when the active local instance disappears, another live instance claims ownership after its heartbeat expires
- **Automatic reconnection** — exponential backoff on transient polling failures; a file-based polling lock remains the final safety guard against dual pollers
- **Shared update cursor** — instances sharing a token keep a coordinated `lastUpdateId`, so handoffs do not re-deliver or skip Telegram updates
- **Startup auto-enable** — if a bot token is already configured, Telegram is enabled automatically when pi starts (no manual `/tg-*-connect` on every launch)
- **Bot command menu sync** — automatically syncs available commands to Telegram's BotMenu (up to 100 commands), including `/tg_switch`
- **Authorized user** — setup generates a one-time local pairing code; the Telegram user must send `/pair <code>` before their user id is persisted; all other users are rejected
- **TUI status line** — a right-aligned `telegram+` footer preserves connected / active / awaiting pairing / disconnected / not configured / error states; the owning instance shows `connected(current)` when idle or `active(current)` while processing, together with the bot username
- **Typing indicator** — sends `typing` chat-action pulses while a turn is active so the Telegram chat shows the bot is working
- **Forum topic aware** — messages, inline prompts, tool output, attachments, and typing actions preserve Telegram `message_thread_id` so supergroup topics do not cross streams
- **Quoted message context** — when you reply to a Telegram message, the quoted text/caption and attachment summary are included in the prompt sent to pi so the agent understands what “this” refers to

### 🎮 Full Session Control
All pi session lifecycle commands are available via Telegram — start, fork, clone, navigate, resume, compact, rename, and inspect sessions. See **Session Control Commands** in the Usage Guide.

### 🧠 Model & Authentication Management
Switch the current model, toggle scoped model sets, adjust the thinking level, and complete OAuth or API key authentication with full interactive flows — all from Telegram. See **Model & Authentication Commands** in the Usage Guide.

### 📨 Message Modes
Two modes for handling incoming messages while the agent is running:

- **`steer`** (default) — New messages inject into the current turn via `streamingBehavior: "steer"`. The agent stays streaming while receiving new input.
- **`queue`** — Messages wait in a per-chat queue for the current turn to finish.

### 🖥️ Interactive Telegram UI
Full interactive UI components built on inline keyboards:

- **Notify** — status/error messages
- **Confirm** — Yes / No / Cancel buttons
- **Input** — text input with Cancel button; replies are captured as input
- **InputSecret** — same as Input, but the prompt message is auto-deleted after reply to protect sensitive data
- **Select** — paginated option list with Prev/Next navigation
- **Editor** — multi-line text input prompt
- **Custom (third-party)** — `ctx.ui.custom(factory)` dialogs from extensions like [`@capyup/pi-goal`](https://www.npmjs.com/package/@capyup/pi-goal) are bridged to inline buttons. See **Third-party Dialog Support** below.

### 🧩 Third-party Dialog Support

Third-party extensions that use `ctx.ui.custom(factory)` (such as [`@capyup/pi-goal`](https://www.npmjs.com/package/@capyup/pi-goal))
are bridged to Telegram inline buttons so remote turns can interact with them:

| Scenario | Telegram behavior |
|----------|-------------------|
| **pi-goal draft confirmation** (`propose_goal_draft` → `showProposalDialog`) | Shows ✅ Confirm / 💬 Continue chatting buttons. Confirm creates the goal; Continue lets the agent keep refining; `/stop` or timeout cancels. |
| **pi-goal `goal_question`** (single question) | Shows the question text, option buttons (paginated if needed) as toggle buttons (☐/☑, multi-select), a ✏️ Type answer button for free-text entry, and Cancel. A ✓ Submit button appears once at least one option is selected (or a custom answer is given); the selected options are joined into a single string answer. Free-text entry finalizes immediately. |
| **pi-goal `goal_questionnaire`** (multi-question) | Drives the opaque questionnaire component: cycles tabs to extract every question, then presents one question at a time with option buttons as multi-select toggles (☐/☑), ◀ Tab / Tab ▶ navigation between questions (no forced auto-advance on option pick), ✏️ Type for free-text entry, and Cancel. A ✓ Submit button only appears once every question is answered; before that the message shows a `Still to answer: …` placeholder. Per-question selections are joined into single-string answers. Falls back to a `cancelled` degrade only if the component lacks the expected `handleInput`/`render` API. |
| **Unknown `custom()` components** | Auto-dismissed with a ⚠️ notification and a `cancelled` result, so the agent continues gracefully (never hangs or throws). |

**Interactive modals are Telegram-only during a Telegram turn.** Interactive modals (confirm, select, input, editor, custom) are bridged to Telegram inline buttons for the remote user and are NOT also rendered in the local TUI. `ExtensionUIContext.custom` and the other modals expose no external cancel handle, so mirroring a modal into the TUI during a remote turn would leave the local TUI stuck at the dialog once the Telegram side resolves. Local TUI turns never enter the Telegram UI swap, so they keep using the real TUI UIContext and are completely unaffected. Persistent/stateful UI (goal widget, status line, working indicator, footer/header) is forwarded to the TUI base so the local TUI always shows accurate state. Editor operations (paste, set/get text) are no-ops during Telegram turns, so a remote turn never touches the local editor.

> **Command-triggered turns are held to the end of the chain.** Commands like `/sisyphus` and `/goals` enqueue the agent turn fire-and-forget via `pi.sendUserMessage` and return immediately; the actual turn (and the `goal_question` / `goal_questionnaire` / `propose_goal_draft` dialogs it raises) runs afterward. The controller keeps the Telegram UI swap active across that enqueued turn and any pi-goal auto-continue chain (waiting for the agent to go idle through a small grace window), so every dialog in the chain bridges to Telegram instead of rendering to the local TUI. The hold is skipped when a local turn was already streaming, so it never hijacks an active local session.

### 🎨 Message Rendering
- **Markdown → Telegram HTML** — Full conversion via `marked` (tables, code blocks, blockquotes, lists, inline formatting)
- **Mobile-first table rendering** — box-drawing and card layouts with pseudo-table protection and header repetition across split chunks, so wide tables stay readable on phone screens
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

- Commands that mirror pi's native slash commands keep the same names (`/model`, `/session`, `/status`, `/stop`, `/thinking`, etc.) so Telegram behaves like a remote pi control surface instead of a separate bot-specific CLI.
- Commands that configure or manage the Telegram bridge itself use the `/tg-*` prefix (`/tg-global-setup`, `/tg-config`, `/tg-list`, `/tg-switch`, etc.).
- `/pair <code>` is a Telegram-only bootstrap authorization message handled before normal command dispatch. It is intentionally short and not `/tg-pair` because the setup prompt is copied into Telegram during first-time pairing, before any user is authorized.
- Telegram Bot API command menus do not allow hyphens, so the bot menu may show underscore aliases such as `/tg_config`, `/tg_switch`, or `/tg_global_setup`; the controller accepts both underscore and hyphen forms.

### Multi-instance Coordination

Several local pi processes can share one bot token (for example different workspaces or sessions). Coordination keeps Telegram traffic attached to exactly one owner at a time:

1. **Registration** — each enabled process advertises itself under `~/.pi/agent/` with cwd, session, model, busy state, and a heartbeat.
2. **Single active owner** — only the active instance polls Telegram and is allowed to send outbound messages. Standby instances stay quiet even if their local agent is streaming.
3. **Explicit switch** — from the currently active instance, run `/tg-switch` (bot menu: `/tg_switch`):
   - no args → inline selector listing live instances (`project · session · model · id`)
   - `/tg-switch <instance-id-prefix>` → switch by id or unambiguous prefix
   - `/tg-switch current` → keep the current owner and re-run history replay
4. **History replay** — after a switch, the new owner stops polling briefly, posts a switch banner (cwd / model / message count), replays the current session branch (user/assistant text, images, and tool/thinking blocks at the configured render levels), then posts `History replay complete` and resumes polling.
5. **Automatic failover** — if the active process dies or stops heartbeating, another live instance claims ownership (`reason: failover`) without a manual `/tg-switch`.
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

### Session Control Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/fork` | Fork from a previous user message |
| `/clone` | Clone at a previous user message |
| `/tree` | Navigate session tree |
| `/resume` | Resume a previous session |
| `/compact` | Compact session context |
| `/name` | Set or show session name |
| `/session` | Show session statistics |

### Model & Authentication Commands

- `/model` — View available models / switch current model via interactive selection
- `/scoped-models` — Toggle scoped model sets
- `/thinking` — Adjust thinking level (off/minimal/low/medium/high/xhigh)
- `/login` — OAuth or API key authentication with full interactive flow
- `/logout` — Remove stored credentials

### Telegram Connection Commands

**Global scope** (a single bot token shared across all workspaces):

| Command | Description |
|---------|-------------|
| `/tg-global-setup` | Configure the global bot token and connect (first-time setup) |
| `/tg-global-connect` | Enable / start the global bot connection |
| `/tg-global-disconnect` | Disable / stop the global bot (keeps the token) |

**Workspace scope** (per-directory bot token; overrides global when bound):

| Command | Description |
|---------|-------------|
| `/tg-bind-cwd` | Bind the current directory to its own bot token |
| `/tg-cwd-connect` | Enable the bot for the current directory |
| `/tg-cwd-disconnect` | Disable the bot for the current directory |
| `/tg-unbind-cwd` | Remove the current directory's bot binding |
| `/tg-list` | List all bot bindings (global + workspace) |

**Pairing / authorization:**

| Command | Description |
|---------|-------------|
| `/pair <code>` | Pair the sending Telegram user with this pi instance. The one-time code is shown locally after setup and is consumed on success. `/pair@BotUsername <code>` is also accepted in groups. |

**Shared:**

| Command | Description |
|---------|-------------|
| `/tg-config` | Configure rendering levels and message mode |
| `/tg-switch [instance-id\|current]` | Switch the active local pi instance that owns this bot token (bot menu: `/tg_switch`). No args opens an inline selector; an id/prefix targets one live instance; `current` re-replays the active owner. Must be run on the currently active instance. See **Multi-instance Coordination**. |

### Utility Commands

| Command | Description |
|---------|-------------|
| `/cwd` | Show current working directory |
| `/cd` | Switch pi working directory |
| `/stop` | Abort the current agent turn |
| `/status` | Show runtime snapshot (workspace, model, context, messages) |
| `/debug` | Show debug info (model, thinking, streaming, entries) |
| `/settings` | Open settings menu |
| `/copy` | Copy last assistant text |
| `/export` | Export session to HTML/JSONL |
| `/import` | Import a session JSONL file |
| `/share` | Export session for sharing (gist) |
| `/reload` | Reload extensions, skills, prompts |
| `/quit` | Shut down pi |
| `/changelog` | Show changelog link |
| `/hotkeys` | Show keyboard shortcuts reference |

---

## Troubleshooting

Common issues and diagnostic steps. The extension writes a structured JSON Lines log to `<agent dir>/logs/pi-telegram-plus-YYYY-MM-DD.log` (default `~/.pi/agent/logs/`). Set `PI_TELEGRAM_PLUS_LOG_LEVEL=debug|info|warn|error` to control verbosity. See [docs/logging.md](docs/logging.md) for the full logging design.

### The bot does not respond to my messages
- Verify the bot token is correct: run `/tg-global-setup` (global) or `/tg-bind-cwd` (workspace) and re-paste the token from [@BotFather](https://t.me/BotFather).
- Confirm the bot is connected: `/tg-list` should show the binding as enabled. If not, run `/tg-global-connect` or `/tg-cwd-connect`. A configured token is auto-enabled again on the next pi start.
- Make sure you are the authorized user. After setup, pi prints a one-time pairing code locally; send `/pair <code>` to the bot from your Telegram account. To reset authorization, remove the binding and re-setup.
- When several local pi processes share the token, check the local TUI footer: only `connected(current)` / `active(current)` owns polling and outbound traffic. From that owner, send `/tg-switch` (bot menu: `/tg_switch`) to inspect and select another live instance. Dead owners fail over automatically after their heartbeat expires.
- The file-based polling lock remains a final safety guard. If the expected instance is already active but polling still reports a lock conflict, restart the conflicting older process or remove only the confirmed stale `tg-poll-*.lock` directory under `~/.pi/agent/`. Retired/candidate lock leftovers are cleaned automatically and should not need manual deletion.

### Messages arrive but the agent output is not streamed
- Confirm pi has an active model and valid credentials: run `/model` and `/status` from Telegram.
- Confirm this local process is the Telegram owner (`telegram+ connected(current)` / `active(current)` in the TUI). Standby instances deliberately suppress outbound assistant/tool/UI/`tg_attach` traffic.
- If a `/tg-switch` just completed, wait until the history-replay banner finishes (`History replay complete`) before expecting new streamed output; outbound sends are gated until replay ends.
- If `tool` / `thinking` rendering is set to `hidden`, output may look silent. Run `/tg-config tool brief` and `/tg-config thinking brief` to surface activity (these levels also control what history replay includes).
- Long single messages may exceed Telegram's 4096-byte limit; the extension splits them automatically, but if delivery still fails, check your network and the pi log for upstream API errors.

### `/tg-switch` fails or history replay looks wrong
- `/tg-switch` only works on the currently active instance. If you see `This pi instance is not the active Telegram instance`, switch from the owner process or wait for failover.
- The selector only lists processes that are still heartbeating. Restart the missing pi if it does not appear.
- Replay targets the new owner's current session branch and the chat/topic where the switch was requested. Empty sessions produce a banner with `0 messages` and no body replay.
- A failed replay posts `History replay failed` in Telegram and still completes the handoff so the new owner can accept fresh messages; check the pi log for details.

### Interactive dialogs (Select / Confirm / Input / Editor) do not appear
- Inline keyboards require a recent Telegram client; update your Telegram app.
- Inline keyboards are removed once the pending dialog resolves or is cancelled (e.g. via `/stop` or timeout). Re-trigger the action to get a fresh keyboard.
- For third-party `custom()` dialogs (pi-goal), ensure the producing extension is loaded (`/reload`) and that the component exposes the expected `handleInput`/`render` API. Unknown shapes are auto-dismissed as `cancelled`.

### `/tg-global-*` or `/tg-bind-cwd` commands are missing
- The extension must be registered as a pi package. Re-run `pi install npm:pi-telegram-plus` (or `pi packages add .` from source) and restart pi.
- Run `/reload` to refresh command registration without a full restart.

### File attachments fail to send or are rejected
- Outbound `tg_attach` blocks sensitive paths (`/etc`, `~/.ssh`, etc.). Move the file to a non-sensitive location and retry.
- Default upload size limit is 50 MB. Files exceeding it are rejected; reduce the file size or split the content.
- For download failures (Telegram → working directory), check that the working directory is writable and that the filename was sanitized correctly. Saved paths are reported back in the chat.

### Polling reconnects repeatedly or reports transient failures
- The extension uses exponential backoff on transient errors. If failures persist, verify network reachability to `api.telegram.org` and that the bot token has not been revoked in BotFather.
- A revoked/regenerated token will keep failing until you re-run `/tg-global-setup` with the new token.

### Configuration changes are not picked up
- Per-workspace bindings live in `~/.pi/agent/tg.json`. After editing by hand, run `/reload` (or restart pi) so the extension re-reads config.
- Workspace bindings override the global token. If the wrong bot responds, run `/tg-list` and `/tg-unbind-cwd` to clear the unintended override.
