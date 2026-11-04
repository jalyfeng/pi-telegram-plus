# Changelog

Notable changes to `pi-telegram-plus`. Versions follow the published npm releases;
dates are the publish dates from the npm registry.

This file is a user-facing summary: what changed, and what it means for you. Design
rationale and investigation detail live in the linked docs and in the commit messages,
which are written to stand on their own. Generate a starting draft for a new release with
`npm run changelog:draft`.

Write entries under `## [Unreleased]` as you go. Releasing moves that section under the
new version number automatically — `npm run changelog:roll` locally, or as part of the
publish workflow — and re-points the `[Unreleased]` link. `npm run changelog:check` fails
if this file does not describe the version in `package.json`, so a release whose notes are
missing or mislabelled cannot be published.

## [Unreleased]

### Changed

- **`/tree` and `/copy` are terminal-only.** Neither is available from Telegram on pi or OMP: they are left out of
  the `/` menu and `/tg`, and sending one from Telegram returns a hint. The plugin's own `/copy` is removed.
- **Confirms offer Yes and No only.** The Telegram confirm has no separate Cancel button, and a picker's extra
  confirm button is gone, because tapping the highlighted row already does the same.
- **The bot menu matches `/tg`.** It lists every command the plugin serves, the same set as `/tg` → Commands,
  with the 100-entry cap and the overflow behind `/more`.

### Fixed

- **`/tg` runs on one menu message.** Add, update and remove a bot, configure, and disconnect all stay on the
  menu message. Update asks which field to change with four buttons. An invalid value is explained in the
  prompt, which asks again. A renamed bot shows its new name, and a bot's username is shown even when it was
  not saved at registration. Names are escaped once, so `&` and `<` show correctly. Notices carry no
  `*info*` label; warnings and errors keep their emoji. Disconnect's answer stays on the menu, which ends there.
  The plugin's own secret prompts are marked as secret input.
- **Command replies quote the message that started them.** A `/force`, `/loop` or `/goal` reply quotes the
  Telegram message that started it, and `Loop limit reached` reaches Telegram. Replies to a prompt typed in
  the terminal quote nothing.
- **OMP dialogs match the terminal.** Settings submenus, including ones opened in the terminal, appear in
  Telegram, and settings warnings show their mark. Settings search lists the matching tabs with their counts.
  A tab, scope or row's active marker is not written into the closing summary. Pickers show the preview text of
  the highlighted item (model facts, role chips), and `/resume` shows its title and the pin on pinned sessions.
  Panel text keeps stacked columns apart and drops bare meters (`/session`). The prompt title and the input
  placeholder show as plain text. The OAuth paste code is secret input. The `/mcp add` name step shows its
  input rule. `/cleanse` shows its prompt title.
- **Questionnaires and inputs end with their answers.** A submitted questionnaire lists each question's answer.
  A typed answer to `ask` is written as the answer text; a plain input keeps "Sent an answer", and secret input
  stays hidden. A list closed in the terminal after a Telegram answer keeps that answer and adds
  "Answered in the terminal".
- **Dialog notices stay tidy.** The "A dialog is waiting" notice is removed when its dialog closes. A Telegram
  command's notices no longer print in the terminal. The terminal input no longer keeps the Telegram command's
  text: your draft comes back as soon as the command is taken.
- **Tools.** In full mode, `write` shows one message per call, and read, write and edit results no longer
  show OMP's `[path#TAG]` reference lines. A `task` call names its agents, and a background task's completion
  appears in the turn. `wait` with nothing to wait for says so.
- **`/status`** shows a numeric queued count (no `undefined`) and context as `used / total (percent)`.
- **`/restart` and `/quit` report their result.** `/restart`'s result survives the process replacement, and
  `/quit` writes its answer and a stopped line before exiting.

## [0.0.13] — 2026-11-04

Telegram now behaves like the host's own terminal: host commands run in the host, host dialogs appear in
the chat as buttons, and either side can answer them. This release drops a large amount of plugin-side
reimplementation and several settings, so read **Breaking changes** before upgrading.

### Breaking changes

- **Only pi `1.4.0` and OMP `18.14.x` are supported.** On any other version, or when the version cannot be
  read, the extension refuses to start, shows the reason in the status line, and answers Telegram
  messages with it. The multi-version compatibility matrix (`test:pi-versions`, `compat:gen`,
  `compat:check`, `docs/compat-results.json`) is gone.
- **The supported OMP version changed from `18.12.x` to `18.14.x`.** An OMP `18.12.x` install is refused at
  startup with the same explicit message; upgrade OMP to `18.14.x` to use the plugin.
- **The `tuiBridge` setting is removed.** There is one mode: the host draws its own dialogs and the plugin
  brings them to Telegram. An old `tuiBridge` value in a config file is ignored with a warning.
- **The flat `/tg-*` commands are removed.** Everything lives in the `/tg` menu; typing an old `/tg-*`
  command gets a pointer to `/tg`.
- **The plugin no longer reimplements host commands.** `/model`, `/scoped-models`, `/settings`, `/login`,
  `/logout`, `/session`, `/name`, `/resume`, `/tree`, `/fork`, `/clone`, `/compact`, `/export`, `/share`,
  `/changelog` and every other host command are submitted to the host and run there; their pickers and
  prompts reach Telegram as described under **Added**.
- **`/debug` belongs to the host.** The plugin's own debug report moved to `/tg` → 🛠 Debug info.
- **All plugin text is in English** (buttons, menus, notices, dialog titles).
- **Local terminal commands are no longer mirrored to Telegram.** A `/` or `!` command typed in the
  terminal stays in the terminal; the plugin no longer sends the command text or a screen snapshot to the
  chat. Dialogs follow the same rule: only what Telegram started is shown in Telegram.
- **`@capyup/pi-goal` dialogs are no longer supported in Telegram.** They expose no structured data, and the
  plugin no longer reads rendered screen text; they get the "answer it in the terminal" notice.
- **`/tg` menu layout.** Bots: ➕ Add bot, Bot list (Update / Pairing / Remove per bot), ⭐ Default bot.
  Project: the bound bot and the real connection state (🟢 Connected, 🔄 Connecting, 🟡 In use by another
  instance, ⚪ Disconnected) instead of `Enabled: ● on / ○ off`.

### Added

- **One command, one message.** A command sent from Telegram gets a single reply message that is edited in
  place: the dialog it opens (buttons), progress, and the final result all appear on it, and the keyboard
  is removed when it finishes. Long output is paged inside that message (◀ / ▶) instead of being sent as
  many messages. `✓ Done` appears only when there is nothing else to show.
- **Command text shown as text.** OMP text panels (`/session`, `/changelog`, `/hotkeys`, `/jobs`, `/usage`,
  reports such as `/mcp`) and pi's chat-area output (`/session`, `/hotkeys`, `/changelog`, `/debug`) reach
  the chat as text with the panel's own buttons, read from the host's structured data, never from the
  rendered screen.
- **OMP dialogs carry the text the terminal shows** (#18): list subtitles, per-item details and badges
  (for example a provider's "Not configured", an agent's description, a model's `[free]`), empty-list
  notices and search hints; `/settings` section names, section descriptions and row hints; the `/mcp add`
  wizard's step bar and step title.
- **Row actions in OMP pickers pick their row first** (#18): `/resume` → Delete (also Rename, Pin, Unpin)
  asks which session it applies to, then shows the host's own confirmation (`Delete` / `Cancel`) on the same
  message, exactly like moving the highlight and pressing the key in the terminal.
- **`!` / `!!` results show the exit status** (`exit N`) or `cancelled` when the command did not succeed.
- **Message mode is back in `/tg` → Config** (📨 Message mode). `steer` (default) injects your message into the
  running main turn; `queue` sends it as a follow-up after the turn ends. The choice applies to the next
  message and is saved per project. Only these two values exist; an invalid `messageMode` in a config file is
  an error, not ignored. While background agents run with the main loop idle, messages are still held and
  delivered as a fresh main-thread turn in either mode.
- **Host dialogs in Telegram.** A dialog raised by a command or turn started from Telegram is drawn by the
  host in the terminal and shown in the chat at the same time; whoever answers first wins, and the other
  side's dialog or keyboard is withdrawn.
  - Extension `select` / `confirm` / `input` (both hosts) and OMP's `editor`, `ask` tool and tool
    approvals are answered by handing the value straight to the waiting call and closing the host's copy
    through its cancel signal - no simulated keystrokes.
  - pi's built-in pickers (models, scoped models, sessions, session tree, fork/clone messages, settings
    with search and submenus, project trust, login providers) are read from the components' own fields.
  - OMP's built-in pickers and settings pages (including `/model`'s role assignment step) are read from
    the components' semantic description and answered with structured events.
  - OMP lists show their tabs, scopes and action bar as buttons (for example `/tree`'s Default / No tools /
    User only / Labeled / All filters and its Switch / Summarize / Label actions), and text sent to a
    searchable list becomes its search term. An empty list keeps these buttons, so a filter that hides
    every entry can still be switched.
  - Every OMP settings control can be changed from the chat: on/off and choice rows, numbers (a short
    range cycles, a long one opens an input), text (secret rows are masked), multi-select and action rows.
    Only key bindings stay in the terminal. While a search is active the page shows only the matches.
  - OMP's own text prompts, such as the API key field of `/login`, are answered from the chat; key-like
    fields are treated as secrets.
  - OMP's settings page takes a typed word as its search term, so the chat can start a search the way
    the terminal does ("Type to search").
  - A dialog the plugin cannot model gets a plain "answer it in the terminal" notice with one Cancel
    button; the plugin never mirrors screen text or guesses keys.
  - An open dialog follows late changes in the terminal (for example a list that loads after it opens).
- **`!` / `!!` shell commands run through the host**, so extensions that guard shell commands see them;
  the **Shell confirm** policy still applies, and the final output is sent once the command finishes.
- **`/export` sends the exported session file** back to the chat (HTML and JSONL).
- **`/quit` and `/exit` ask for confirmation** from Telegram; `/hotkeys` explains how to use the chat
  instead of listing terminal keys.
- **Pairing page** under `/tg` → Bots → Bot list → <bot> → Pairing: show the pairing code, issue a new
  one, or unpair.
- **OMP `/mcp add` wizard from Telegram.** Its choice steps (for example the transport) are picked from buttons,
  optional text steps have a Skip button, and the review step shows the summary with Save and Back.
- **`npm run test:e2e:state`**: does the same operation once in the terminal and once from Telegram on
  fresh hosts and checks that the resulting host state matches.

### Changed

- **Project disconnect sticks.** Disconnecting in `/tg` → Project is saved (also for projects that use the
  default bot) and survives restarts; the instance hands over to another pi instance immediately. You
  reconnect from the terminal with `/tg`.
- **Text sent while a dialog is open** goes to the dialog when it takes text (input fields, searchable
  lists); otherwise the chat is told a dialog is waiting instead of the text becoming a prompt. A new
  command from the same chat closes that chat's open dialog first.
- **E2E suites skip commands that reach external services** (`/share`, `/collab`, `/join`, `/leave`,
  `/update`, `/upgrade`).
- **`/tg` → Config → Thinking level is shown on OMP only.** pi has its own `/thinking` picker, which now
  reaches Telegram directly.
- **Commands are described as Telegram runs them.** The `/` menu and `/tg` drop host source tags such as `[t]`;
  `/copy`, `/hotkeys` and `/quit` describe what Telegram does, and the `/quit` prompt names the running host.
  Commands the running host does not have are left out of the menu. Terminal-only commands (`/local`, `/dump`,
  `/open`, `/stats`, `/trace`, `/record`, `/live`, `/git`) are left out too, and sending one from Telegram returns
  a hint. On OMP, `/cd` is not offered; typing it gets a hint to use `/move` (#28, #29).
- **Steer takes effect at once.** A Telegram message sent during a running turn is handed to the host without
  waiting for the turn to end, so `steer` (the default) steers the running turn immediately (#24). A message the
  host rejects is retried before the messages behind it.
- **Each tool call is one readable line.** The line names what the call works on (file, pattern, command or
  question) instead of showing raw JSON, and each call appears once. In full mode each tool call is one message:
  it is edited into its result, and an edit shows its diff.
- **`ask` questions are one message.** A recommended option is tagged `(Recommended)`, a typed answer goes into
  the host's own Other prompt, a single question has no progress line or switch button, and several questions show
  `Question 1 of 2 · answered: 0`. A question is not sent again while its first send is pending (#22).
- **`/settings` has one button per setting.** On pi, a two-valued setting is one button showing its current value,
  and submenu rows show their values. On OMP, the current page's rows come first on page 1, page switches are one
  compact block, and a choice with more than two options opens a submenu of its options (#23).
- **`!` / `!!` confirmation and result share one message.** The confirmation offers Yes and No only (`/stop` still
  cancels), and a refused command turns it into a cancelled notice.
- **Incoming files are saved in the project.** They go to `.pi/telegram-attachments/` in the session's working
  directory under their sanitized names; a repeated name gets ` (2)`, ` (3)` before the extension. The prompt
  lists each attachment once.
- **Switching instances stays on the `/tg` menu.** The switch result is written onto the menu message. Switching
  to an instance for the same project restarts nothing and announces no takeover; switch buttons show the project
  name and model.
- **Must-deliver replies survive a Telegram outage.** A final reply, or the closing edit of a finished dialog, that
  still cannot be sent after retries is kept (up to 30 minutes and 200 messages) and sent in order once Telegram
  answers again. A queued closing edit is sent as plain text, without its buttons.

### Fixed

- **Secrets are masked everywhere the plugin sends text**: dialog text and buttons, command output,
  assistant replies (including code blocks sent as files and Rich Messages), tool hints and plugin
  notices. Masking runs before HTML conversion, so keys containing `&`, `<` or `>` are caught. Secrets
  typed into the plugin's own secret prompts are tracked too, and everything is forgotten when a new
  session starts.
- **Commands that replace the session are not run twice.** The Telegram update cursor is saved before a
  command is handed to the host.
- **`/new` and `/reload` report their result.** Both replace the plugin's runtime, which discards any
  message the old one still had queued; the result now travels to the new runtime and is sent from there.
- **OMP `/clear` and `/delete` report their result** instead of an empty reply.
- **Telegram returns to the first page** when a dialog swaps in a different list (OMP model roles).
- **A settings page's sub-input behaves like a dialog of its own.** A value typed into OMP's secret
  settings row is deleted from the chat and masked like any other secret; a value the host refuses is
  reported instead of typed into the terminal behind the dialog, and the field stays open for a retry;
  a row whose change the host dropped no longer reports a successful press. Reopening the settings page
  starts on the rows instead of the input the previous visit left open.
- **Dialogs with many buttons are delivered.** Footer buttons wrap at three per row; Telegram rejects a row
  of more than eight, which used to make lists like OMP `/agents` never appear in the chat.
- **OMP sub-agents no longer reach Telegram or take the main connection down.** OMP re-runs the extension
  factory for every sub-agent session in the same process. The sub-agent's messages were forwarded to the
  chat, and the factory tore down the main session's Telegram runtime, so replies stopped arriving after a
  sub-agent ran. Sub-agent sessions are now inert, stop the timers their factory run started, and only the
  main session owns the runtime. (pi has no
  built-in sub-agents. A third-party extension that opens a nested session through the SDK would load the
  plugin again, and pi gives the plugin no way to tell that session apart; this is not handled.)
- **`/tg` and dialogs no longer fail with `Maximum call stack size exceeded` after a long session (#19).**
  The plugin re-wrapped host methods on every check: on OMP the dialog methods gained a layer every second
  (95 layers in 94 s), on pi every `/new` / `/reload` added one, and the next dialog call overflowed the
  stack. Every host method now carries at most one plugin wrapper; plugin features are stages on it, a
  reinstall only replaces the stage, and a third-party wrapper that captured ours can no longer loop back
  into it. Verified with a 12-minute OMP run and 20 pi runtime rebuilds: no new wrappers after start-up,
  depth 1 throughout, `/tg` still opens in the terminal.
- **Command replies no longer contain the agent's tool output (#20).** The plugin used to copy anything the
  host added to the terminal transcript while a command was open; now only what the command's own call
  chain produces is claimed, and agent turns and history redraws are excluded.
- **Dialogs that open slowly still reach the chat.** A dialog the host opens more than 1.5 s after the
  command (pi `/login`, OMP `/login` providers) is attributed to the command that opened it and drawn on
  its message, instead of being treated as a local dialog.
- **pi focus changes are seen immediately.** pi's `mode.ui` is a forwarding proxy, so the plugin's focus
  hooks never took effect and focus was only found by polling; a tap could land on a dialog that had
  already closed (for example selecting the wrong login method). The hooks now sit on the class that owns
  the methods, and every Telegram tap re-checks the live focus.
- **A dialog cancelled from Telegram says `✖ Cancelled`** instead of "Answered in the terminal".
- **`/scoped_models` from the Telegram menu runs pi's `/scoped-models`.**
- **A message rejected by Telegram is not re-sent repeatedly.** A parse error falls back to plain text once;
  only rate limits, server errors and network failures are retried.
- **OMP `/login` shows its sign-in dialog in Telegram.** The link, the instructions, the device code and
  the "Waiting for browser authentication…" status now appear for browser sign-ins, and the key prompt with
  the link appears for API-key providers such as DeepSeek, each with a Cancel button. The key you paste is
  passed to the host, never echoed back, and your message with it is deleted from the chat. Before, the
  dialog was filed under "progress" and never reached Telegram at all.
- **Telegram `!` commands always report their result, and no longer leave their text in the terminal's
  input box** (#17).
  - A `!` sent while the agent was replying ran in the host, but the host parks its output in the
    pending area until the next prompt, where the plugin did not look, so the result never reached
    Telegram. The plugin now picks it up there and sends it as soon as the command finishes.
  - A second `!` sent while the first was still running was refused by the host, and the first command's
    output ended up on the second command's message. Like the terminal, the plugin now refuses it up front
    with "A bash command is already running. Wait for it to finish, or send /stop to cancel it.", and the
    first command keeps its own result.
  - When the input box was empty before the command, the command text was left in it afterwards. The
    previous input is now restored either way; text you type while the command runs is kept.
- **`sendChatAction` honors a custom Bot API endpoint** (`apiBase` / `PI_TELEGRAM_API_BASE`). The typing
  indicator was always sent to the public endpoint. Thanks to BotoVed (#12).
- **`/stop` always stops the running turn.** It cancels the open dialog and pending input, stops a running `!`
  command, and aborts the agent turn, then replies with what it stopped. Cancelling a `/tg` submenu (Cancel,
  `/stop` or Esc) closes the whole menu; only Back goes one level up. Running a command from `/tg` → Commands
  closes the menu first, and the command's output gets its own message.
- **Provider retries show in one message.** While the host retries a failed request, the turn's status message
  shows `Retrying (n/max)`, then either `Recovered after n retries.` or a single final error. A cancelled retry
  says `⏹️ Retry cancelled.`, and the host's own "Retry failed" notice is not repeated. This works on pi and OMP.
- **Long replies break at line ends**, not in the middle of a line. Rich Messages no longer show escaped `&lt;`
  or `&amp;` inside code spans and fenced code blocks.
- **Replies quote the message they answer.** A message steered or queued into a running turn is the reply target
  for its own answer, not the turn's first message. A reply to a bot message, including a Rich Message with a table,
  gives the agent that message's text (#25).
- **A Telegram prompt sent right after a command** no longer draws its dialog on the finished command's message (#26).
- **OMP tool approvals offer every host choice.** `Approve <tool> for this session` and the other choices appear as
  buttons. A message sent while an approval waits denies that call and gives new instructions, as in the terminal.
- **Disconnecting Telegram no longer freezes OMP.** A dialog opened in the terminal while Telegram is disconnected
  used to resend itself in a loop that stopped OMP responding (#31). After an OMP sub-agent or side session has run,
  dialogs still reach Telegram (#32).
- **pi `/login` (OAuth) links are whole and tappable.** The sign-in link and its instructions are shown in full, the
  terminal key hints no longer appear, and the login-method step stays in the command's final message.
- **OMP panels are read in full.** Lists, meters and nested parts reach the chat as text: `/marketplace` shows its
  entries (or its empty-list hint), and `/context` shows each category with its share and the auto-compaction mark.
  A closed panel keeps its title and the page last shown. `/debug` shows its title once and its actions answer the
  dialog; `/context` entries can be opened; `/extensions` shows each row's status dot and category; disabled `/agents` rows stay listed
  and marked; `/collab`'s QR code is shown as its link; `/share`'s upload is a wait that Cancel stops, and Cancel says
  `✖ Cancelled`.
- **Pickers page and search like the terminal.** OMP pickers page by the rows left after filtering, a search gets a
  Clear search button, and Cancel clears the search before closing. pi's `/resume` searches, renames and deletes
  sessions from Telegram; its model, login and scoped-model pickers take a search, and `Set as default` works.
  Rename and delete are refused while the host is still loading a list, and the next tap retries.
- **Host-control commands send one message.** `/new`, `/reload`, `/import`, `/copy`, `/hotkeys`, `/quit` and `/exit`
  write their confirmation and result onto the `▶️ /<name>` message. OMP's `/btw`, `/omfg` and `/cleanse` results
  come back to the command message instead of showing only "Done".
- **`npm test` no longer opens a browser.** A pi login test opened the desktop browser on every run; the unit tests
  now block and record such launches.
- **Several smaller fixes.** OMP todo reminders appear, and a host warning that repeats a tool failure is dropped;
  `/tg` pages, bot details (without the token) and debug info stay on the menu message; OMP's agent picker can set
  a model override.
- Several dialog, focus and output-capture fixes found by the end-to-end suites on both hosts.

## [0.0.12] — 2026-10-19

### Fixed

- **A shared cursor that sat past the end of the bot's `update_id` stream could never
  recover, so polling permanently asked for updates that do not exist.** Every cursor write
  is a monotonic max, so a `lastUpdateId` seeded from an update-id sequence the bot no longer
  belongs to — a re-created bot, a token reused for another bot, or an intermediary that
  assigns its own ids — was unreachable from below. Observed live: the cursor held
  `636583913` while the bot's stream was at `541383987`, and every poll asked for
  `636583914`. Messages still arrived only because the endpoint in use ignores an
  out-of-range offset; the documented contract is to return nothing, so the same state
  silently drops every message on a strict Bot API server. Polling now treats a delivered
  update below the offset it asked for as proof the cursor is foreign, logs `poll cursor is
  ahead of the update stream; rewinding`, and rewinds both the shared cursor and the project
  binding to one below the delivered update before handling the batch. A second signal
  covers the server that answers out-of-range requests with nothing at all (the documented
  contract): once per start, polling asks for the unconfirmed backlog with `offset: 0`,
  which confirms nothing, and rewinds if that backlog sits below the stored cursor.
- **Every Telegram message answered "π session is not ready yet." under OMP
  (`@oh-my-pi/pi-coding-agent`).** OMP's `AgentSession` has no `bindExtensions()`, so the
  extension loaded with `session capture disabled` and never held a session to drive. A
  `/pair <code>` reply still succeeded — pairing resolves before a session is needed — which
  made the failure look like a pairing bug. Capture now falls back to OMP's process-global
  agent registry, which holds the live top-level session.
  See [compatibility.md](docs/compatibility.md#omp-oh-my-pi-pi-coding-agent).
- **Released versions were shipped with their notes still labelled `[Unreleased]`.**
  `0.0.11` was published with 42 lines of release notes sitting under `## [Unreleased]`, its
  `[Unreleased]` link still comparing from `v0.0.10`. The publish workflow bumped
  `package.json` and tagged a release, but nothing ever moved the notes into a version
  section, so the published tarball described a released version as unreleased. The release
  now rolls this file, and `npm run changelog:check` fails any release whose CHANGELOG does
  not describe the version being published.
- **`package-lock.json` stayed pinned to the previous release on `master`.** The bump job
  committed `package.json` alone, so the lockfile still read `0.0.10` while `package.json`
  read `0.0.11`. Both files are now committed together.

### Added

- **`npm run changelog:roll`** — moves `## [Unreleased]` under the current version with
  today's date, inserts a fresh `[Unreleased]`, and re-points the `[Unreleased]` link. With
  `--auto-draft` it first fills an empty `[Unreleased]` from the conventional commits since
  the last tag, so a release never waits on hand-written notes. Zero dependencies.
- **`npm run changelog:check`** — verifies the CHANGELOG describes the version in
  `package.json`, that every version section has a link reference, that no version repeats,
  and that the trailing provenance note matches the referenced tags.

### Notes

- `prepublishOnly` now also runs `npm run changelog:check`, and the publish workflow rolls
  the CHANGELOG in the same commit as the version bump, so the tag and the notes cannot
  disagree. The bump job checks out full history and tags, which the draft step requires.

## [0.0.11] — 2026-10-18

### Fixed

- **Attachments sent to a self-hosted Bot API server went to the wrong host.**
  `downloadTelegramFile` hardcoded `https://api.telegram.org/file/...` while every other
  call honoured `PI_TELEGRAM_API_BASE` / `config.apiBase`, so downloads failed and leaked
  the file path and bot token to an origin the operator had routed away from.
- **npm refused to co-install with pi `0.86.0`–`0.99.2`, `1.2.0` or `1.3.0`.** Those
  versions were never broken — the matrix passes on all of them — but gaps in the peer
  range made npm-native installs fail with `ERESOLVE`. The range is now
  `>=0.80.7 <1.4.0`. `pi install npm:pi-telegram-plus` was unaffected (no peer validation).
- **pi `0.85.0` is supported again.** It was carved out in `0.0.7` because its published
  tarball imports an undeclared `@earendil-works/pi-server`. That upstream defect is real,
  but the drift-proofing below means it no longer affects this extension.
  See [compatibility.md](docs/compatibility.md#pi-0850-the-pi-server-packaging-defect).

### Changed

- **pi `@earendil-works/pi-coding-agent` is no longer imported as a static value.** Every
  reference is now `import type` or a guarded `import()`, and the optional classes
  (`FooterComponent`, `AgentSession`, `SessionManager`) degrade to a logged no-op instead
  of failing extension load. This protects non-CLI consumers (bundlers, test harnesses)
  from upstream packaging and dependency drift — including the `pi-codemode` drift that
  breaks plain-Node imports of pi `1.0.1`–`1.1.0`. The pi CLI masked both defects anyway.
  See [compatibility.md](docs/compatibility.md#why-the-extension-survives-upstream-breakage).

### Added

- **`npm run test:e2e`** — isolated end-to-end acceptance: a real pi in `tmux` against a
  mock Telegram Bot API and mock OpenAI provider, asserting the full round trip (`getMe` →
  `getUpdates` → injected message → real pi turn → reply delivered) on five pi versions.
- **The pi version matrix covers 21 versions** (`0.80.7`–`1.3.0`), and the README
  compatibility table is now generated from recorded results instead of maintained by hand.
  See [compatibility.md](docs/compatibility.md#keeping-this-honest).

### Notes

- `prepublishOnly` (mirrored by the publish workflow) runs `npm test`, `npm run typecheck`
  and `npm run compat:check`, which fails a release if the table, the test scripts and the
  peer range disagree. The matrix and E2E run manually and are recorded with `--record`.

## [0.0.10] — 2026-10-15

### Added

- Bot registry with project-level `.pi` binding, replacing path-bound bot tokens
  (PR #11).
- `/tg` interactive menu: multi-level navigation, single-message editing in place,
  per-project `Enabled` and `Default` toggles with confirmation before a switch that
  would disconnect an unbound project.
- Markdown tables in Telegram are rendered as native Rich Messages.

### Fixed

- `/pair` now persists `allowedUserId` to the bot registry.
- `/tg-config` direct-set reuses the shared menu flows; `/tg-switch` is registered in
  the TUI again.
- The `Enabled` toggle persists correctly, and its display is binding-based.

## [0.0.9] — 2026-10-10

### Added

- Configurable Telegram Bot API base URL, for self-hosted Bot API servers.
- `main` message mode, guaranteeing main-thread delivery during background workflows
  (issue #10).
- pi `1.0.x`/`1.1.x` added to the compatibility matrix.

### Changed

- Messages and workflow rendering follow fixed TUI-parity behavior, with the earlier
  mode-based rendering removed.
- Release and publish merged into a single `workflow_dispatch` workflow, fixing
  auto-publish (the previous `GITHUB_TOKEN` tag push did not trigger a second workflow).

### Fixed

- `/thinking` no longer collides with pi `1.x`.
- Concurrent `tg.json` writes are survived, and session start never wipes the Telegram
  configuration.
- Spurious failover notice suppressed on a single-instance restart.

## [0.0.8] — 2026-10-09

- CI: added the npm publish and release workflows.

## [0.0.7] — 2026-10-09

### Fixed

- Compatibility validation made portable for Windows.
- Telegram UI routing preserved with pi `0.85` (PR #9).

## [0.0.6] — 2026-08-09

### Added

- Multi-instance Telegram management with failover and history replay (PR #8).

### Fixed

- Guarded concurrent lock acquisition against `ENOENT` during candidate directory
  cleanup.

## [0.0.5] — 2026-07-22

### Fixed

- pi `0.80` model and auth compatibility.

## [0.0.4] — 2026-07-16

### Fixed

- Telegram messages are delivered during goal runs.

## [0.0.3] — 2026-07-08

### Added

- File-based JSON Lines logging, replacing silent `catch` blocks.
- Third-party TUI dialogs bridged to Telegram without disrupting the local TUI,
  including command-enqueued goal dialogs and multi-question forms.
- Mobile-first Telegram rendering overhaul: consistent table styling across message
  splits, oversized tables sent as a single file attachment.
- Telegram commands split into global and workspace scopes.

### Fixed

- Interactive modals no longer forward to the TUI base, which had caused selections to
  stick.
- Keyboard-strip race eliminated; questionnaire single-select auto-advances.
- Plain-text retry and warning spam suppressed on network errors.

## [0.0.2] — 2026-06-10

### Added

- `/status` command with beautified HTML output, BotMenu sync, and handler tests.
- Telegram markdown rendering aligned with the TUI style.

## [0.0.1] — 2026-06-03

- Initial release: Telegram control of the pi coding agent, with command bridging,
  interactive UI, and streaming output.

[Unreleased]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.13...HEAD
[0.0.13]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/jalyfeng/pi-telegram-plus/compare/f2b97fa...v0.0.8
[0.0.7]: https://github.com/jalyfeng/pi-telegram-plus/compare/1ba0d32...f2b97fa
[0.0.6]: https://github.com/jalyfeng/pi-telegram-plus/compare/e084124...1ba0d32
[0.0.5]: https://github.com/jalyfeng/pi-telegram-plus/compare/e67b202...e084124
[0.0.4]: https://github.com/jalyfeng/pi-telegram-plus/compare/f5a510b...e67b202
[0.0.3]: https://github.com/jalyfeng/pi-telegram-plus/compare/f9410e7...f5a510b
[0.0.2]: https://github.com/jalyfeng/pi-telegram-plus/compare/fffc6f5...f9410e7
[0.0.1]: https://github.com/jalyfeng/pi-telegram-plus/tree/fffc6f5

<!--
     Versions linked by tag: v0.0.8, v0.0.9, v0.0.10, v0.0.11, v0.0.12, v0.0.13;
     versions without a tag are compared by commit SHA. The v0.0.1 tag points at
     the initial commit, whose package.json still read 0.1.0, so it is linked as
     a tree, not a range. The v0.0.8 tag (bb69f57) sits one commit past the
     0.0.8 release commit (f65e372). -->
