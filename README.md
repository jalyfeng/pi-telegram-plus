# pi-telegram-plus

<p>
  <a href="https://www.npmjs.com/package/pi-telegram-plus"><img src="https://img.shields.io/npm/v/pi-telegram-plus?style=flat-square&logo=npm" alt="npm" /></a>
  <a href="https://github.com/jalyfeng/pi-telegram-plus"><img src="https://img.shields.io/github/license/jalyfeng/pi-telegram-plus?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19.0-339933?style=flat-square&logo=node.js" alt="node" />
</p>

**Full Telegram control of [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — commands, interactive UI, model/session management, file transfer, and real-time streaming output, all from Telegram.**

`pi-telegram-plus` is a pi extension that turns Telegram into a full-featured remote control surface for the pi coding agent. It's not just a notification bot — it mirrors the core pi TUI experience into Telegram, with interactive menus, inline keyboards, file attachments, and live agent output rendering.

---

## Features

### 🤖 Bot Connectivity
- **Long polling** — receives messages and callback queries in real time
- **Multi-instance safe** — file-based polling lock prevents multiple pi instances from racing on the same bot token
- **Automatic reconnection** — exponential backoff on transient failures
- **Bot command menu sync** — automatically syncs available commands to Telegram's BotMenu (up to 100 commands)

### 🎮 Full Session Control
All pi session lifecycle commands available via Telegram:

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

### 🧠 Model & Authentication Management
- `/model` — View available models / switch current model via interactive selection
- `/scoped-models` — Toggle scoped model sets
- `/thinking` — Adjust thinking level (off/minimal/low/medium/high/xhigh)
- `/login` — OAuth or API key authentication with full interactive flow
- `/logout` — Remove stored credentials

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

### 🧩 第三方对话框支持 / Third-party Dialog Support

Third-party extensions that use `ctx.ui.custom(factory)` (such as [`@capyup/pi-goal`](https://www.npmjs.com/package/@capyup/pi-goal))
are bridged to Telegram inline buttons so remote turns can interact with them:

| Scenario | Telegram behavior |
|----------|-------------------|
| **pi-goal draft confirmation** (`propose_goal_draft` → `showProposalDialog`) | Shows ✅ Confirm / 💬 Continue chatting buttons. Confirm creates the goal; Continue lets the agent keep refining; `/stop` or timeout cancels. |
| **pi-goal `goal_question`** (single question) | Shows the question text, option buttons (paginated if needed), a ✏️ Type answer button for free-text entry, and Cancel. Selecting an option or typing an answer resolves the question. |
| **pi-goal `goal_questionnaire`** (multi-question) | Not fully supported yet — degrades to `cancelled: true` with a notification. The agent will ask questions one by one in chat instead. |
| **Unknown `custom()` components** | Auto-dismissed with a ⚠️ notification and a `cancelled` result, so the agent continues gracefully (never hangs or throws). |

**Telegram turns do not affect the local TUI.** Interactive modals (confirm, select, input, editor, custom) go to Telegram only — the TUI never shows a modal or loses keyboard focus from a remote turn. Persistent/stateful UI (goal widget, status line, working indicator, footer/header) is forwarded to the TUI base so the local TUI always shows accurate state. Editor operations (paste, set/get text) are no-ops during Telegram turns, so a remote turn never touches the local editor.

### 🎨 Message Rendering
- **Markdown → Telegram HTML** — Full conversion via `marked` (tables, code blocks, blockquotes, lists, inline formatting)
- **Tool execution rendering** — Configurable level (`hidden` / `brief` / `full`) for tool call visibility
- **Thinking rendering** — Configurable level (`hidden` / `brief` / `full`) for agent thinking blocks
- **Output splitting** — Safe UTF-8-aware splitting at Telegram's 4096-byte limit
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

### ⚙️ Telegram-Specific Commands

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

**Shared:**

| Command | Description |
|---------|-------------|
| `/tg-config` | Configure rendering levels and message mode |

### 🔧 Utility Commands

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

## Installation

### Prerequisites

- Node.js >= 22.19.0
- [pi coding agent](https://github.com/earendil-works/pi-coding-agent) installed globally
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Installation

**Install via npm (recommended):**

```bash
pi install npm:pi-telegram-plus
```

**Or install from source:**

```bash
git clone https://github.com/jalyfeng/pi-telegram-plus.git
cd pi-telegram-plus
npm install
pi packages add .
```

Then start pi and configure your bot:

```bash
pi
```

Inside pi, run:

```
/tg-global-setup
```

Paste your bot token when prompted. The bot will connect automatically.

> **Note:** On first message from any user, pi-telegram-plus automatically authorizes that user ID. Only that user can control the bot afterward.

---

## Configuration

### Per-Workspace Bot Tokens

You can bind different bot tokens to different directories:

```
/tg-bind-cwd /path/to/project
```

This creates a workspace-specific binding in `~/.pi/agent/tg.json`. Workspace bindings take priority over the global configuration. After binding, use `/tg-cwd-connect` / `/tg-cwd-disconnect` to control it and `/tg-unbind-cwd` to remove it.

### Rendering & Mode Settings

Via interactive menu:

```
/tg-config
```

Or directly:

```
/tg-config tool brief       # Tool rendering: hidden | brief | full
/tg-config thinking full    # Thinking rendering: hidden | brief | full
/tg-config mode steer       # Message mode: queue | steer
/tg-config retry 3          # API retry count: 0-10
```

---

## How It Works

```
┌─────────────────┐     Long Polling      ┌──────────────────────┐
│   Telegram Bot   │ ◄──────────────────► │  pi-telegram-plus    │
│  (api.telegram)  │     Callback Queries  │  (pi extension)      │
└─────────────────┘                       │                      │
        ▲                                 │  ┌────────────────┐  │
        │ Messages / Files                │  │  Controller     │  │
        │                                 │  │  ├─ handleMsg   │  │
  ┌─────────┐                            │  │  ├─ handleCB    │  │
  │  User    │                            │  │  └─ runPrompt   │  │
  │ (Telegram)│                           │  │                  │  │
  └─────────┘                            │  │  ┌─────────────┐ │  │
        ▲                                │  │  │ TelegramUI  │ │  │
        │ Streaming Output               │  │  │ (interactive)│ │  │
        │ Live Tool/Thinking Events      │  │  └─────────────┘ │  │
        │ File Attachments (tg_attach)   │  │                  │  │
        └───────────────────────────────────┤  ┌─────────────┐ │  │
                                          │  │  Renderer    │ │  │
                                          │  │  (Markdown→  │ │  │
                                          │  │   Telegram   │ │  │
                                          │  │   HTML)      │ │  │
                                          │  └─────────────┘ │  │
                                          │         │         │  │
                                          │         ▼         │  │
                                          │  ┌─────────────┐  │  │
                                          │  │ pi Agent    │  │  │
                                          │  │ (session,   │  │  │
                                          │  │ models,     │  │  │
                                          │  │ tools, ...) │  │  │
                                          │  └─────────────┘  │  │
                                          └──────────────────────┘
```

### Architecture Overview

- **`index.ts`** — Extension entry point. Wires all modules together and handles `session_start`/`session_shutdown` lifecycle events.
- **`lib/telegram-api.ts`** — Raw Telegram Bot API client with retry logic and file upload/download.
- **`lib/polling.ts`** — Long polling loop with multi-instance file lock. Re-reads config while holding the lock to prevent offset regressions.
- **`lib/controller.ts`** — Message routing: slash commands, text prompts, media attachments, callback queries.
- **`lib/telegram-ui.ts`** — Interactive UI layer: notify, confirm, input, select (pagination), editor, and a `custom()` bridge. Selectively forwards persistent/stateful UI to the TUI base so remote turns never disrupt the local TUI.
- **`lib/custom-dialogs.ts`** — Bridges third-party `ctx.ui.custom(factory)` dialogs (e.g. pi-goal `propose_goal_draft`, `goal_question`) to Telegram inline buttons via render-text shape detection, with a safe `cancelled` fallback for unknown shapes.
- **`lib/renderer.ts`** — Hooks into agent lifecycle events (`agent_start`, `tool_execution_*`, `message_end`) and streams rendered output to Telegram.
- **`lib/markdown.ts`** — Custom `marked` renderer that converts Markdown to Telegram-compatible HTML.
- **`lib/config.ts`** — Configuration persistence with file locking for concurrent-safe writes. Supports global + workspace scopes.
- **`lib/attachments.ts`** — `tg_attach` tool registration and outbound attachment delivery.
- **`lib/commands/`** — Command handler modules: model, session, auth (login/logout), lifecycle, settings, tg-config, telegram-commands.
- **`lib/heartbeat.ts`** — Periodic typing indicator while processing.
- **`lib/status.ts`** — TUI status line integration showing connection state.
- **`lib/session-capture.ts`** — Monkeys patches `AgentSession.bindExtensions` to intercept session lifecycle and capture the active session reference.
- **`lib/menu-commands.ts`** — Builds and syncs the Telegram BotMenu command list.
- **`lib/callback-protocol.ts`** — Encodes/decodes inline button callback data.

---

## Project Structure

```
pi-telegram-plus/
├── index.ts                     # Extension entry point
├── pi-host.d.ts                 # Type augmentation for @earendil-works/pi-ai
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .pi/
│   └── settings.json            # pi package registration
└── lib/
    ├── types.ts                 # All TypeScript interfaces & types
    ├── telegram-api.ts          # Telegram Bot HTTP API client
    ├── polling.ts               # Long polling with multi-instance lock
    ├── controller.ts            # Message router & prompt executor
    ├── telegram-ui.ts           # Interactive UI (notify, confirm, input, select, editor, custom bridge)
    ├── custom-dialogs.ts        # Bridge third-party custom() dialogs to Telegram buttons
    ├── renderer.ts              # Agent event → Telegram output renderer
    ├── markdown.ts              # Markdown → Telegram HTML converter
    ├── html.ts                  # HTML escaping utilities
    ├── text-split.ts            # UTF-8-safe text splitter for 4096 byte limit
    ├── command-parser.ts        # Slash command parser & bot-username normalizer
    ├── config.ts                # Configuration store (global + workspace scopes)
    ├── attachments.ts           # Outbound file attachment tool (tg_attach)
    ├── heartbeat.ts             # Typing indicator pulse
    ├── status.ts                # TUI status line formatter
    ├── session-capture.ts       # Agent session capture & handler patching
    ├── menu-commands.ts         # Telegram BotMenu sync
    ├── callback-protocol.ts     # UI callback encoding/decoding
    ├── commands/
    │   ├── register.ts          # Command registry aggregator
    │   ├── model.ts             # /model, /scoped-models, /thinking
    │   ├── session.ts           # /new, /fork, /clone, /tree, /resume, /cd, /cwd, /name, /session
    │   ├── auth.ts              # /login (OAuth + API key), /logout
    │   ├── info.ts              # /copy, /export, /import, /share, /status, /changelog, /hotkeys, /debug
    │   ├── lifecycle.ts         # /compact, /reload, /stop, /quit
    │   ├── settings.ts          # /settings menu
    │   ├── tg-config.ts         # /tg-config
    │   └── telegram-commands.ts # /tg-global-*, /tg-bind-cwd, /tg-cwd-*, /tg-unbind-cwd, /tg-list
    └── __tests__/
        ├── attachments.test.ts
        ├── callback-protocol.test.ts
        ├── config.test.ts
        ├── controller.test.ts
        ├── html.test.ts
        ├── info-status.test.ts
        ├── markdown.test.ts
        ├── renderer-helpers.test.ts
        ├── status.test.ts
        ├── telegram-api.test.ts
        ├── telegram-ui-custom.test.ts
        └── text-split.test.ts
```

---

## Development

```bash
# Type checking
npm run typecheck

# Run tests
npm test

# Watch mode
npm run test:watch
```

---

## Security

- **No secrets in source code** — All bot tokens and API keys are read from `~/.pi/agent/tg.json` and `~/.pi/agent/auth.json` at runtime.
- **File permissions** — Configuration files are created with `chmod 600` (owner-only access).
- **Sensitive input protection** — API key inputs use `inputSecret` which automatically deletes the user's message after reading.
- **Attachment path safety** — Outbound `tg_attach` blocks sensitive paths (`/etc`, `~/.ssh`, etc.).
- **Polling lock** — File-based lock prevents multiple pi instances from polling the same bot token simultaneously.
- **First-user authorization** — The first Telegram user to message the bot is automatically authorized; subsequent users are rejected.

---

## License

MIT
