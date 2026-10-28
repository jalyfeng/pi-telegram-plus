# TUI parity refactor: task list for stages 3–5

This document breaks down stages 3, 4 and 5 of §6 of `docs/tui-parity-refactor-plan.md` (the "plan" below) into tasks. The plan says **what to build and why**; this document says **in what order to build it and when each task counts as done**. If the two conflict, the plan wins, and a decision record is appended to plan §9.

The breakdown for stage 2 will be added after stage 2 is finished.

---

## 0. Usage rules

1. **One task, one commit** (or a group of consecutive commits). After committing, tick the status column below and fill in the commit hash. Do not leave the changes of several tasks mixed in one uncommitted working tree.
2. **Work in numeric order.** Tasks whose "Depends on" column is empty may be done earlier.
3. **Every completion criterion of a task must be met** before starting the next task. The tests named in the criteria are the minimum.
4. **Do not do the items in the "Not included" field on the side.** They belong to other tasks.
5. When something is unclear in the documents, decide it yourself following the principles in plan §2, append one decision record at the end of plan §9, and continue. Stop and ask only in these three cases:
   - a principle in plan §2 would be violated;
   - the acceptance criteria of a stage, or the completion criteria of a task, would change;
   - an interface between modules would change (the type definitions and module responsibilities in plan §4).
6. **Checks every commit must pass** (see "General checks" below): `npm run typecheck` and `npm test` all green; the existing `tuiBridge: off` tests are not affected.
7. Report once at the end of each stage: the last commit hash, a point-by-point comparison of each task's completion criteria, and the new §9 decisions.

### General checks

- Every new adapter needs a real-component contract test (plan §7.1), placed in `lib/__tests__/tui-adapters.contract.test.ts` or a new file with the same prefix. For components that truly cannot be instantiated, test the field shape and state the reason in the test.
- New E2E assertions must check the **body text or the host state**, not only the ack.
- OMP dialogs whose fields cannot be read always go through a snapshot (plan §9 decision 18). **Do not** parse the rendered text to fake a list.

---

## Stage 3 breakdown (v6, 2026-10-25)

Stage 3 is split by dependency into 5 sub-stages, in a fixed order (decided by the user on 2026-10-25: split it, 3C OMP first). At the end of each sub-stage (and each checkpoint inside 3A), the controller reports to the user: the commit list, the acceptance result, and new decisions.

| Sub-stage | Content | Tasks included | Acceptance |
|---|---|---|---|
| 3A Cleanup and alignment | Delete old paths; align with pi 1.4.0 | See checkpoints below | Only the new architecture remains in the code; no E2E regression on pi 1.4.0 and OMP 18.12.x; the "to be migrated" list lists all existing gaps |
| 3B Extension dialogs | Extension UI race (select, confirm, input, editor, ask, approve); custom is explicitly reported, pi-goal takes exception 1 | S25 feasibility check and later tasks (replacing T3.2a–T3.2c) | The dialogs suite is all green on both hosts and goes through the race path; the matching items are removed from the list |
| 3C OMP built-in selectors | TSP adapter; delete the OMP screen-reading code; `/fork` and `/clone` handed to the host, selectors go through TSP (decision 52) | T3.2d–T3.2g | OMP's `/model`, `/settings`, `/login`, `/resume`, `/tree`, `/agents`, `/fork`, `/clone` show native lists in Telegram and can complete the operation, with results matching the terminal |
| 3D pi built-in selectors | Adapters that read fields (pi 1.4.0); `/fork` and `/clone` handed to the host, the selector uses the `UserMessageSelectorComponent` adapter, then the plugin's own message list is deleted (decision 52) | T3.3–T3.10, including the 1.4 additions `/thinking`, `/trust` | The same group of commands on pi (including `/fork`, `/clone`) reaches the same result |
| 3E Final acceptance | Verify output-only commands one by one; overall stage 3 acceptance | T3.2 (remainder), T3.12, T3.13 | Full E2E passes on both hosts; the stage 3 items in the list are cleared; outdated README text (`/tg-*`, `tuiBridge`, screen mirroring) is rewritten by the controller |

**3E to verify** (found by the controller reading the OMP source on 2026-10-25): approvals for OMP built-in tools (bash, etc.) call `ui.approve` through the tool's own UI object (`ToolContextStore`). The plugin currently routes only the `execute` of the `ask` tool to Telegram, so in a Telegram-initiated turn these approvals may not appear in Telegram. 3E confirms this with E2E; if true, open a separate task.

**3E acceptance record** (2026-10-25, controller ran E2E, Qwen fixed):

| Fix | Problem | Commit |
|---|---|---|
| F1 | OMP selectors/settings page with a `signal` field were classified as progress, so the broker did not create a session | `e35eb14` |
| F2 | The `!` command pushed a "Running…" frame, and the scope ended before the command finished | `d8024b0` |
| F3 | E2E still asserted on the deleted plugin paths (`/model`, `/scoped-models`, `/agents`, disconnecting a project, `!` output format, parity default clicking the first item) | `f0c11e9` |
| F4 | The pi settings page does not support search, so text became a prompt | `d6893ba` |
| F5 | The "purpose" option bar after selecting in the OMP model panel was not modeled | `d608010` |
| F6 | OMP bash component class names are minified, so identify by method; request a redraw after a TSP operation | `88e0ce6` |
| F7 | E2E: OMP purpose picks an unassigned item; the settings page compares the screen after every click | `a967ad7` |
| F8 | When a dialog is open and does not take text, plain text is not treated as a prompt (decision 54) | `7589384` |
| F9 | D2 regression: before handing a host command to the gateway, the chat's dialog was not closed first | `a4a2dbe` |

Final result: basic send/receive (pi, OMP), dialogs (both hosts), commands (pi 75/75, OMP 136/136), tui-bridge (both hosts) all pass; the to-be-migrated list is empty; unit tests 697/697, 0 skip.

Follow-up handling (2026-10-25): prompt wording unified, dialog content synced every second (R1 `f812ee1`); OMP built-in tool approval goes through `runner.getUIContext()`, and E2E has confirmed it can be answered in Telegram (R2 `9bdcf75`, R3 `370949f`, dialogs adds "tool approval answered from Telegram"). Remaining: the mock model's bare `PROBE_APPROVAL` codeword still matches the whole history, so it may trigger one extra approval in later steps of the same session (no step is affected at present).

**3E division of work** (user, 2026-10-25): the controller runs the full E2E, analyses each failure and writes the fix task briefs; **code changes are still done by Qwen**.

3A checkpoints (user 2026-10-25: 3A is still too big, split it again):

| Checkpoint | Content | Tasks |
|---|---|---|
| 3A-1 Only the new architecture ☑ | Delete `off`/`tuiBridge`; delete `/tg-*` (T4.10 brought forward); fix cross-chat notification mix-up in host mode | D1 (`6096014`), T4.10 (`86e3e81`), mix-up fix S26 (`c0b3f36`) — done 2026-10-25, unit tests 630/630, 0 skip; E2E deferred to 3E |
| 3A-2 Delete the old mirroring | Delete `runTuiCommand`, `tui-selector.ts`, the `tgplus:tui:` callback; the gateway takes over all host commands | D2 |
| 3A-3 Delete native implementations | Delete native implementations that redo host functions, and `custom-dialogs.ts`; explicitly report unrecognized dialogs; `!` commands are run by the host (decision 51) | D3, D3b, D4 |
| 3A-4 Align with pi 1.4.0 | Upgrade the dependency, fix 4 interface differences, update documentation references, delete the multi-version test matrix | A2 (A1 already done by the controller) |

**E2E strategy** (user 2026-10-25: "don't run e2e every time, it takes too long"; "run e2e after all of stage 3 is done, to reduce time cost"): tasks and checkpoints within stage 3 run only `npm run typecheck` + `npm test`; **after all of stage 3 is done, run the full E2E once in 3E**; when a feasibility check needs E2E as evidence, run only the minimal scope. The E2E parts of each sub-stage's and checkpoint's "Acceptance" are all deferred to the 3E check.


## v6 prerequisite: delete old paths and align with pi 1.4.0 (before the remaining stage 3 tasks)

Plan §0.1, decisions 46–50. The order is fixed: first delete the old paths (D1–D4), then align with pi 1.4.0 (A1–A2), then continue with the stage 3 migration tasks.

| # | Task | Depends on | Status | Commit |
|---|---|---|---|---|
| D0 | E2E "to be migrated" list mechanism | — | ☑ | `21f6592` |
| D1 | Delete the `off` mode and the `tuiBridge` config item; error at startup if the bridge is unavailable | D0 | ☑ | `6096014` (cross-chat mix-up case skipped, to be fixed in 3A-1) |
| D2 | Delete the old screen mirroring (`runTuiCommand`, `tui-selector.ts`, the `tgplus:tui:` callback) | D1 | ☑ | `07b5df6`; pi's `/debug` is now handled by the plugin (same-name conflict, undecided) |
| D3 | Delete the native implementations where the plugin redoes host functions (the matching part of `lib/commands/`, the matching native flows in `telegram-ui.ts`, `custom-dialogs.ts`) | D2 | ☑ | `857cd4a`; the model/auth compatibility layer in `pi-compat.ts` now has no callers and is folded into the A2 cleanup |
| D3b | `!`/`!!` commands run by the host, keeping the `bashConfirm` confirmation (decision 51) | D3 | ☑ | `e9a4d89`; bash output is intercepted by constructor name `BashExecutionComponent`; if the OMP compiled output renames it, it will not be intercepted, to be checked with E2E in 3E |
| D4 | `SnapshotAdapter` becomes `UnsupportedAdapter` (explicit notice + cancel) | D2 | ☑ | `5fc9d8b`; checkpoints 3A-2 and 3A-3 done |
| A1 | Upgrade the dev dependency to pi `1.4.0`; check the host interfaces the remaining code depends on against the 1.4.0 source, and output a "needs change" list | D1–D4 | ☑ (the check was done by the controller; the dependency upgrade is folded into A2) | 4 items need change: the capture patch point `initHooksAndCustomTools` was renamed; the entry now hooks `pushExtensionDialog`/`removeExtensionDialog`; the command catalog uses only `autocompleteProvider`; built-in commands add `/bug`, `/thinking`, `/trust` |
| A2 | Fix the pi-side code per the A1 list (the entry uses 1.4.0's dialog stack `pushExtensionDialog`/`removeExtensionDialog`, etc.); update the old pi version references in the plan; delete the multi-version test matrix | A1 | ☑ | `cecf115`; the matrix tool and the E2E multi-version loop are split into A3 |
| A3 | Delete the multi-version compatibility matrix tooling (`gen-compat-matrix.mjs`, `compat:*`, release-flow checks); E2E tests only pi 1.4.0 in `node_modules` | A2 | ☑ | `c3b893f`; the README compatibility section and `docs/compatibility.md` were rewritten, `compat-results.json` deleted |
| A4 | Check the host version at startup (pi `1.4.0`, OMP `18.12.x`); if it does not match or cannot be read, stop working and explain the reason in the status bar and in Telegram (§0.1 item 1) | A3 | ☑ | `2bd8469`; checkpoint 3A-4 done, **all of 3A done** (2026-10-25, unit tests 548/548, 0 skip) |

Completion criteria of every task: `npm run typecheck` and `npm test` all green; E2E may fail only on steps in the "to be migrated" list; tests related to deleted code are deleted or rewritten at the same time. The controller splits each task into a separate task brief for dispatch.

## Stage 3: lists, settings, login

Prerequisite: stage 2 is accepted. The OMP broker switch has been lifted (plan §9 decision 27 is void; `hostOwnsPrompts` applies equally to both hosts), so T3.0 is already done, see its completion record.

| # | Task | Depends on | Status | Commit |
|---|---|---|---|---|
| T3.0 | OMP dialog classification and reading (conditional task) | — | ☑ | `558d574` (version restriction) and earlier commits, see the completion record below |
| T3.1 | OMP read-only panel interception | T3.0 (if needed) | ☑ | Done by `4f0e87e`, `7e6a84f`, `4767c02`, `ceb40a5` (panel entry, `showCommandReport` interception) |
| T3.2 | OMP output-only commands connected to the Gateway | T3.1 | ☑ | From D2 `07b5df6`, all host commands go through the gateway |
| ~~T3.2a–c~~ | ~~OMP collab bridge~~: replaced by the 3B extension UI race (decision 53) | — | Void | |
| S25 | Feasibility check: extension UI race (both hosts) | 3A | ☑ | No commit (S25, S25b 2026-10-25: confirmed on both hosts; the pi confirm failure was traced to the test script's double Escape opening the Session Tree) |
| B0 | Test script: the pi agent settings used by E2E write `doubleEscapeAction: "none"`, so `clearDialog()` does not open the Session Tree | S25 | ☑ | `81a9dea` |
| B1 | Race core + `select` (both hosts): create the broker session from the call arguments, the first to answer wins, the other side is closed; components occupied by a race no longer get a session from the focus path | B0 | ☑ | `eb08ade`; the session is still opened by focus, buttons answer through the race handle on the entry (plan §4.12 steps 2–6) |
| B2 | Race: `confirm`, `input` (both hosts) | B1 | ☑ | `d9923f8` |
| B3a | Race: OMP's `editor`, `approve` (pi's `editor` does not accept a signal, no race) | B2 | ☑ | `71597ba` |
| B3b | Race: OMP's `askDialog` (the ask tool: the plugin assembles `{ kind: "submit", results }` from the Telegram choices, including custom answers) | B3a | ☑ | `5e7e5a6`; **3B coding done** (2026-10-25, unit tests 594/594, 0 skip), E2E in 3E |
| ~~B4~~ | ~~Delete the key path replaced by the race~~: folded into T3.2g. Dialogs without a race handle (host-internal confirmation boxes, pi's `editor`, built-in tool approval) still need the key path; only the screen-reading part on OMP is to be deleted | — | Folded into T3.2g | |
| T3.2d | OMP TSP adapter: read + operate (the base for built-in selectors and `custom`) | 3B | ☑ | `7d8369f`; picker first (`activate`/`close` events) |
| T3.2e | OMP TSP adapter: built-in selectors and dashboards (`/model`, `/settings`, `/login`, `/resume`, `/tree`, `/agents`) | T3.2d | Partial (later) | picker and prefs covered (T3.2d, T3.2e-1); the real description structure of the other selectors is checked with E2E in 3E, and a fix task is opened if there are gaps |
| T3.2e-1 | TSP: OMP settings page (prefs: change page, switch, choice); TSP does not take over dialogs that carry a race handle | T3.2d | ☑ | `3b40a58` |
| T3.2f | OMP TSP text input: verify the `edit` event (only for input boxes in built-in dialogs; the extension `input` already goes through the race) | T3.2d | Later | Needs the real description structure of a built-in input box on real OMP to design, checked together in 3E |
| T3.2g | Delete the screen reading and key injection code on OMP (exception 2; includes the former B4) | B3b, T3.2e, T3.2f | ☑ | `d3a3e56`; done early (does not depend on the remainder of T3.2e/f). OMP dialogs with no readable fields and no race handle no longer send keys by screen |
| C1 | `/fork` and `/clone` handed to the host (decision 52); the gateway saves message progress before submitting, to prevent repeated execution after the session is replaced | T3.2g | ☑ | `194fbc4` |
**3D re-split** (controller 2026-10-25, based on the pi 1.4.0 source and the parity audit `.tmp/parity-pi.json`; the old descriptions of T3.3–T3.10 below were written before v6 and contain obsolete approaches such as "fall back to snapshot" and "keep native /fork"; this table is authoritative):

| # | Task | Depends on | Status | Commit |
|---|---|---|---|---|
| P1 | pi built-in list selectors: `/model`, `/scoped-models`, `/login`/`/logout` providers, `/trust`, `/fork`/`/clone` message list (fields read by constructor name) | 3C | ☑ | `4eef2dd` |
| P2 | pi `/settings` (`SettingsList`: current value, toggle, submenu) | P1 | ☑ | `8230047` |
| P3 | pi `/resume` (`SessionSelectorComponent`) | P1 | ☑ | `2b2bd41`; after switching scope the list loads asynchronously, whether the broker redraws is left to the 3E check |
| P4 | pi `/tree` (`TreeSelectorComponent`) | P1 | ☑ | `9a964e3` |
| P5 | pi login dialog (`LoginDialog`: API key input handled as a secret) | P1 | ☑ | `0106164`; **3D coding done** (2026-10-25, unit tests 664/664, 0 skip) |

| T3.3 | pi `SelectListAdapter` | — | Replaced by P1–P5 | |
| T3.4 | pi `SettingsListAdapter` main list | T3.3 | Replaced by P2 | |
| T3.5 | pi `/settings` submenu | T3.4 | Replaced by P2 | |
| T3.6 | Generic `FilteredListAdapter`: search and paging | T3.3 | Replaced by P1–P4, F4 | |
| T3.7 | pi `/model`, `/scoped-models` | T3.6 | Replaced by P1 | |
| T3.8 | pi `/resume` | T3.6 | Replaced by P3 | |
| T3.9 | pi `/tree`, `/fork` | T3.6 | Replaced by P1, P4, C1 | |
| T3.10 | pi `/login`, `/logout` | T3.3 | Replaced by P1, P5 | |
| T3.11 | ~~OMP selectors go through snapshot~~ | — | Void | Plan §9 decision 34: screens whose fields cannot be read are handed back to screen mirroring; the broker creates no session and sends no fake keyboard |
| T3.12 | Switch all commands to the Gateway, delete the three command sets | T3.2–T3.11 | ☑ | Done by D2 (`07b5df6`) |
| T3.13 | Stage 3 acceptance | T3.12 | ☑ | See the "3E acceptance record" above |

### T3.0 OMP dialog classification and reading (conditional task)

- **Background (correction from the stage 2 closing retest)**: OMP's hook dialogs **do** switch focus. In `focusEvents` of `docs/host-probe/omp-18.12.5.json`, the `select`/`confirm`/`input` entry calls are immediately followed by `via:"setFocus"`, and the focused component is a container with only `children` (`QT`, `FD`, `Fy`); the `askDialog` component carries `callbacks`+`options` (`Ej`); an extension custom dialog is a plain object with `render`/`handleInput`. The earlier note that "`setFocus` is not called" came from a scenario sampled while the plugin bypassed the host gate and rendered by itself, and does not hold. The real gaps are two: ① OMP keeps row labels in private fields (the row component's own keys are empty), so every shape check in `classify` in `lib/tui/focus.ts` misses, and the constructor names are minified output, so the dialog is classified as `"progress"`; ② the existing adapters read entries from the `items`/`filtered*`/`selectedIndex` fields, which these components do not expose.
- **To do**:
  - Classification: a focused component bound to, or right next to, an **unfinished** entry is classified as `dialog`. On the pi side `EntrySpec.componentField` already binds the component directly (`FocusTracker.entryFor`); OMP's UI context entries have no component field, so associate them through the pending entry "after the entry call, before the Promise ends" (the probe's `recentEntries` is exactly this timing); in neither case rely on class names or shape guessing;
  - Reading: add a per-frame reading adapter that uses the color-stripped text of `render(80)` to parse the title, rows (`❯`/`>` marks the current row) and the footer keys; `conclusions.dialogFrames` records the real frame of each component shape, and components with `options`/`callbacks` such as `Ej` still read fields first;
  - Operating: keep using the key injection of `act()` (move up/down + `Enter`, cancel with `Esc`), without requiring the host to expose private fields;
  - Closing: the end of the entry call's Promise decides; focus returning to the editor serves only as a fallback signal that must last 1.5 seconds;
  - Lift the `hostOwnsPrompts` restriction for OMP. The broker uses the same switch (plan §9 decision 27), so once removed the broker is enabled on OMP as well.
- **Not an interface change**: plan §4.1.3 "identify dialogs by focus" stays; what changes is the criterion (shape → whether there is an entry), and under rule 5 a decision still has to be recorded in §9.
- **Completion criteria**: on OMP, extension `select/input` and `ask` multi-question answered from Telegram go through the broker dialect (`tgplus:dlg:`), and when the terminal answers first the Telegram keyboard is withdrawn; the OMP part of `npm run test:e2e:dialogs` is all green; after the OMP broker is enabled, `run-e2e-commands.mjs --host omp` must not fall below the stage 1 baseline of 132/132 (plan §9 decision 27).
- **Not included**: OMP built-in selectors (T3.11).

- **Completion record (OMP 18.12.5)**:
  - Classification: the entry in `lib/tui/entry.ts` lives until the host Promise ends (`entryCallDepth` detects nesting, thenable decides when to reclaim), and `FocusTracker` classifies as `dialog` whenever it sees an unfinished entry, no longer guessing class names and shapes; when focus is handed to an overlay container, the key target changes but the session does not (plan §9 decision 29).
  - Reading: `extensionSelectAdapter` reads the component fields first and, if they cannot be read, parses the `render(80)` frame (`frameRows` gives the rows, the highlighted row and the visible order); arrow-key step counts use the rows actually shown in the frame (decision 36); option strings are compared after stripping indentation and the current-value marker from both sides (decision 35).
  - Operating: still key injection through `act()`; `ask` produces a questionnaire model through the `omp-ask` adapter, and for multiple questions "next question/submit all" still produces buttons as usual.
  - Closing: the entry Promise ends, focus returns to the editor (250ms confirmation), or moves to another dialog; a progress panel grabbing focus does not count as closing (decision 30).
  - Keyboard validity: the generation increments only when "the buttons the user can press" change (decision 37), so moving the cursor in the terminal no longer invalidates the keyboard in the chat.
  - Command side: when a command opens a scope it closes any leftover unanswered dialog for the user (decision 31); in host mode the command context uses the routing UI, and commands that only send notifications return to the chat again (decision 38).
  - Acceptance: `npm run test:e2e:dialogs -- --host omp` all green (`DIALOGS_ACCEPTANCE=0`, covering select/confirm/input/secret/custom, `ask` single and multi question, terminal answering first withdraws the keyboard); `run-e2e-commands.mjs --host omp --phase main` 139/139 (`COMMANDS_ACCEPTANCE=0`), above the stage 1 baseline of 132.
  - Keyboard and redraw: a redraw failure no longer takes the keyboard away as a side effect (decision 39); `classify` checks loader/signal first and only then recognizes the entry, so a spinner panel does not take away the identity of the question (decision 40).
  - Test infrastructure: all five e2e suites now probe the mock Bot API / provider ports before starting and exit with an error if they are occupied. Previously an old host left behind by `--keep` kept polling the same ports, and the suite that ran later read the chat of the **previous host**, producing two rounds of false failures (`Bot not found: e2e-extra`, "This prompt is no longer active", and the `/copy` receipt showing the previous command); the default ports of `run-e2e-omp.mjs` also moved from 9950/9951 to 9980/9981, so they no longer collide with the commands suite. The command-step `dispatch` supports matching its own receipt by content, so cleanup notices such as "closed an unanswered dialog" are not mistaken for the command's reply.
  - Version restriction (`558d574`): per-frame reading is enabled only on OMP `18.12.x` (`OMP_FRAME_VERSIONS` in `lib/tui/adapters/utils.ts`, the version taken from `VERSION` of `@oh-my-pi/pi-utils`); on other versions, or when the version cannot be read, select/confirm fall back to snapshot and `approve` is not recognized; plan §4.6.6 exception 2.
  - Stability recheck (2026-10-24): `run-e2e-commands.mjs --host omp` ran 5 clean rounds in a row; the main phase passed in 4 rounds, and 1 round failed only on `settings mirror` (recorded in plan §10); `test:e2e:dialogs --host omp` 11/11.

### T3.1 OMP read-only panel interception

- **Files**: `lib/tui/adapters/panel.ts`, `lib/tui/output.ts`, and `lib/tui/entry.ts` if needed.
- **To do**: per plan §4.6.5 #12, identify OMP's `showCommandReport`, `showDebugSelector`, `showUsageDashboard`, `showExtensionsDashboard`, `showAgentsDashboard` by an entry-semantics whitelist; send the color-stripped, redacted `render(80)` as read-only body text to Telegram, with only a "Close" button (sends Esc).
- **Completion criteria**:
  - Unit test: build the call using the entry arguments recorded in `docs/host-probe/omp-18.12.5.json`, and assert it is recognized as an `info` model with only a "Close" button;
  - E2E (OMP): send `/status` and `/usage` from Telegram; the received messages contain the panel body (assert at least one field that always appears in the panel), and after clicking "Close" the terminal panel disappears.
- **Not included**: adding commands to the whitelist (T3.2).

### T3.2 OMP output-only commands connected to the Gateway

- **Files**: `lib/tui/gateway.ts` (OMP whitelist), the OMP table in plan §4.8.
- **To do**: add the 18 commands in the first row of the OMP table in plan §4.8 (`/help`, `/status`, `/usage`, `/stats`, `/context`, `/changelog`, `/debug`, `/skills`, `/plugins`, `/extensions`, `/tools`, `/agents`, `/mcp`, `/plan`, `/session`, `/jobs`, `/todo`, `/memory`) to OMP's Gateway whitelist.
- **Completion criteria**: E2E (OMP) asserts for each of these 18 commands: it does not enter `runTuiCommand` (the return is not the old mirroring keyboard), and the received body is non-empty and not only an ack. Any command that returns only an ack is removed from the whitelist, and the reason is recorded in §9.
- **Not included**: selector-type commands (T3.11).

### T3.2a–T3.2g OMP structured channel (plan §4.11 v5; the extension dialog part is replaced by the §4.12 race)

- See plan §4.11, §4.12 and decisions 41–45, 53 for the design. The controller splits each subtask into a separate task brief for dispatch, and the completion criteria are decided by E2E:
  - T3.2a–c: void, replaced by the 3B extension UI race (plan §4.12, decision 53). Acceptance of the 3B tasks (B0–B4): the select, confirm, input and ask steps of the dialogs suite pass on both hosts through the race path; when the terminal answers first the Telegram keyboard is withdrawn; locally initiated dialogs are not pushed to Telegram. E2E runs once in 3E per the stage 3 strategy.
  - T3.2d: `TspAdapter` unit tests cover the three conversions picker/card/read-only.
  - T3.2e: `/model` shows a native list in Telegram and can switch the model, with the result matching the terminal; the other built-in selectors can at least read out the list and select/close.
  - T3.2f: input completes text entry and submission through TSP, or prove the `edit` event is unavailable and keep the existing input path (record in §9).
  - T3.2g: the OMP path no longer calls `frameRows`/`frameCursor`/`parseLegend`; delete the "fall back to snapshot on version mismatch" code and replace it with the startup error of §4.11.4; the OMP dialogs and commands suites are all green.

### T3.3 pi `SelectListAdapter`

- **Files**: `lib/tui/adapters/` (new `select-list.ts`), registered in `adapters/index.ts`.
- **To do**: plan §4.6.5 #6. After `findShape(F, isSelectList)` hits, read `value/label/description` of `filteredItems` and `selectedIndex`; operate per plan §4.6.4: set `selectedIndex`, then send `\r` to `inputTargetOf(F)`.
- **Completion criteria**:
  - Contract test: using the real `ThemeSelectorComponent`, `ShowImagesSelectorComponent` and the thinking-level selector, assert that the options returned by `read()` match the full list of the component, the current-value marker is correct, and after `act()` the component callback receives the target value;
  - E2E (pi): from Telegram, send any command that uses a SelectList other than `/settings` (for example switching the thinking level); after clicking, the host state changes and matches the result of the terminal operation.
- **Not included**: search, paging (T3.6).

### T3.4 pi `SettingsListAdapter` main list

- **To do**: the main-list part of plan §4.6.5 #5: read `items`/`filteredItems`, `selectedIndex`, and each item's `currentValue`/`values`; for cycle, compute the key count as `(indexOf(target) − indexOf(current) + n) % n`; after the operation, read again to confirm `currentValue` has changed. When `currentValue` is not in `values`, return `false` and fall back to snapshot.
- **Completion criteria**:
  - Contract test: reading the main list of the real `SettingsSelectorComponent` (focus is `getSettingsList()`) and one cycle;
  - E2E (pi): change a cycle-type setting from Telegram; the matching field in the settings file matches the result of the terminal operation.
- **Not included**: submenu (T3.5).

### T3.5 pi `/settings` submenu

- **To do**: when `submenuComponent` is non-empty, run `findShape` on it to find the SelectList and produce `submenu.model`; operations are still sent to `F` (plan §4.6.5 #5). Submenus such as `ThemeSubmenu` that are not a SelectList degrade to a snapshot, providing only ↑↓/Enter/Esc.
- **Completion criteria**:
  - Unit test: open the submenu, select, return to the main list, all in the same broker session (not a new dialog), and Telegram reuses the same message;
  - E2E (pi): change a setting through the submenu, with the result matching the terminal; when entering the theme submenu, Telegram shows a snapshot and keys.
- **Not included**: none.

### T3.6 Generic `FilteredListAdapter`: search and paging

- **Files**: `lib/tui/adapters/` (new `filtered-list.ts`), `lib/tui/render-telegram.ts` (paging layout), the broker's text routing (search input).
- **To do**:
  - Plan §4.6.5 #7: the label is taken in order from `label ?? name ?? title ?? id ?? String(x)`; the current value is compared against the `current*` fields on the component;
  - Telegram paging: page the options when they exceed one screen; the callback data of the paging buttons must not exceed 64 bytes;
  - Search: when the user sends a piece of text, route it by the "search" type of plan §4.5.1, write the text into the component's search input, read the list again and redraw.
  - Use `registerExternalInput` to merge the two tables "plugin-native prompt waiting for text" and "mirroring/broker dialog waiting for text" into one (plan §9 decision 26): after merging, the single table's "latest flow first" gives the ordering, and the controller's `resolveInput` that precedes the broker's temporary ordering is deleted accordingly.
- **Completion criteria**:
  - Unit test: paging callback encoding ≤ 64 bytes; after a search the list is shorter; selecting an item on page 2, `act()` locates it correctly;
  - Contract test: at least one real component (for example the oauth provider list);
  - Unit test: when the same chat has both a plugin-native prompt and a mirrored dialog waiting for text, the answer goes to the latest flow, and each flow consumes it only once (plan §9 decision 26).
- **Not included**: model and session specific fields (T3.7, T3.8).

### T3.7 pi `/model`, `/scoped-models`

- **To do**: the `ModelSelectorAdapter` of plan §4.6.5 #8: options show `provider/id`, with the current model marked; the scope-toggle key is an extra button.
- **Completion criteria**: E2E (pi): from Telegram search for a model, page, and select; afterwards the host's current model matches the result of performing the same operation in the terminal; the current model is marked in the Telegram list; the file written by the `/scoped-models` check results matches the terminal.
- **Not included**: OMP model selector (T3.11).

### T3.8 pi `/resume`

- **To do**: `SessionSelectorAdapter`: the data is in the nested `sessionList` (`sessionList.filteredSessions`); show the session name or first message plus the time; delete, sort and filter by name are `extraActions`.
- **Completion criteria**: E2E (pi): prepare two sessions, send `/resume` from Telegram and select the earlier one; afterwards the session file shown by `/session` is that one; the delete operation asks for a second confirmation first.
- **Not included**: none.

### T3.9 pi `/tree`, `/fork`

- **Background**: `/fork` keeps the native handler (plan §9 decision 21); only the selector step is handed to the broker.
- **To do**: the message lists of `/tree` and `/fork` (focus `selector.getMessageList()`) go through `FilteredListAdapter` or a dedicated adapter; after `/fork` selects, the text the host writes into the editor is handled per plan §4.2.4: send it as a message to Telegram, then restore the local draft.
- **Completion criteria**:
  - E2E (pi): after `/fork` selects message N, the new session's message count matches the result of performing the same operation in the terminal; Telegram receives "the text placed in the editor"; the terminal's original draft is still there;
  - After a `/tree` jump, the current node matches the terminal.
- **Not included**: OMP's `/tree`, `/fork` (T3.11).

### T3.10 pi `/login`, `/logout`

- **To do**: the `LoginDialogAdapter` of plan §4.6.5 #9: input is always `secret: true`; **do not** screenshot the login dialog; delete the user's Telegram message immediately after they reply; register the original text in `SecretStore`. `/logout` goes through the provider selection list.
- **Completion criteria**:
  - E2E (pi): complete "choose API key login → enter key" from Telegram, and the provider appears in the auth file; throughout the process no message received by the mock Telegram (including edited messages) contains the plaintext key; the message in which the user sent the key has been deleted;
  - After `/logout` the provider is removed from the auth file.
- **Not included**: OMP login (T3.11).

### T3.11 OMP selectors go through snapshot

- **To do**: OMP's model/settings/session/tree/oauth/login selectors (the commands in the second row of the OMP table in plan §4.8) have no readable fields. `SnapshotAdapter` provides ↑↓/Enter/Esc and a "type text" button for all of them, with the title marked "Unsupported dialog"; **do not** parse the rendered text to fake a list (plan §9 decision 18).
- **Completion criteria**: E2E (OMP): from Telegram, switch the model in `/model` using keys and change one item in `/settings`, with results matching the terminal; the `/login` list can be selected with keys and can be cancelled.
- **Not included**: OMP field adapters.

### T3.12 Switch all commands to the Gateway, delete the three command sets

- **Files**: `lib/controller.ts`, `index.ts`.
- **To do**:
  - In `on` mode all host commands go through the dispatch order of plan §4.2.2 and no longer enter `runTuiCommand`;
  - Delete `TUI_NATIVE_SELECTOR_COMMANDS`, `MIRROR_FIRST_COMMANDS`, `HOST_CAPABILITY_COMMANDS` (`lib/controller.ts`), and check whether `TUI_VISIBLE_COMMANDS` in `index.ts` is still needed;
  - `off` mode keeps using the native implementations in `lib/commands/model.ts`, `session.ts`, `settings.ts`, `auth.ts` (plan §10: not cleaned up this time).
- **Completion criteria**: `grep` finds none of the three constants; the unit test for `on` mode asserts that no command enters `runTuiCommand`; the existing `off` mode tests are all green.
- **Not included**: deleting the mirroring code itself (T5.4).

### T3.13 Stage 3 acceptance

- Per the stage 3 acceptance criteria in plan §6, run a full E2E once on pi and once on OMP, and report the result of each item.
- If any item fails, go back to the corresponding task to fix it; do not fix it in this task.

---

## Stage 4: terminal-only commands and wrap-up

| # | Task | Depends on | Status | Commit |
|---|---|---|---|---|
| T4.1 | `/copy` | — | ☑ | `37d4467` |
| T4.2 | `/hotkeys` | — | ☑ | `37d4467` |
| T4.3 | Second confirmation for `/quit`, `/exit`, `/restart` | — | ☑ | `37d4467` (OMP 18.12.5 has no `/restart`) |
| T4.4 | OMP `/export` sends the file | — | ☑ | `470ebee` (both hosts, html and jsonl) |
| T4.5 | OMP confirmation-type and network-type commands | — | Partial | No new code needed; the `/cleanse` input box works. In an empty session `/delete` and `/clear` show no confirmation, so "the session is still there after clicking no" is unverified; network-type command E2E changed to skip (`b82cbbe`) |
| T4.6 | ~~Unknown custom component goes through snapshot~~ → explicit notice + cancel | — | ☑ | D4 `5fc9d8b`; E2E step `816f1b1` |
| T4.7 | Secret redaction covers the three send sources | — | ☑ | `ea0498a`, `d7f6c4e` |
| T4.8 | Project connect/disconnect: fix it not taking effect, and show the real state | — | ☑ | `82ce98f` (disconnect persistence), `982bec3` (show by running state, yield the active instance on disconnect) |
| T4.9 | Rework the `/tg` menu per Appendix M | T4.8 | ☑ | `049d8a0` (Bots submenu, global default Bot as its own item, pairing page); `⬅️ Back` kept in English |
| T4.10 | Delete the `/tg-*` commands, keep only the `/tg` entry | — | ☑ | Brought forward and done in 3A-1: `86e3e81` |
| T4.11 | Stage 4 acceptance | T4.1–T4.10 | ☑ | 2026-10-25: five E2E suites passed on both hosts; after the user asked for everything to be in English (EN1 `648e37f`, EN2 `fb0b58e`, EN3 `b82cbbe`) a rerun still passed everywhere |

**Stage 4 leftovers (handled, 2026-10-25)**: the empty OMP `/hub` list is the real state (no running sub-agents), and it now shows the host's empty-state description (L1 `3cb7f4d`); OMP 18.12.5's `/delete` and `/clear` have no confirmation box themselves (the T4.5 description in the task list was wrong), but because they "clear the chat area first and then attach the result", the result notice was treated as history rebuild and dropped; fixed (L2 `33dcc57`), and the extra blank line in the empty-output receipt was fixed too; OutputCapture gained debug logging for intercepted components. Previously, when running E2E, OMP `/share` once uploaded the test session to my.omp.sh (the content was only a mock conversation); it is now changed to skip.

**Text language** (user 2026-10-25): all text the plugin sends to users is changed to English; the plan and the task list under `docs/` stay in Chinese. (Superseded 2026-10-29: everything in the repository, `docs/` included, is written in English.)

### T4.1 `/copy`

- **To do**: plan §4.8: do not submit to the host; read the last assistant text in the session and send it directly as a Telegram message (handled the same way on pi and OMP; OMP does not open `showCopySelector`). When there is no assistant message, reply "Nothing to copy".
- **Completion criteria**: unit test: with and without an assistant message; E2E (once each on pi and OMP): the received text equals the original text of the last reply, and has been redacted by `SecretStore`.

### T4.2 `/hotkeys`

- **To do**: do not submit to the host; send the Telegram usage description generated by the plugin (including dialog buttons, sending text as input, `/stop`).
- **Completion criteria**: a unit test asserts that the description contains the three items above; the terminal does not open the hotkeys panel.

### T4.3 Second confirmation for `/quit`, `/exit`, `/restart`

- **To do**: Telegram first shows "✅ Confirm quit / Cancel", and only after confirmation is it submitted to the host; on cancel or timeout nothing is done. `/restart` exists only on OMP.
- **Completion criteria**: unit test: the three paths confirm, cancel, timeout; E2E (pi): the host process exits after confirmation, and is still there after cancel. The existing `quit`/`exit` E2E scenarios keep passing.

### T4.4 OMP `/export` sends the file

- **To do**: plan §9 decision 20: wait for the Promise of `exportToHtml` to resolve and send the resolved path as a document; record only when the scope label is `/export` (the temporary file inside `/share` must not be sent).
- **Completion criteria**: E2E (OMP): the received document's file name matches the export path, and the file exists; `/share` does not send a temporary file.

### T4.5 OMP confirmation-type and network-type commands

- **To do**: the two kinds of commands in the OMP table of plan §4.8:
  - Confirmation type (`/new`, `/fresh`, `/clear`, `/delete`, `/cleanse`, `/wt`, `/worktree`): the confirmation box is rendered as "Yes/No" per the `confirm` model;
  - Network type (`/share`, `/collab`, `/join`, `/leave`, `/hub`): submit directly and send the output back; those with a progress bar are shown per the `progress` model, changed to the finished state after completion and with the keyboard removed.
- **Completion criteria**: E2E (OMP): after clicking "No" on the `/delete` confirmation in Telegram the session is still there; the output body of `/share` is sent back to Telegram. For commands that need the network and cannot complete in the mock environment, assert only the rendering of the confirmation box or progress bar, and say so in the report.

### T4.6 Unknown custom component goes through snapshot

- **To do**: add a `custom()` component of unknown structure in `scripts/e2e/probe-extension.ts` (or a new test extension).
- **Completion criteria**: E2E (pi): trigger the component from Telegram and receive a snapshot (title "Unsupported dialog") and the ↑↓/Enter/Esc buttons; after clicking Esc the component closes and the extension receives a cancel result; the snapshot text has been redacted.

### T4.7 Secret redaction covers the three send sources

- **Background**: plan §4.7.4 requires replacement in the three send sources OutputCapture, Broker and `lib/renderer.ts` before conversion to HTML. Stage 2 may have done part of this already; this task checks and fills in the rest.
- **Completion criteria**: unit tests cover all cases of the "secrets" item in plan §7.1: all three sources are redacted; after replacing a secret containing `& < >` the HTML structure is intact; secrets shorter than 8 characters are not registered; cleared after `/new`; secrets entered during a Telegram turn also take effect. Existing tests are simply referenced, not rewritten.

### T4.8 Project connect/disconnect: fix it not taking effect, and show the real state

- **Background**: currently after toggling `/tg → Project → Enabled`, neither polling nor the status bar actually changes. Two causes have been verified:
  1. **When the project has no binding of its own and uses the global default Bot, "off" is undone immediately.** `disableProjectFlow` (`lib/commands/telegram-commands.ts`) first sets the in-memory config to `telegramEnabled: false`, then immediately re-reads the config with `switchResolvedConfig(readResolvedTelegramConfig(...))`; with no binding file, `materializeTelegramConfig` (`lib/config.ts`) always yields `telegramEnabled = true`. The re-read is on again, and the background `reconcileCoordinator`, which runs every 2 seconds, restarts polling right away. The menu shows `● on` again and the status bar does not change.
  2. **Startup forces it back on.** `enableConfiguredTelegramOnStartup` (`lib/config.ts`, called by the `index.ts` startup flow) forces `telegramEnabled` to `true` and writes it back to the file whenever there is a Bot, so the disconnected state is lost after a restart.
- **To do** (semantics in Appendix M.2):
  - "Disconnect" must be recorded persistently, **including for projects with no binding of their own that use the global default Bot**. Approach: on disconnect, write the project binding record `{ enabled: false }` without `botId`, meaning "still uses the default Bot, but disconnected"; when `materializeTelegramConfig` reads `enabled: false`, it yields `telegramEnabled: false` whether or not there is a `botId`. On "connect", if the record has only the `enabled` item, delete it and return to "no binding";
  - Startup no longer overrides the user's disconnect: `enableConfiguredTelegramOnStartup` adds `true` only when there is **no explicit disconnect record**;
  - The result of connect/disconnect follows the **actual running state**: after the operation, wait for one `reconcileCoordinator` to complete, then refresh the menu and the status bar;
  - On disconnect, if this instance is the current active instance, release the active record so other pi instances of the same Bot can take over (do not wait for the record to expire).
- **Completion criteria**:
  - Unit test: for projects with a binding and without one, "disconnect → re-read config → simulate restart"; after the three steps both are still disconnected; after "connect", the project without a binding returns to having no binding record;
  - E2E (pi): within 5 seconds after disconnect, the mock Telegram no longer receives `getUpdates` requests and the status bar shows `disconnected`; after connecting in the terminal `/tg`, polling resumes and the status bar returns to connected; after restarting pi the last state is kept;
  - Disconnecting from Telegram: a second confirmation appears first; after confirming, Telegram receives the notice "Disconnected. You can only reconnect from the terminal." and does not respond afterwards.
- **Not included**: menu structure changes (T4.9).

### T4.9 Rework the `/tg` menu per Appendix M

- **Files**: `lib/commands/tg-menu.ts`, and if needed `lib/commands/telegram-commands.ts`, `lib/pairing.ts`.
- **To do**: adjust the Bots and Project submenus per the structure in Appendix M.1:
  - Bots: lift the global default Bot out of a single Bot's detail page and make it its own item under Bots; add the pairing entry;
  - Project: change `Enabled: ● on / ○ off` into a connection state plus action buttons (Appendix M.2);
  - Reuse the existing business functions (`addBotFlow`, `updateBotFlow`, `removeBotFlow`, `setBotDefaultFlow`, `clearBotDefaultFlow`, `bindProjectFlow`, `unbindProjectFlow`) and change only the menu layer; call the connect/disconnect functions changed in T4.8 directly.
- **Completion criteria**:
  - Unit test: the option text and order at every level of the menu match Appendix M.1;
  - Unit test: the pairing page displays correctly in the two states "not paired" and "paired"; after unpairing, `allowedUserId` is cleared and a new pairing code is generated;
  - Unit test: the connection state on the Project page comes from the running state (whether polling is running, whether this is the active instance), not from a config field; when another instance is using the same Bot it shows "In use by another instance";
  - E2E (pi): from Telegram go through "Bots → global default Bot → set" and "Project → bind Bot → select", and the config file result is correct.
- **Not included**: deleting `/tg-*` (T4.10).

### T4.10 Delete the `/tg-*` commands, keep only the `/tg` entry

- **Background** (user decision, 2026-10-24): the plugin's own management functions are entered only through the `/tg` menu. After T4.9 is done, the `/tg` menu covers all `/tg-*` functions.
- **Commands to delete**: `/tg-bot-add`, `/tg-bot-list`, `/tg-bot-update`, `/tg-bot-remove`, `/tg-bot-default`, `/tg-bind-cwd`, `/tg-unbind-cwd`, `/tg-cwd-connect`, `/tg-cwd-disconnect`.
- **To do**:
  - Delete the `registerCommand` registrations of these commands in `lib/commands/telegram-commands.ts`; keep the business functions the menu calls (the menu depends on them);
  - Delete the matching menu items in `lib/menu-commands.ts`;
  - Change every `/tg-xxx` that appears in prompt text to a menu path, for example "/tg → Bots → Add bot" (the `notify` text in `telegram-commands.ts`, and the references in `lib/config.ts` and `index.ts`);
  - Tests: change `lib/__tests__/telegram-commands.test.ts` and `menu-commands.test.ts` to test menu paths or business functions; change the steps in `scripts/e2e/run-e2e-commands.mjs` and `audit-parity.mjs` that use `/tg-*` to go through the `/tg` menu;
  - Docs: change the command descriptions in `README.md` and `docs/compatibility.md` to menu paths; the CHANGELOG lists the deleted commands and the matching menu paths as a "behavior change";
  - Append one decision record to plan §9.
- **Completion criteria**:
  - Apart from the change notes in the CHANGELOG, `grep` finds none of `tg-bot-`, `tg-bind-cwd`, `tg-unbind-cwd`, `tg-cwd-connect`, `tg-cwd-disconnect` in the repository;
  - When a deleted command is sent in Telegram, the reply is "Unknown command, please use /tg" and it is not forwarded to the host;
  - E2E: from both Telegram and the terminal, use the `/tg` menu to complete one "add Bot → set as default → bind the current project → disconnect → reconnect", and the config file results match those of the original `/tg-*` commands;
  - `/tg` is still usable in the terminal (after a project disconnects Telegram, it can only be reconnected from the terminal).
- **Not included**: the same-name conflict of `/status` and `/debug` with host commands, and the Thinking level option in the `/tg` menu that imitates a host function (handled separately; it must be added to the plan §10 to-do list, and this task does not touch it).

### T4.11 Stage 4 acceptance

- Report item by item against the stage 4 acceptance criteria in plan §6, plus the completion criteria of T4.8–T4.10.

---

## Stage 5: cleanup

The order matters: **first build the state-equivalence tests, then delete the old code**, and after deleting run again, using the tests to prove the deletion caused no regression.

| # | Task | Depends on | Status | Commit |
|---|---|---|---|---|
| T5.1 | ~~Config value migration and menu~~ | — | Void | The `tuiBridge` config item was deleted in D1; reading an old value only logs a warning |
| T5.2 | State-equivalence E2E framework | — | ☑ | S1 `14c8c46`: `npm run test:e2e:state`, three pi cases `/name`, `/model`, `/settings` Auto-compact; `--self-test` proves the comparison is effective |
| T5.3 | State-equivalence E2E covers all commands | T5.2 | ☑ | S2 `6a0721a`: adds pi `/scoped-models`, OMP `/model` assign purpose, OMP `/settings` (in the mock environment neither side writes to disk, skipped); pi/OMP `/model` option-set check. P6 `53a1654` fixed not returning to page 1 when the list is swapped |
| T5.4 | Delete the mirroring code in the controller | T5.3 | ☑ | Already done by D2 `07b5df6` |
| T5.5 | Delete `tui-selector.ts`, `tui-bridge.ts` | T5.4 | ☑ (revised) | `tui-selector.ts` was deleted by D2; `tui-bridge.ts` is now the core that connects the new architecture to the host, so it is kept (decided by the controller 2026-10-25, the user agreed to the stage 5 split) |
| T5.6 | Old callback prefix changed to "expired" | T5.4 | ☑ | Already done by D2 `07b5df6` |
| T5.7 | Documentation update | T5.1–T5.6 | ☑ | Controller: the compatibility doc gained a dialog support matrix and secret redaction notes, and the state-equivalence suite; the old plan document is marked superseded; the README gained state-equivalence and secret links |
| T5.8 | Final acceptance | T5.7 | ☑ | 2026-10-25: all six E2E suites passed on pi 1.4.0 and OMP 18.12.5 (basic send/receive, dialogs, commands pi 76/76 · OMP 135/135, tui-bridge, state equivalence 5 cases identical 1 skipped); unit tests 767/767, 0 skip. **Refactor complete** |

### T5.1 Config value migration and menu

- **Files**: `lib/config.ts`, `lib/types.ts`, `lib/commands/tg-menu.ts`, `lib/commands/tg-config.ts`.
- **To do**: plan §4.10: when reading the config, map unset, `commands` and `full` to `on`, without rewriting the config file; the `/tg → Config` menu keeps only `on`/`off`.
- **Completion criteria**: unit test: the four old values (unset, `commands`, `full`, `off`) read correctly and the config file content is unchanged; the menu shows only two options; the existing `off` mode tests are all green. The CHANGELOG explains it separately as a "behavior change".

### T5.2 State-equivalence E2E framework

- **Files**: `scripts/e2e/audit-parity.mjs`.
- **To do**: steps 1–3 of plan §7.2: for each case start two fresh isolated hosts, A operated in the terminal through tmux and B operated from the mock Telegram; after execution export a state snapshot (current model, thinking level, session file, settings file, the relevant fields in the auth file), and compare whether A and B are identical.
- **Completion criteria**: first get it working with 3 commands (`/name`, `/model`, and one item in `/settings`); the test fails when B is made to skip one step on purpose (proving the comparison is effective). Keep the existing Bot API contract check.

### T5.3 State-equivalence E2E covers all commands

- **To do**: add all state-changing pi commands (from pi@v1.4.0 `setupEditorSubmitHandler`), and the OMP commands that can run in the mock environment, to the T5.2 framework; add step 4 of plan §7.2: "the option set listed in Telegram equals the component's full list".
- **Completion criteria**: all green on pi and OMP; commands that cannot run in the mock environment are listed with the reason.

### T5.4 Delete the mirroring code in the controller

- **To do**: delete the functions listed on the `lib/controller.ts` row of the "Modified" table in plan §5 (`TuiMirror`, `refreshTuiMirror`, `startPromptMirror`, `promptMirrorHook`, `runTuiCommand`, `runTuiCommandInner`, `buildSelectorKeyboard`, `formatSelectorMessage`, `tuiKeyRows`, `advertisedKeys`, `formatTuiSnapshot`, `trimScreenChrome`, `snapshotLinks`, `hasInputPrompt`, `handleTuiCallback`).
- **Completion criteria**: `grep` finds none of these names; the T5.3 state-equivalence E2E is all green both before and after the deletion; the `off` mode tests are all green (`off` uses Telegram native implementations and does not depend on mirroring).

### T5.5 Delete `tui-selector.ts`, `tui-bridge.ts`

- **To do**: migrate the exports of `lib/tui-bridge.ts` that are still used to `lib/tui/host.ts` and `lib/tui/snapshot.ts` (snapshot rendering migrated from `renderScreen`), and change callers to import from the new location; then delete `lib/tui-bridge.ts`, `lib/tui-selector.ts`, `lib/__tests__/tui-selector.test.ts`.
- **Completion criteria**: the two files do not exist; `npm run typecheck`, `npm test` and T5.3 are all green.

### T5.6 Old callback prefix changed to "expired"

- **To do**: when a `tgplus:tui:` callback (an old message sent before the upgrade) is received, reply "This button has expired" and remove the keyboard from that message; do not execute any key.
- **Completion criteria**: unit test: a callback with the old prefix triggers no host input and replies with the expiry notice.

### T5.7 Documentation update

- **To do**: the documentation items in the "Modified" table of plan §5:
  - `README.md`: rewrite the two paragraphs "Interactive modals are Telegram-only during a Telegram turn" and "Mirrored dialogs arrive as one Telegram message", and add the limits of secret redaction;
  - `CHANGELOG.md`: summarize the behavior changes;
  - `docs/telegram-interactions-plan.md`: note at the top that principle 1 has been superseded by the new plan;
  - `docs/compatibility.md`: update the pi/OMP support matrix (which dialogs are structured and which are snapshots).
- **Completion criteria**: "mirroring" no longer appears in the README as a description of current behavior; the compatibility matrix matches the test results of T5.3.

### T5.8 Final acceptance

- The stage 5 acceptance criteria in plan §6: the state-equivalence test of §7.2 passes on all pi versions covered by `npm run test:pi-versions` and on OMP.
- Report: the result for each version; list versions that do not pass separately with the reason, and say whether it is fixed or marked unsupported in the compatibility matrix (the latter changes the acceptance criteria, so ask first under rule 5).

---

## Appendix M: `/tg` menu plan (decided by the user on 2026-10-24, implemented in T4.8–T4.10)

### M.1 Menu structure

Principle: **Bots manages the Bots themselves (global)**, **Project manages the current directory (local)**. The two do not cross: the global default Bot is set only in Bots, and connect/disconnect is done only in Project.

```
/tg
├─ 🤖 Bots                          global, affects all directories
│   ├─ ➕ Add Bot
│   ├─ Bot list → pick a Bot
│   │    ├─ Update (name, token)
│   │    ├─ Pairing → see M.3
│   │    └─ Delete
│   ├─ ⭐ Global default Bot: <name or not set>
│   │    └─ Pick a Bot to set as default / clear the default
│   └─ ⬅️ Back
│
├─ 📁 Project                       affects only the current directory
│   ├─ Bound Bot: <name> or <name> (global default)
│   │    └─ Pick a Bot to bind / unbind (use the global default instead)
│   ├─ 🟢 Connected → [Disconnect]          or   ⚪ Disconnected → [Connect]
│   └─ ⬅️ Back
│
├─ ⌨️ Commands, ⚙️ Config, Switch instance    not changed this time
└─ ⬅️ Back
```

- In the Bot list, each item shows "⭐ Default" and the pairing state ("Paired"/"Not paired").
- When the current directory has no usable Bot (no binding and no global default), the Project page shows only "Bound Bot: not set" and no connect button.

### M.2 Connect / disconnect

| Item | Rule |
|---|---|
| Meaning | Whether pi in the current directory sends and receives messages through Telegram. It affects only the current directory, not the Bot itself, and not other directories |
| Display | Shown by the **actual running state**, not by config fields: 🟢 Connected (this instance is polling); 🟡 In use by another instance (the same Bot is served by another pi instance); ⚪ Disconnected (manually disconnected by the user) |
| Persistence | **Disconnect is kept after restart**; it is restored only by connecting manually. Directories with no binding of their own that use the global default Bot can also be disconnected (the recording method of T4.8) |
| Disconnect from Telegram | **Allowed**, and requires a second confirmation; the confirmation box states "After disconnecting, Telegram will no longer respond, and you can only reconnect in the terminal with /tg" |
| Connect from Telegram | Impossible (when disconnected Telegram receives no messages), no handling needed in the menu |
| After the operation | Wait for the actual state switch to finish, then refresh the menu and the status bar; the status bar and the menu display must agree |
| Old naming | `Enabled: ● on / ○ off` is no longer used; the `enabled` field name in the config file may stay, and only the menu display and semantics change |

The two items "Persistence" and "Disconnect from Telegram" above were written with suggested defaults because the user had not chosen explicitly; if the user changes the decision, only these two rows and the matching completion criteria of T4.8 need to change.

### M.3 Pairing

| State | Display | Action |
|---|---|---|
| Not paired | Pairing code and steps (reuse `formatPairingInstructions`) | Regenerate the pairing code |
| Paired | The paired Telegram user (`allowedUserId`, with the username when available) | Unpair: after a second confirmation, clear `allowedUserId` and generate a new pairing code; if operated from Telegram, show "After unpairing, the current chat can no longer be used and must be paired again" |

- Pairing itself is still completed by `/pair <pairing code>` on the Telegram side; the menu only displays and resets.
