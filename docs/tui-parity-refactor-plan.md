# Refactor technical plan: using all TUI commands equivalently from Telegram

> Status: v8 (2026-10-28): the goal is in §0.0, the rules in force are in §0.2; on conflict, §0.0 > §0.2 > §0.1 > body text
> Target hosts: pi (`@earendil-works/pi-coding-agent`, checked version 0.81.1), OMP (`omp/18.12.5`, installed at `~/.local/bin/omp`, a compiled single file)
> Supersedes: **principle 1** of `docs/telegram-interactions-plan.md` ("dialogs initiated from Telegram go only to Telegram and do not pop up in the TUI"). Principle 2 of that document (status UI is written back to the TUI), principle 3 (do not touch the local editor during a Telegram turn) and principle 4 (never hang) remain in force.
> Reader: the engineer or model doing the implementation. This document is self-contained and does not depend on earlier conversation.
> Citation convention: plugin code is always located by **function name or constant name** (line numbers drift); pi host code is cited as "file + function name + 0.81.1 line number", because the published package content is fixed.
> Revision notes are in §11.

---

## 0. In one sentence

### 0.0 Goal (v8, 2026-10-28, takes precedence over everything else in this document)

**When the person is away from the computer, Telegram alone should be enough to fully drive the running pi/OMP: only valuable information and tappable buttons appear on the phone, and no terminal screen.**

1. **Content area** (agent messages, thinking, tool calls, user messages): sent and received through session events by `lib/renderer.ts`. It already works and only needs to stay reliable; user messages enter the main thread as steer/queue.
2. **Interaction area** (the TUI input area: the selectors, input boxes, login prompts and progress that the host draws by temporarily replacing the editor, plus tool dialogs such as `ask`/approve): build equivalent native interaction on Telegram.
   - Selectable on the TUI → inline buttons with paging (example: `/model` shows only the model list; `/login` first shows the provider list, and after a pick shows the link or "Please enter the API key").
   - Text display on the TUI → Telegram text.
   - One command, one message: buttons, progress and result are edited in place on the same message, with no flooding.
   - Commands are executed by the host and the plugin does not rewrite host functionality; a dialog initiated from Telegram can be answered on both ends, and whoever answers first wins; a locally initiated one stays in the terminal only.
3. **Only structured data that the host actively provides is trusted**: the arguments of the dialog entry methods, the public data fields of components, the `describe()` semantic tree of OMP components, host status/error/warning strings, and extension `notify`. **What the host does not provide is unsupported; do not guess.**
4. **The mirroring approach is forbidden**: do not call `render()` to read the screen, do not intercept chat-area components, do not parse the screen with regular expressions, do not locate the cursor by counting screen lines, and do not infer positions by simulating key presses. If it cannot be read → clearly say "Telegram does not support this, please operate in the terminal" and give only "Cancel". Acceptance: no code in `lib/` reads the return value of `render()` (grep check).
5. **Reliability precondition**: at most one plugin wrapper layer per host method (§0.2 #19 design); no stacking of layers after a long session, `/new` or `/reload`.

Anything in the rest of this document that conflicts with the goal above (terminal mirroring, snapshots, the rendered-text exception, chat-area interception, etc.) is void.

### 0.0.1 The original one sentence (v4, kept as history)

**Except for plugin-only commands (`pluginOnly`, §4.2.1), all commands are handed to the host to execute itself; the plugin intercepts structured data at the host's "output entry points" and "focus changes" and presents it with native Telegram messages and buttons; the user's actions on Telegram are passed back through the host component's own input handling. Whoever initiates, displays: a dialog initiated from Telegram can be seen on both sides (the host always draws it in the terminal), and whoever acts first wins; a locally initiated one is not pushed to Telegram.**

Command logic is no longer rewritten inside Telegram, and terminal screen text is no longer parsed to generate actionable buttons.

### 0.1 v6 rules in force (2026-10-24, take precedence over conflicting content elsewhere in this document)

1. **Only one host version is supported**: pi `1.4.0`, OMP `18.12.x`. When the version does not match or cannot be read, the plugin errors out at startup (status bar + Telegram notice), with no degradation or compatibility. `peerDependencies` is pinned to pi `1.4.0`; the multi-version test matrix is no longer maintained.
2. **The host source is authoritative**: local read-only copies are pi `/Users/jaly/Documents/project/research/pi-1.4.0` (tag `v1.4.0`) and OMP `/Users/jaly/Documents/project/research/oh-my-pi-18.12.5` (tag `v18.12.5`). All field and line number citations of the form "pi 0.81.1, line N" in the text are void and 1.4.0 source is authoritative; task A1 updates them one by one after checking; `docs/host-probe/pi-0.81.1.json` and conclusions based on it are void.
3. **No degradation, only one way**: a dialog that cannot be recognized does not get a screenshot plus arrow keys and is not handed back to screen mirroring. Instead Telegram says clearly "There is a dialog in the terminal that Telegram cannot handle (<type>), please handle it in the terminal" and offers only a "Cancel" button (sends Esc). When the bridge is unavailable (the host runs in RPC/print mode, or a hook fails), the plugin errors out at startup and does not fall back to the plugin's native implementation.
4. **Delete old paths immediately** (tasks D1–D4, before the later migration): the `off` mode and the `tuiBridge` config item, the old screen mirroring (`runTuiCommand`, `tui-selector.ts`, the `tgplus:tui:` callback), the native implementations where the plugin redoes host functionality (the matching parts of model/session/settings/auth etc. in `lib/commands/`, the matching native dialog flows in `telegram-ui.ts`, `custom-dialogs.ts`), and snapshot arrow keys. The plugin's own management functions (`pluginOnly` commands such as the `/tg` menu, `/stop`, `/pair`) are kept.
5. **E2E "to be migrated" list**: after the old paths are deleted, commands not yet migrated to the new architecture temporarily have no output or interaction on Telegram. The E2E suite maintains a "to be migrated" list: a failure of a step on the list is an expected result and is listed separately; a failure of a step off the list is a regression. Each time a migration is completed, remove the matching step from the list.
6. This section, together with §4.11 (OMP structured channel) and decisions 41–50 in §9, forms the constraints of v6.

### 0.2 v8 rules in force (2026-10-28, take precedence over conflicting content elsewhere in this document and in §0.1)

Background: #19 (after a long session `/tg` and `ask` overflow the stack, #16 recurs) and #20 (command replies get mixed into the agent tool box) both come from the mirroring layer that "observes terminal rendering and infers ownership backwards". W-1 measured: on OMP, the 13 dialog methods of the UI context are reinstalled about once per second (95 times in 94 seconds); on pi, every `/new` and `/reload` wraps another layer around its own previous layer (`ptp:showExtensionSelector > ptp:…`).

**Interaction rules (confirmed by the user)**

1. **The chat area is not intercepted by the plugin.** Agent messages, user messages and tool calls are sent by `lib/renderer.ts` through session events, and this part is unchanged. Command/tool interaction on Telegram corresponds only to the content of the TUI **input area** (the selectors, input boxes, login prompts and progress that the host draws there by temporarily replacing the editor).
2. **Selectable on the TUI → Telegram inline buttons (with paging); text display on the TUI → Telegram text.** Text is taken only from structured data given by the host: the dialog entry arguments, the `text`/`markdown` etc. fields of components, the strings of `showStatus`/`showError`/`showWarning`, extension `notify`, and the `title` of `showCommandReport`.
3. **No terminal mirroring: do not call `render()` to read the screen.** An interface from which structured data cannot be obtained always gets the notice "Telegram does not support this, please operate in the terminal", with only "Cancel".
4. **One command, one message, edited in place.** Buttons, progress and result are all replaced with `editMessageText` on the same Telegram message, and the buttons are removed when done.
5. A locally initiated dialog stays in the terminal only (principle 3 unchanged).

**What is deleted as a result**

- `OutputCapture`'s interception of `chatContainer.addChild`: `AGENT_CTORS`, `AGENT_FIELDS`, the method-shape exclusion (2f936f5), the `clear` rebuild window, `REBUILD_OUTPUT_LABELS`, the `render()` branch of `renderComponent`, and the body rendering of `showCommandReport`. Kept: `showStatus/showError/showWarning`, `/export` sending a file, and the bash result of the `!` command (`getOutput()` of the host bash component, see below).
- Adapters that work from rendered text: `customGoalAdapter` (pi-goal, §4.6.6 exception 1 is void), the `renderText` of `infoPanelAdapter` (changed to read structured fields only; if unreadable, treat as unsupported), and `renderText` in `adapters/utils.ts`.
- The `!` command result is changed to read `getOutput()` of the host bash component and no longer calls `render()`; the claiming method (the bash execution component inside the "!" scope, including the pending area) is unchanged.

**#19: host method wrapping changes to "one wrapper per method per object"**

- A new module `lib/tui/hooks.ts` replaces the heuristics of `install-marks.ts` (object marks, comparing two reads, function identity, scoping by tracker) and the separate wrapper code in `hookMethod`/`installRace`/`hookEntryMethods`/`watchEditor`.
- The registry lives on `globalThis` (`Symbol.for` key) and is shared across module instances (OMP `?mtime=` import, `/reload`): `WeakMap<object, Map<method, Slot>>`. `Slot = { wrapper, base, handlers: Map<kind, Handler> }`.
- Each (object, method) has only one `wrapper`; each feature (race, entry, focus, status, bash…) is attached to the slot as a `kind` handler, forming the call pipeline in a fixed priority order. **Installing the same kind again only replaces the handler and adds no wrapper.** When the runtime is rebuilt (`/new`, `/reload`), the new tracker overwrites the old handler with the same kind, and when the old runtime is disposed it removes its own handlers.
- **Identity is judged by reading the own property descriptor, not `object[method]`.** The verified failure mechanism (OMP 18.12.5 `extensibility/extensions/user-wait.ts` `trackUserWaits`): the tool UI context is a Proxy, and `get` caches an anonymous forwarding function for each underlying function value. The wrapper we write lands on the underlying object; reading it back gives "an anonymous function that forwards to our wrapper". The read is stable but it is not our wrapper → the old logic wrapped another layer around it every second. `Object.getOwnPropertyDescriptor(proxy, method)` forwards to the underlying object when there is no matching trap, and returns exactly the value we wrote.
- Installation rules:
  - First time: `base` = the value read from `object[method]` (may come from the prototype); write `wrapper`;
  - Afterwards: the own descriptor's `value === slot.wrapper` → leave alone;
  - The own descriptor exists, is a function and is not our wrapper (the host really replaced the method) → `slot.base = the descriptor's value` (the original function, not the Proxy's forwarding function), write the same `wrapper` back, and log a debug message;
  - The write fails (frozen object) → give up and log a debug message.
- Our wrappers are all registered in one `WeakSet`; `base` can never be a registered wrapper (prevents self-reference).
- The tick only compares whether the host object identity has changed; if the object has not changed it does not enter the installation logic.
- Regression test: thousands of attach ticks, tracker rebuilds, the host returning a new function on every read, and the host replacing the method and then switching back; the call-chain depth stays constant (at most one plugin wrapper layer per object method).

**Data source decisions (2026-10-28, SRC-3 evidence gathering, confirmed by the user)**

- **Equivalence principle**: whatever the user can see and interact with on the TUI must also be possible on Telegram. Failure to recognize something is almost always because the plugin has not done it, not because the host gave no data; only for interfaces where the host truly has no structured data do we say it is unsupported.
- **OMP: always use the `describe(cx)` semantic tree.** The selector's `selected`, the `/settings` `focus`, the ask `list.selected` (`overlays/ask-dialog.ts:930`) and the input `cursor` are all public data; setting selection goes through the `select`/`activate`/`action` of `handleNativeEvent`. Note that for an ask single-choice question and for approve, `select` means submit. Text panels (reports/`/hotkeys`, `/session` session info, `/usage`, `/jobs`, `/btw`, etc.) also have `describe()` (text/span/meter/spinner and other nodes), converted into Telegram text + the panel's own buttons (such as Close). The way `ask.ts` computes the cursor by itself is void; read `list.selected` instead.
- **pi: there is no semantic interface, so read the component fields.** Reading fields that are TS `private` but readable at runtime (`selectedIndex`, `filteredModels`, etc.) is allowed, restricted to pi `1.4.0`, with contract tests pinned to the real 1.4.0 components; setting selection computes the step count from `selectedIndex` and then sends arrow keys to the focused component (the operation goes through the component's own input handling, §2 principle 4). An extension `custom()` component keeps its data in a closure → unsupported.
- **Command text that pi writes into the chat area** (`/session`, `/hotkeys`, `/debug`, `/changelog`, etc.): visible on the TUI, shown equivalently on Telegram. Only components added to `chatContainer` **inside that command's call chain** are claimed: the Gateway wraps the submit call in `AsyncLocalStorage` (the synchronous part and the await continuations after it both carry that command's context; agent events run in the agent loop's own context and do not carry it). There are two cut-off points: `session.prompt` (an agent turn started by a command belongs to the renderer, not the command), and the host's history rebuild methods (pi `renderInitialMessages`/`renderSessionItems`/`renderSessionEntries`/`rebuildChatFromMessages`, OMP `rebuildChatFromMessages`/`renderSessionContextIncrementally`/`renderInitialMessages`) run in their own contexts, and components added during that time are not claimed. Only content sources are taken: the `text` field, the `markdown` field, the content function of `ThemedText` (returns a string, ANSI stripped), and the container's `children` one by one; components with no content such as `Spacer` and `DynamicBorder` are skipped. `render()` is not called. OMP's `presentCommandOutput` (command output declared by the host itself, which is deferred until `agent_end` before being added to the chat area while the agent is running) is claimed at call time by the same context.
- **Loader/progress**: pi `Loader` (extends `Text`, `message` field), the label of OMP spinner/progress nodes, edited in place on the same message.

**Tasks (dispatched in turn, each requires typecheck + unit tests all green)**

| ID | Content |
|---|---|
| H-1 | `lib/tui/hooks.ts` registry + regression tests (including a Proxy with the real `trackUserWaits` shape, tracker rebuild, thousands of ticks) |
| H-2 | Migrate `hookMethod`/`installRace`/`hookEntryMethods`/`watchEditor` to the registry, delete `install-marks.ts`, remove handlers on dispose |
| H-3 | The tick compares only whether the host object identity has changed |
| O-1 | Delete chat-area interception (`AGENT_CTORS`, `AGENT_FIELDS`, shape rules, rebuild window, the `render()` in `renderComponent`), changed to claiming by "command call chain (ALS) + content source", including the cut-off of `session.prompt` and history rebuild |
| O-1b | `!` result changed to read `getOutput()`; OMP `presentCommandOutput` claiming |
| O-2 | Delete `customGoalAdapter` (pi-goal) and `renderText`; `infoPanelAdapter` changed to read fields/`describe` |
| N-1 | General conversion from the OMP semantic tree to Telegram text/buttons, covering text panels and reports; add claiming of report panels |
| N-2 | `ask.ts` changed to read `list.selected` |
| N-3 | Loader/progress changed to read fields and spinner/progress nodes |
| T-1 | Unit tests do not write to the user's real log directory |
| E2E | At the end of the stage the controller runs once each on pi and OMP + a long-running layer-stacking retest (W-1 instrumentation, confirming the install count does not grow over time) |


---

## 1. Background and current-state diagnosis

### 1.1 Goal

- All slash commands of the TUI (built-in commands, extension commands, prompt templates, skills) can be used on Telegram, along with all dialogs that pop up during an agent turn initiated from Telegram (the `ask` tool, the extension's `select/confirm/input/editor/custom`, OMP's `approve`).
- "Equivalent" is defined as **semantic equivalence**: the same options, the same current values, the same executable actions, and exactly the same host state after execution. Visual identity is not pursued.
- For terminal-only commands (clipboard, external editor, quit, etc.), provide a clear Telegram equivalent (§4.8).

### 1.2 Non-goals

- No pixel-level terminal mirroring, and no web terminal (Telegram Mini App + xterm.js).
- The host source is not changed.
- The behavior of operations the local TUI user initiates is not changed.
- Non-capturing host overlays (`showOverlay(c, { nonCapturing: true })`) are not supported: they take no focus and receive no input, and are only decoration.
- The `off` mode and the plugin's native implementation are not kept (§0.1 item 4, v6).

### 1.3 Current state (why refactor)

There are now three parallel interaction channels, and which one is used depends on configuration and hard-coded command sets:

| Channel | Location | Approach | Problem |
|---|---|---|---|
| Telegram native rewrite | `lib/commands/*.ts`, `lib/telegram-ui.ts` | Re-implements `/model`, `/session`, etc. with the session interface | Cannot keep up with the host; misses side effects inside TUI callbacks |
| custom dialog bridge | `lib/custom-dialogs.ts` | Matches the fixed wording of pi-goal | Only knows pi-goal |
| Screen mirroring | `lib/tui-bridge.ts`, `lib/tui-selector.ts`, `refreshTuiMirror`/`startPromptMirror`/`runTuiCommand` in `lib/controller.ts` | `ui.render(100)` → strip color codes → recognize options by regex → simulate arrow keys | Information is lost and it can only guess; changed 14 times in two days |

The routing branches are in the constants `TUI_NATIVE_SELECTOR_COMMANDS`, `MIRROR_FIRST_COMMANDS`, `HOST_CAPABILITY_COMMANDS` and the function `dispatchNamedCommand` in `controller.ts`. The default of `getTuiMode` in `createTelegramController` is `"commands"`, in which mode interactive dialogs are read-only.

In addition, two documents promise contradictory things: the paragraph "Interactive modals are Telegram-only during a Telegram turn" in `README.md`, versus `createPromptObserverUi` in full mode (draw in the terminal, then mirror out). This plan unifies them under §2 principle 3.

---

## 2. Design principles (must be followed in implementation)

1. **The host executes; the plugin does not rewrite.** Except for `pluginOnly` commands, the command text is handed to the host's submit handler to execute. The plugin keeps no native implementation that redoes host functionality; when the bridge is unavailable it errors out at startup (§0.1).
2. **Read structured data, not the screen.** The data sources, in order, are: the arguments of the entry method → the return value of a host method → fields on the component object → and only last a read-only screenshot. At every level it is **forbidden** to parse rendered text with regular expressions to generate actionable buttons. The only exceptions are the two listed in §4.6.6 (the opaque `custom()` component of pi-goal; locating the current row of an OMP entry dialog), both with strict limits.
3. **Whoever initiates, displays; shared ownership, whoever acts first wins.** A dialog initiated from Telegram: Telegram displays it and the terminal also displays it (drawn by the host); when either side completes the operation, the other side closes immediately or shows "already handled on the other side". A locally initiated dialog: terminal only. Changes in the terminal are not actively synced to Telegram.
4. **Operations go through the component's own input handling.** A choice on Telegram is translated into: first set the component's structured state (such as `selectedIndex`), then call `handleInput("\r")` on the **focused object**. Do not guess the argument signatures of private callbacks.
5. **If it cannot be recognized, say so clearly and never hang.** On a recognition failure do not degrade and do not give half-baked actions: say it clearly on Telegram and offer only "Cancel" (Esc) (§0.1 item 3). Any wait on the Telegram side must be interruptible by completion on the terminal side, a host timeout, or `/stop`.
6. **Do not overwrite the local draft.** Before submitting a command from Telegram, save the local editor content, and restore it when the command scope ends by the rule of §4.2.4.
7. **Hooks must not affect the host.** Every wrapper function calls the original method first and returns its result unchanged, and all plugin logic is inside `try/catch`.

---

## 3. Overall architecture

```
                   ┌──────────────────────────── Host process (pi / OMP interactive mode) ────────────────────────────┐
 Telegram message ─▶ │  CommandGateway ──submit──▶ editor.onSubmit (the host's own command dispatch)                    │
                   │     │ open scope                     │                                               │
                   │     ▼                                ▼                                               │
                   │  OriginTracker ◀──────┐      host runs the command ─┬─▶ showStatus / showError / showWarning   │
                   │     ▲                 │                    │         │ (prototype hook)                    │
                   │     │ Telegram turn   │                    │         ▼                                │
                   │     │ (UI stack top)  │                    │   OutputCapture ──────────▶ Telegram text │
                   │                       │                    ├─▶ chatContainer.addChild (instance hook)     │
                   │                       │                    └─▶ ui.setFocus / showOverlay (instance hook)  │
                   │                       │                               │                              │
                   │                       │                               ▼                              │
                   │                       └───────────────── FocusTracker: classify the focused object       │
                   │                                                       │ dialog / progress           │
                   │                                                       ▼                              │
                   │                                     DialogBroker (single active session)             │
                   │                                       AdapterRegistry → DialogModel                  │
                   │                                                       │                              │
 Telegram buttons ◀── │                                       TelegramDialogRenderer                         │
 Telegram callback ─▶ │  Broker.act() ──▶ adapter.act() ──▶ focused object.handleInput("\r") etc.            │
                   └──────────────────────────────────────────────────────────────────────────────────────┘
```

Module breakdown (new directory `lib/tui/`):

| Module | File | Responsibility |
|---|---|---|
| HostAdapter | `lib/tui/host.ts` | Capture host objects, install hooks, `HostCapabilities` |
| FocusTracker | `lib/tui/focus.ts` | Wrap `setFocus`/`showOverlay`/`hideOverlay`, classify focused objects, emit events, validate focus |
| OriginTracker | `lib/tui/origin.ts` | Decide which Telegram session the current focus and output belong to |
| CommandGateway | `lib/tui/gateway.ts` | Command dispatch priority, submit, draft protection, terminal-only mapping, holding enqueued turns |
| OutputCapture | `lib/tui/output.ts` | Intercept command output and convert it to Telegram text |
| DialogBroker | `lib/tui/broker.ts` | Dialog session state machine, whoever acts first wins, Telegram text input hookup |
| Model | `lib/tui/model.ts` | DialogModel and DialogAction types |
| Adapters | `lib/tui/adapters/*.ts` | Read a DialogModel from the focused object, and write operations back |
| Renderer | `lib/tui/render-telegram.ts` | DialogModel → Telegram message and keyboard; callback encoding/decoding |
| Snapshot | `lib/tui/snapshot.ts` | Read-only screenshot fallback (migrated from `renderScreen` of `tui-bridge.ts`) |
| Probe | `lib/tui/probe.ts` | Stage 0 host probe (§6 stage 0) |
| SecretStore | `lib/tui/secrets.ts` | Secret registration and source-level redaction (§4.7.4) |

---

## 4. Detailed module design

### 4.1 HostAdapter and FocusTracker

#### 4.1.1 Two ways of patching

1. **Prototype patch**: for classes that can be imported (`InteractiveMode`). Keep using the existing `patchMethod` in `tui-bridge.ts`. The plugin and the host get the same module instance, which is proven by the existing end-to-end tests.
2. **Instance patch**: for objects captured at runtime (`mode.ui`, `mode.chatContainer`, `mode.editor`, `mode.session`). Directly replace the method on the instance, and mark the wrapper function to prevent double wrapping.
   - **The control layer always uses only instance patches plus shape checks, and does not import `@earendil-works/pi-tui` or `@oh-my-pi/pi-tui`.** Reason: the plugin and the host may each load their own copy of pi-tui (this repository even nests one at `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`), so `instanceof` and prototype patches would fail; OMP is a compiled single file, and its internal modules cannot be guaranteed importable.

```ts
// lib/tui/host.ts
type Hooked<F> = F & { __ptpHook?: true; __ptpOriginal?: F };

export function wrapMethod<T extends object>(
  target: T,
  name: string,
  wrap: (original: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown,
): boolean {
  const current = (target as Record<string, unknown>)[name];
  if (typeof current !== "function" || (current as Hooked<Function>).__ptpHook) return false;
  const wrapped = wrap(current as (...a: unknown[]) => unknown) as Hooked<Function>;
  wrapped.__ptpHook = true;
  wrapped.__ptpOriginal = current as Function;
  (target as Record<string, unknown>)[name] = wrapped;
  return true;
}
```

**Instance hooks go stale.** The host replaces the hooked objects while running, and these replacements no longer trigger `init`/`run`/`setupEditorSubmitHandler`, so we cannot rely on `captureMode` alone:

- `setCustomEditorComponent` (L1830-1888) replaces `mode.editor` with the new editor provided by the extension and calls `setFocus(newEditor)`; it copies `defaultEditor.onSubmit` to the new editor (L1841).
- `/new`, `/resume`, `/fork` replace `mode.session`.

Rules:

1. **The submit hook goes on `mode.defaultEditor.onSubmit`** (not `mode.editor.onSubmit`). It is what the host copies when it replaces the editor, so the wrapped version is carried over together.
2. **A tick once per second** (sharing one timer with the focus validation of §4.1.3) checks whether `mode.editor`, `mode.session`, `mode.ui` and `mode.chatContainer` have changed object, and if so reinstalls the instance hooks on the new object (`wrapMethod` uses its mark to prevent double wrapping).
3. The tick starts after the mode is captured and exists as long as the plugin is running; its cost is only a few reference comparisons.

#### 4.1.2 Hook point table

| Purpose | pi 0.81.1 (`dist/modes/interactive/interactive-mode.js`) | OMP 18.12.5 | Method |
|---|---|---|---|
| Capture mode | `init` / `run` / `setupEditorSubmitHandler` (existing) | `initHooksAndCustomTools` / `render` (existing) | Prototype |
| Command submit | `mode.defaultEditor.onSubmit` (same instance as `mode.editor`; `setupEditorSubmitHandler`, installed at L2085) | `mode.editor.onSubmit` (there is no `defaultEditor`; during the stage 0 probe this field was still `undefined` at capture time and was assigned only after initialization, so it must be installed by the once-per-second tick) | Instance |
| Focus | `ui.setFocus(c)`; the current focus is read from `ui.focusedComponent`. Stage 0 proved it is a plain data field that **lags by one event** (after `setFocus` returns, what is read is the previous focus), so it can only be used for validation; the focus event itself is authoritative. The overlay's `setFocusInternal` receives a `{component, overlayFocusRestore}` wrapper; take `.component` before classifying | `ui.setFocus(c)`; the current focus is read from `ui.getFocused()` (exists and returns the live focus); there is no `focusedComponent` | Instance |
| Execution of extension commands | `mode.session.prompt(text)`: when idle, `onSubmit` only hands the text to the main loop (`onInputCallback`, L2262 → `getUserInput` L2817), and the main loop then does `await this.session.prompt(userInput)` (L653) | `mode.session.prompt(text)` exists; `session.isStreaming`/`isCompacting` are accessors; there is no `mode.pendingUserInputs` (the OMP branch of §4.3) | Instance (completion signal of §4.3) |
| Chat area rebuild | `chatContainer.clear()` | Same name | Instance (§4.4 excludes history redraw) |
| Overlay | `ui.showOverlay(c, opts)` / `ui.hideOverlay()` | Same name (OMP `/settings` uses an overlay) | Instance |
| Status output | `showStatus` (L2563), `showError` (L3180), `showWarning` (L3185) | Same name | Prototype |
| Other output | `chatContainer.addChild(c)` | Same name | Instance |
| Export result | `session.exportToHtml(path)` / `session.exportToJsonl(path)`; stage 0 proved they return a **Promise**, and the path is taken from the resolved value (`export-resolved` in the probe file) | `session.exportToHtml(path, false)` exists and also returns a Promise | Instance (effective only inside the `/export` scope) |
| Extension select entry | `showExtensionSelector(title, options, opts)` (L1712) | `select(title, options, opts)` of the UI context (internally `showCollabAwareSelector`) | The entry hook wraps the **UI context**, not the mode prototype |
| Extension confirm | `showExtensionConfirm(title, message)` (L1752, internally reuses the selector with options `["Yes","No"]`) | `confirm(title, message, opts)` of the UI context (internally `showHookConfirm`) | Same as above |
| Extension input | `showExtensionInput(title, placeholder, opts)` (L1763) | `input(title, placeholder, opts)` of the UI context (internally `showHookInput`); there is no `inputSecret` | Same as above |
| Extension editor | `showExtensionEditor(title, prefill)` (L1803) | `editor(title, prefill, opts)` of the UI context (internally `showCollabAwareEditor`) | Same as above |
| Extension custom | `showExtensionCustom(factory, options)` (L1903) | `custom(factory, options)` of the UI context (internally `showHookCustom`) | Same as above |
| OMP ask | — | `askDialog(questions, options)` of the tool UI context: the first argument is the question array (`id/question/header/options/recommended`), the second is `{timeout, signal, acceptImages}`; the focused component has only `callbacks`/`options`, and the answering state is in a closure | Context hook |
| OMP approve | — | `approve({full, compact, session})` of the tool UI context: three strings; the focused component has only `callbacks{onApprove,onDeny}` / `options{fullPrompt,...}` | Context hook |
| Local editor input | `mode.editor.handleInput` (decides whether the local user is typing, §4.2.4); re-wrapped by the tick when the editor is replaced | Same name | Instance |

Stage 0 conclusion (2026-10-23, probe files in `docs/host-probe/`): OMP's extension entry points are **not triggered directly on the `InteractiveMode` prototype**; extensions and tools call through their own UI contexts (`select`/`confirm`/`input`/`editor`/`custom`, with the tool context additionally having `askDialog`/`approve`). Wrapping only the mode prototype would miss extension dialogs. OMP's component class names are minified (`Ww`, `Ej`, `kj`, etc.), and adapters **must not match by class name**; they must use shapes/fields or entry arguments; class names are stable within one version and unstable across versions.

**Associating entry information with the focused object**: the entry method hook records semantic information (`EntryInfo`: kind, title, original options, question list), associated as follows, without using a time window:

- Synchronous entries (`showExtensionSelector`, `showExtensionInput`, `showExtensionEditor`): the host creates the component synchronously inside the entry method and calls `setFocus`. Before calling the original method, the hook pushes the entry onto `entryStack`; when the `setFocus` hook sees a new dialog focus, it takes the top entry and stores it in `WeakMap<object, EntryInfo>` (keyed by the focused object). The pop is written in `finally`, so it also pops when the original method throws, preventing a stale entry from being misused by the next focus event.
- **Nested entry merging**: `showExtensionConfirm` internally calls `showExtensionSelector`. When the inner hook finds an outer entry already on top of the stack, it only fills in fields (such as the original options) and **does not overwrite** `kind`, so the final kind is `confirm`.
- Asynchronous entry (`showExtensionCustom`): the host first does `await factory(...)` and only then `showOverlay`/`setFocus` (L1943-1959), and a slow factory may take a long time. The hook records the entry in the closure of this call and wraps the incoming `factory`: the component returned by the factory (or the component the promise resolves to) is written directly into `WeakMap<component, EntryInfo>`. When the focus event happens, look up by focused object first, then by root component.

#### 4.1.3 Classifying the focused object

There are three paths for focus changes, and all must be covered:

1. `ui.setFocus(x)`: the main path, an instance hook.
2. `ui.showOverlay(x, opts)`: it calls `setFocus` internally only when it is not `nonCapturing` and is visible (`showOverlay` in pi-tui `tui.js`), so hooking `setFocus` already covers it.
3. **Paths that bypass `setFocus`**: in pi-tui's input handling, the branch "the focused overlay is no longer visible" calls the private `setFocusInternal` (about L590 of `tui.js`), which the instance hook cannot catch. (`hideOverlay` calls the public `setFocus` and is already covered.)

Therefore, besides being event-driven, FocusTracker must also **validate**: at the following moments read the current focus once (how to read is in §4.1.2), compare it with the focused object recorded by the Broker, and treat any mismatch as a "focus change":

- before handling each Telegram callback or text input;
- each time OutputCapture receives output;
- the once-per-second tick (§4.1.1).

Stage 0 probe addition: pi's `ui.focusedComponent` still reads the **previous** focus after `setFocus` returns (a plain data field, not a live getter). So validation reads are used only to discover "internal switches that bypass `setFocus`"; the current focus is whatever the most recent `setFocus`/`setFocusInternal` event says. The overlay path's `setFocusInternal` receives a `{component, overlayFocusRestore}` wrapper object, and `.component` is taken before classifying. OMP's `ui.getFocused()` is a live read, all dialogs go through `setFocus`, and no wrapper object was observed.

Classification of the focused object `F` (judged in order, stop at the first hit):

| Class | Criterion | Handling |
|---|---|---|
| `editor` | `F === mode.editor` or `F === mode.defaultEditor` | Close the current session (if any), but **the focus returning to the editor must be sustained**: if the same component regains focus within the confirmation window (250ms), cancel this close. When OMP redraws an already-open overlay it hands focus back to the editor for one frame; judging by a single event would withdraw the Telegram keyboard mid-answer and hand the chat to mirroring (decision 28) |
| `inert` | `F` has no `handleInput` function | Ignore (for example `reloadBox` of `/reload`, a container that only shows text) |
| `progress` | `F.constructor.name` ends with `Loader`, or `F` has `signal`/`abortController` and no list or input field at all (looked up by `findShape` of §4.6.3) | A progress state, not a dialog: the broker creates no session for it and sends no Telegram message, and terminal mirroring still shows the screen as before. The original design of "send '⏳ In progress' with only a cancel button" proved harmful in testing: as soon as OMP's working spinner appeared it took up a keyboard-carrying message in the chat and swallowed the text the user sent to the next (not yet created) dialog, so that text never reached the model; interruption is still covered by `/stop` and mirrored keys (decision 28). Example: the `BorderedLoader` of `/share` (L4613) |
| `dialog` | Anything else | Hand to AdapterRegistry |

**Session identity is based on the focused object `F`.** The host's `showSelector(create)` returns `{ component, focus }`, and the two may differ: for `/settings` the focus is `selector.getSettingsList()` (L3583), and for `/fork` the focus is `selector.getMessageList()` (L3819). Rules:

- `detect` / `read` / `act` always target the focused object `F` and look for data downward from it.
- The root component `root` (`editorContainer.children[0]`, or the `component` of an overlay item) is used only to look upward for the title and entry information, not to decide whether the session is still alive.
- Input is always sent to `F.handleInput`, because that is what the host sends keys to.

#### 4.1.4 Host capability probe

```ts
type HostCapabilities = {
  host: "pi" | "omp" | "unknown";
  version?: string;
  focusHook: boolean;      // ui.setFocus is wrapped
  focusRead: boolean;      // the current focus can be read
  overlayHook: boolean;
  outputHook: boolean;     // at least one of showStatus/showError/showWarning
  submitHook: boolean;
  entryHooks: string[];    // names of the entry methods wrapped successfully
};
```

It is written to the debug log at startup. If any of `focusHook`, `focusRead`, `submitHook` fails, the plugin errors out at startup (§0.1) and does not fall back to any other path.

### 4.2 CommandGateway

#### 4.2.1 Command catalog

Keep `getTuiCommands()`: the OMP built-in registry `BUILTIN_SLASH_COMMAND_DEFS`, the autocomplete list, and `session.slashCommands`/`customCommands`/`promptTemplates`. Telegram menu generation and `/more` paging (`menuOverflow`, `moreKeyboard`) are unchanged.

Three name sets are computed at runtime (refreshed each time the mode is re-captured):

- `hostBuiltin`: host built-in command names.
  - **pi**: cannot be derived from the command catalog. In `buildCommandCatalog` the `source` for pi has only `"autocomplete"` and `"host"` (`"builtin"` appears only in OMP's registry), and the autocomplete list mixes extension commands and the 6 commands the plugin registers itself. So pi's `hostBuiltin` **directly uses the static list in Appendix A**, maintained per pi version. The stage 0 autocomplete catalog still cannot distinguish built-in from extension (`catalog` is empty), consistent with this judgment.
  - **OMP**: take the registry `BUILTIN_SLASH_COMMAND_DEFS`.
- `pluginNative`: all names in the plugin's `telegramCommands` map (registered by `registerAllCommands` and `registerTelegramCommands` in `index.ts`).
- `pluginOnly = pluginNative − hostBuiltin`: commands implemented only by the plugin and not built into the host, for example `/tg*`, `/stop`, `/status`, `/cwd`, `/cd`.
- Two plugin special cases that are **not in `telegramCommands`** are handled separately at dispatch step 0 (§4.2.2): `/pair` (consumed in the `authorizeUser` stage, before command dispatch) and `/more` (a special branch at the top of `dispatchNamedCommand`, effective only when the bot menu overflows).

Note: the `TUI_VISIBLE_COMMANDS` of `index.ts` (`tg`, `cwd`, `cd`, `status`, `stop`, `debug`) are also registered with the host. Among them `debug` has the same name as pi's built-in `/debug`; in pi's `onSubmit` the built-in branch matches first, so what runs in the terminal is the pi built-in version. By the priority below, `/debug` on Telegram also goes to the host built-in version, consistent with the terminal.

`pluginOnly` commands are the **only exception** to "all commands are handed to the host to execute": they keep going through the existing `runCommandHandler` (Telegram native UI), because they manage Telegram-side state (bots, bindings, config) and have no matching implementation in the host.

#### 4.2.2 Dispatch priority (replaces the routing logic of `dispatchNamedCommand`)

```
A Telegram command /name args is received:
0. Special cases: /pair (consumed in the authorization stage, never gets here); /more with a menu overflow → existing logic, unchanged
0'. Dialog guard: when the current chat+thread has an active Broker session owned by itself, or has a flow awaiting input
    (deps.ui.hasPendingInput(chatId, thread)):
      name is stop   → cancel the dialog and run /stop (§4.5 rule 6)
      name is status → run normally (read-only)
      otherwise      → reply "Please handle the current dialog first", end
1. name ∈ pluginOnly                 → the plugin's own handler (existing runCommandHandler, unchanged)
2. name hits the terminal-only mapping table (§4.8)    → run the mapping
3. bridge available and (name ∈ hostBuiltin or name is a host extension command/template/skill)
                                       → gateway.submit("/name args", origin)
4. (deleted in v6: no more plugin-native fallback handler, §0.1)
5. otherwise                           → reply "This command needs to be run in the terminal"
```

"Host extension commands" include commands registered by other extensions (for example pi-goal's `/goals` and `/sisyphus`). The few the plugin registers with the host itself are already handled at step 1 and never reach step 3.

The guard at step 0' applies to **all** branches (including `pluginOnly` and the native fallback), because `pluginOnly` commands (for example `ui.select` of `/cwd`) start a Telegram-native input flow, which shares the "latest flow" table with the Broker's external input flow (§4.5.1), and letting both coexist would make them overwrite each other.

The three constants `TUI_NATIVE_SELECTOR_COMMANDS`, `MIRROR_FIRST_COMMANDS`, `HOST_CAPABILITY_COMMANDS` and the logic that routes by command name are deleted (stage 3).

Plain text (not starting with `/`) still goes through the existing `runPrompt` and does not pass through the Gateway. `!`/`!!` bash keeps the existing `runTelegramBash`.

#### 4.2.3 Submit flow

```ts
async function submit(text: string, origin: Origin): Promise<SubmitResult> {
  // 1. The terminal has a dialog open (focus is not on the editor) → reject
  if (focus.classify(focus.current()) !== "editor") return { ok: false, reason: "dialog-open" };
  // 2. A command scope is still unfinished, or this chat has a flow awaiting input → reject
  if (origin.hasActiveCommandScope()) return { ok: false, reason: "busy" };
  if (deps.ui.hasPendingInput(origin.chatId, origin.messageThreadId)) return { ok: false, reason: "input-pending" };
  // 3. Save the draft and open the scope
  const draft = readEditorText();                              // getExpandedText?.() ?? getText()
  const scope = originTracker.beginCommand(origin, text, draft);
  // 4. Execute inside the Telegram turn + host prompt mode UI stack (§4.2.6),
  //    and hold until the enqueued turn chain ends when the agent was originally idle
  const run = () => {
    // Must register before calling: in the streaming/compacting path session.prompt happens synchronously inside onSubmit
    if (gateway.isHostBuiltin(text)) scope.promptDone = true;   // built-in commands do not call session.prompt
    else promptTracker.expect(scope, text);                    // §4.3: extension commands, templates, skills
    // Suppress the "local submit" listener only during the synchronous dispatch; the promise returned by onSubmit is not covered by the suppression
    return withSuppressedLocalSubmit(() => mode.defaultEditor.onSubmit(text));
  };
  scope.submitPromise = runAsTelegramCommand(origin, run);    // not awaited, see below
  scope.submitPromise.finally(() => originTracker.markSubmitDone(scope));
  return { ok: true };
}
```

Key points:

- **Do not call `editor.setText(text)`**. The existing `submitToHost` does `setText(text)` and then submits, which overwrites the local draft; this is an existing bug.
- `withSuppressedLocalSubmit` wraps only the moment of the **synchronous call** (to stop the plugin's own submit from being treated as local input) and must not wrap the whole `await`. Otherwise, during the minutes a command like `/compact` runs, commands the local user types would be missed. After stage 5 deletes the old local-command mirroring (§4.9 item 5), this suppression mechanism can be deleted too.
- Do not call `editor.addToHistory`, to avoid polluting the local input history.
- The caller must not `await` the whole flow: `onSubmit` may hang for a long time (`/compact` takes tens of seconds) and would block Telegram polling.
- When `onSubmit` returns depends on the command. In pi 0.81.1 `setupEditorSubmitHandler`:
  - **await type** (the command has finished when it returns): `/scoped-models`, `/model`, `/export`, `/import`, `/share`, `/copy`, `/clone`, `/login`, `/clear` (i.e. `/new`), `/compact`, `/reload`.
  - **return-immediately type** (returns right after opening a dialog, and the dialog callback completes asynchronously later): `/settings`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/tree`, `/trust`, `/logout`, `/debug`, `/resume`, Easter egg commands.
  - **Extension commands, templates, skills**: when idle, `onSubmit` just hands the text to the main loop and returns; the real execution is in the main loop's `session.prompt` (the row "Execution of extension commands" in §4.1.2). While streaming or compacting, `onSubmit` directly does `await session.prompt(...)`.
  - So the end of a scope cannot be judged by `onSubmit` alone, see §4.3.

#### 4.2.4 Draft protection

The draft `D` is saved before submit (§4.2.3 step 3). **Restoring happens when the scope ends** (not at the end of `submit`), because for return-immediately commands the focus is still on the dialog when `submit` returns.

The local user may start typing after the focus returns to the editor. FocusTracker wraps `editor.handleInput` (an instance hook), and once focus is back on the editor, a single local key press sets `localEdited = true` on the scope. The plugin itself never calls `editor.handleInput`, so this flag represents local input only.

When the scope ends (§4.3), let the current editor content be `E`:

| Case | Handling |
|---|---|
| `localEdited` | Do nothing. The local user is present and already editing; the editor belongs to them |
| `E === D` | Do nothing |
| `E === ""` | `setText(D)` (restore the draft) |
| `E` non-empty and `≠ D` | This is text the host wrote for the initiator (example: after `/fork` selects a message, `this.editor.setText(result.selectedText)` runs, see `showUserMessageSelector` L3814). Per "whoever initiates, displays": send `E` as a message to Telegram (labeled "Text placed in the editor, can be copied, edited and sent"), then `setText(D)` to restore the local draft |

#### 4.2.5 Fallback path

**v6 removes the fallback path.** When `HostCapabilities` shows it is unavailable (the host runs in RPC/print mode, or a host upgrade breaks the hooks), the plugin errors out at startup; the `off` mode is not kept, and the Telegram native implementation (the parts of `lib/commands/*` that redo host functionality, the matching native dialog flows in `telegram-ui.ts`, `custom-dialogs.ts`) is deleted in tasks D1–D4 (§0.1).

#### 4.2.6 Holding enqueued turns

Extension commands such as pi-goal's `/goals` and `/sisyphus` put an agent turn into the queue through `pi.sendUserMessage` and return immediately; the dialogs that really pop up (`goal_question`, `propose_goal_draft`, `goal_questionnaire`) come in a later turn. The existing approach of `runCommandHandler` is: if the agent is idle when the command arrives (`ctx.isIdle()`), after the handler returns it loops waiting with `ctx.waitForIdle()`, waits another 120ms after each idle (longer than pi-goal's 50ms continuation retry interval) to confirm no new turn, and only then ends, keeping `runWithTelegramTurn` + `runWithTelegramUi` throughout.

**In the new plan, extension commands are handed to the host through `editor.onSubmit` and no longer pass through `runCommandHandler`, so this holding logic would be skipped. It must be handled like this:**

1. Extract the holding logic from `runCommandHandler` into a shared function `holdThroughEnqueuedTurns(ctx, wasIdle)`, called by both `runCommandHandler` and the Gateway.
2. The Gateway's `runAsTelegramCommand` borrows the **holding logic** of `runCommandHandler`, but with a **different UI mode**:
   - When `runCommandHandler` calls `runWithTelegramUi` it does not pass `observePrompts`, so it uses the default `createRoutedTelegramUi`, and the extension's `ctx.ui.select/confirm/input` go through the Telegram native UI. This is the behavior `pluginOnly` commands and `off` mode need, and is unchanged.
   - The Gateway must have prompts handed to the **host UI** to draw, taken over by the Broker. Change the `observePrompts?: () => void` parameter of `runWithTelegramUi` to `uiMode: "telegram-native" | "host"`: `"telegram-native"` uses `createRoutedTelegramUi`; `"host"` uses `createHostPromptUi` as simplified in §4.9 (renamed from `createPromptObserverUi`).
   - Code: `runWithTelegramTurn(turn, () => runWithTelegramUi({ session, ui, turn, uiMode: "host", run: async () => { await run(); await holdThroughEnqueuedTurns(ctx, wasIdle); } }))`, with `wasIdle` read before submit.
   - `runPrompt` / `runMainDelivery` (plain text) likewise pass `uiMode: "host"` in `on` mode, and `"telegram-native"` in `off` mode.
3. During the hold, dialogs belong to that chat by §4.3 rule 2 (top of the Telegram UI stack).
4. Host built-in commands (`/model`, etc.) go through the same wrapper: for commands that produce no turn, `holdThroughEnqueuedTurns` finds the agent idle throughout and ends immediately, at no extra cost.

Acceptance (stage 2): send `/goals <topic>` from Telegram, and when the agent calls `propose_goal_draft` Telegram receives confirmation buttons (consistent with the capability the README advertises today).

### 4.3 OriginTracker (who this operation belongs to)

```ts
type Origin = { chatId: number; messageThreadId?: number; sourceMessageId?: number };

type CommandScope = {
  id: string;                     // auto-increment, base36
  origin: Origin;
  label: string;                  // for example "/model"
  draft: string;                  // §4.2.4
  localEdited: boolean;
  submitPromise?: Promise<void>;
  submitDone: boolean;            // submitPromise has ended (including holding)
  promptExpect?: { text: string; startedAt: number; quietSince?: number };   // the session.prompt being waited for
  promptPromise?: Promise<unknown>;                  // the session.prompt that was matched
  promptDone: boolean;            // not matched, or the matched prompt has ended
  lastOutputAt: number;
  telegramMessageId?: number;     // the Telegram message the scope reuses
};
```

The ownership of dialogs and output is judged in order:

1. **An active command scope** → belongs to that scope's chat.
2. **The Telegram UI stack is non-empty** (the top of `telegramUiStacks.get(runner)` in `controller.ts` has an entry) → belongs to the `turn.chatId/messageThreadId` of the top entry. This covers ordinary agent turns initiated from Telegram and the holding period of §4.2.6. The UI stack, not `getCurrentTelegramTurn()` (AsyncLocalStorage), is used because the host's dialog callbacks do not necessarily run inside the plugin's async context, while the UI stack is global state, and the existing goal dialog routing relies on exactly this. For this the controller needs to export a read-only function `getTopTelegramTurn(runner)`.
3. **Neither** → locally initiated: not pushed to Telegram. The Broker still records the session (the step 0' guard and the focus check of §4.2.3 step 1 reject Telegram submits on that basis), but sends no message.

"Same owner" is always compared by `chatId + messageThreadId`, not by `Origin` object reference.

**The second completion signal: matching `session.prompt`.** For an extension command on the idle path, the handler may not have started when `onSubmit` returns (§4.2.3). Rules:

- **Register only for non-built-in commands** (extension commands, templates, skills; judged by `hostBuiltin` of §4.2.1). Built-in commands set `promptDone = true` directly on submit without waiting, and the scope can go straight to judging the other end conditions.
- Instance hook on `mode.session.prompt` (re-wrapped by the tick when the session is replaced).
- **Register first, then call `onSubmit`** (§4.2.3). In the streaming and compacting paths, `onSubmit` calls `session.prompt` synchronously inside, and registering later would miss it.
- After registration, the first `session.prompt` call whose argument (trimmed of leading and trailing whitespace) equals `text` is the one caused by this submit: record its promise in `promptPromise`, and set `promptDone = true` when it ends.
- **The expiry condition is not a fixed time**: the main loop may be busy (finishing the previous round, `pendingUserInputs` queued), and the text only becomes `session.prompt` after the loop returns to `getUserInput`, taking an uncertain time. When there is no match, only when the following three points **hold continuously for 500ms** is it decided that "it will not come" and `promptDone = true` is set:
  - the session is idle (`isStreaming` and `isCompacting` are both false);
  - `mode.pendingUserInputs` is empty;
  - the main loop is parked at `getUserInput` (`mode.onInputCallback` is set).

  `quietSince` records the time at which these three points started to hold simultaneously, and is cleared when any one stops holding. A 60-second cap is also set, to prevent waiting forever if host fields change (a warning is logged when the cap triggers). These three fields are private fields of pi 0.81.1 (L2817-2826). **OMP 18.12.5 (stage 0 probe)**: `session.isStreaming`/`isCompacting` are accessors and `mode.onInputCallback` exists, but there is **no** `mode.pendingUserInputs`; OMP starts counting `quietSince` only when `onInputCallback` is a function and both of the first two accessors are false, ends after 500ms of continuous holding, and also has a 60-second cap. When the fields cannot be read, it falls straight back to the 60-second cap.

**End conditions of a command scope** (all must hold):

- `submitDone && promptDone`;
- the Broker has no active session;
- the current focus is classified as `editor`;
- more than `IDLE_MS = 1500` since the last output.

This way, long await-type tasks (`/compact`, `/share`, `/new`) are covered by `submitDone` and their completion output is not lost; extension commands are covered by `promptDone`; return-immediately dialog commands (`/settings`, `/resume`) are covered by "has an active session"; and multi-step dialogs (where `/login` briefly returns to the editor between "auth method → provider → input") are absorbed by `IDLE_MS`.

**Safety cap `SCOPE_MAX_MS = 30 minutes`**:

- On timeout, if the Broker still has an active session belonging to that scope, **do not end**; extend by 30 minutes each time (the dialog is still open, which means the user may still act).
- Only when there is no active session is the scope force-ended: release the scope, **skip draft restoration** (the source of the editor content cannot be determined at that point), and log a warning. The host is not touched.

On normal end, run the draft handling of §4.2.4, then release the scope.

### 4.4 OutputCapture

**Content domain split** (must be followed, otherwise messages are sent twice):

| Content | Sole owner |
|---|---|
| Agent messages, thinking, tool calls and results | The existing `lib/renderer.ts` (through events such as `agent_start`, `tool_execution_*`, `message_end`). The `AssistantMessageComponent` and `ToolExecutionComponent` that the host adds to `chatContainer` during a turn (L2330, L2406, L2663, L2700) are **never intercepted** |
| Host status, errors, warnings (`showStatus`/`showError`/`showWarning`), including status the host converts from an extension `notify` | OutputCapture |
| Other chat-area content produced by commands (for example the info block of `/session`, `/changelog`, the compaction summary) | OutputCapture, but only under the conditions in the table below |

Interception rules:

| Source | When intercepted | Conversion |
|---|---|---|
| `showStatus(msg)` | Attributed to Telegram (§4.3 rule 1 or 2) | Plain text. pi updates the previous status in place (`showStatus` L2563-2570), and consecutive statuses within the same scope edit the same Telegram message |
| `showError(msg)` / `showWarning(msg)` | Same as above | Add a `❌` / `⚠️` prefix |
| `chatContainer.addChild(c)` | **All of**: ① there is an active **command scope** (§4.3 rule 1; during a turn attributed only by rule 2 it is not intercepted); ② not inside a chat area rebuild (see below); ③ `c` is not a component rendered by the agent (see below). **Do not pre-filter with `isStreaming`**: in pi's `onSubmit`, branches such as `/session`, `/changelog`, `/debug`, `/name` come before the streaming check (L2248); when these commands are sent from Telegram while the agent is streaming, the host still adds content to the chat area, and it must be intercepted | A string `text` field (Text) → strip color codes; a Markdown component (has the original markdown field) → convert to Telegram HTML with `lib/markdown.ts`; anything else → `c.render(80)` with colors stripped, put into `<pre>`, and split with `splitTelegramText` when too long |

- **Chat area rebuild**: `/resume`, `/fork`, `/new` first call `chatContainer.clear()` and then use `addChild` to add the whole history again. Instance hook on `chatContainer.clear`: after the call set `rebuilding = true`, cleared only at the next macrotask (`setTimeout(0)`); `addChild` during that time is never intercepted. Session history on Telegram is handled by the existing history replay feature, not by OutputCapture.
- **Components rendered by the agent** (excluded if any one holds):
  - `c === mode.streamingComponent`;
  - `c.constructor.name` matches `/MessageComponent$/` (`AssistantMessageComponent`, `UserMessageComponent`, etc.) or equals `ToolExecutionComponent` or `BashExecutionComponent`;
  - `c` has any own field among `lastMessage`, `hasToolCalls`, `toolCallId`.

  Fields checked in pi 0.81.1: `AssistantMessageComponent` has `lastMessage` and `hasToolCalls` and no `message`; `UserMessageComponent` has only `text` and is recognized by constructor name.
  **OMP 18.12.5 (stage 0 probe)**: chat-area components expose only `children`, with no `lastMessage`/`hasToolCalls`/`toolCallId`. The observed agent-rendering constructors are: `qs` (user message), `_Te` (assistant message), `Aw` (tool block), `Ds` (streaming component, and `c === mode.streamingComponent`); `j`/`w` are layout/text primitives that command output also uses, so they cannot be used alone as an exclusion basis. The exclusion rule uses "this group of constructor names + `c === mode.streamingComponent`"; the constructor names are minified and change across OMP versions, and the contract test pins the 18.12.5 set.
- **At most 20 components are intercepted per scope**; the excess is merged into one line "…N more outputs, please see the terminal".

Other rules:

- Ignore components whose rendering is entirely blank lines (`Spacer`).
- Output within the same scope is debounced for 700ms and merged into one message, sent after the scope's Telegram message.
- De-duplication: the hooks of `showStatus`/`showError`/`showWarning` set `inShowX = true` while calling the original method, and `addChild` during that time is skipped.
- Secrets are redacted from the text before sending (§4.7.4).
- For `notify` de-duplication see §4.9 item 1: in `on` mode the Telegram copy is sent only by OutputCapture.

### 4.5 DialogBroker

The terminal has only one focused object at a time, so the Broker maintains only **one** active session.

```ts
type DialogSession = {
  id: string;                       // base36 auto-increment
  generation: number;               // +1 on each Telegram-side redraw
  focus: object;                    // focused object F (session identity)
  root?: object;                    // root component, used only to find the title
  kind: "dialog" | "progress";
  adapter?: DialogAdapter;
  model: DialogModel;
  owner?: Origin;                   // ownership of §4.3; undefined = local, not pushed
  telegram?: { chatId: number; messageThreadId?: number; messageId: number };
  pendingInput?: { flowId: string; secret: boolean; purpose: "input" | "editor" | "search" | "type" };
  keyMap: Map<number, Map<number, string>>; // generation → in-page index → item.key; only the latest 3 generations are kept
  state: "open" | "resolving" | "closed";
  closedBy?: "telegram" | "terminal" | "replaced";
  lastAction?: string;              // used for the summary on close
};
```

State machine:

```
            focus = dialog                Telegram action
  (none) ───────────────▶ open ─────────────────────────▶ resolving ──(focus leaves F)──▶ closed[telegram]
                         │  ▲                              │
                         │  └──(after the action the focus is still F: paging, search, check, setting toggle, submenu)──┘
                         ├──(focus leaves F, not caused by Telegram)──▶ closed[terminal]
                         └──(focus becomes another dialog)────────▶ closed[replaced] → new session open
```

Rules:

1. **Open**: FocusTracker reports a `dialog` focus. Take the associated `EntryInfo` per §4.1.2, ask AdapterRegistry in turn, take the first adapter whose `detect()` is true, and `read()` it to get a DialogModel; if none hits, use SnapshotAdapter. Determine `owner` per §4.3. When `owner` is empty, no Telegram message is sent.
2. **Redraw timing** (changes in the terminal are not synced):
   - After a Telegram-side action the focus is still `F`: `read()` again, `generation+1`, edit the message;
   - The focus changes to another dialog under the same owner: when the owner comes from a **command scope**, the new session edits the same message in place; when the owner comes from a **turn** (§4.3 rule 2), the new session sends a new message (dialogs within a turn are separated by agent output, and editing in place would scramble the message order). See §4.7.3;
   - The session closes (rule 4).
   - The edit rate limit per chat is 1 per second, and no edit if the model is unchanged.
3. **Telegram action** (callback or text input):
   1. First do the focus validation (§4.1.3).
   2. The session is closed or the `sessionId` does not match → `answerCallbackQuery("Already handled in the terminal")`, and remove that message's keyboard.
   3. `generation` is stale → redraw with the latest model and show "The list has changed, please select again".
   4. `read()` again to get the live model, and look up the target in the live list by `item.key` (not by index): if not found → redraw and show "The list has changed", and do not execute.
   5. Found → `state = "resolving"`, `adapter.act(F, action)`, then `ui.requestRender()`, then do a focus validation again to decide whether it is `open` (redraw) or `closed`.
4. **Close** (when the focus leaves `F`, decided by the classification of the new focus, priority from high to low):
   1. **The new focus is another dialog, with the same owner, and the owner comes from a command scope** (for example a multi-step `/login`, where after a Telegram action the host switches straight to the next step) → `closedBy = "replaced"`, **write no summary**, and the new session draws directly on the same message. This holds whether or not the old session is `resolving`. (When the owner comes from a turn this item does not apply; after writing the summary per 2 and 3, the new session sends a separate message.)
   2. The old session is `resolving` → `closedBy = "telegram"`, and the message is changed to "✅ <lastAction summary>" (for secret-type input only "✅ Submitted (content hidden)" is written).
   3. Otherwise → `closedBy = "terminal"`, the message is changed to "Handled in the terminal", and the keyboard is removed.
   - If there is a `pendingInput`, also unregister the text input (§4.5.1).
5. **Timeout**: the Broker has no timeout; the host is responsible (host dialogs have their own `timeout` option). When the session closes, the Telegram-side wait ends with it and does not hang.
6. **`/stop`**: if there is an active session whose owner is that chat, first `adapter.act(F, { type: "cancel" })` (send Esc), then run the original `/stop` logic.
7. **progress session**: only a "Cancel" button (sends Esc to `F`). It has a close flow just like a dialog:
   - When the focus leaves, the message is edited to "✅ Done" ("Cancelled" if cancelled through Telegram) and the keyboard is removed;
   - Inside a command scope, progress uses the scope's message; afterwards a dialog of the same scope reuses this message in place per rule 4.1 (progress counts as a dialog for the "replace" decision);
   - Subsequent output is sent as a new message by OutputCapture.

#### 4.5.1 Routing of Telegram text input

input, editor, search and snapshot "type text" all need to receive the user's next text message. Rules:

- When the Broker enters the awaiting-text state, it registers into the existing input flow table through an interface newly added to `telegram-ui.ts`, sharing the "latest flow per chat + thread" mechanism with `waitInput`. This way the existing call `deps.ui.resolveInput(chatId, rawText, ...)` in the controller's message handling hands the text to the Broker first, and it is not treated as a prompt. Interface:

  ```ts
  // lib/telegram-ui.ts
  registerExternalInput(opts: {
    chatId: number;
    messageThreadId?: number;
    promptMessageId: number;   // the Telegram message id the dialog sits in (DialogSession.telegram.messageId)
    sensitive: boolean;
    onText(text: string): void;
    onCancel(): void;
  }): { flowId: string; dispose(): void };
  ```

  - `flowId` is allocated and returned by `beginFlow()` inside `telegram-ui.ts`; the Broker only stores it and does not generate it itself.
  - `promptMessageId` is written into the flow record, for the existing `isSensitiveInput` and for locating "reply to a message". It does not change when the dialog message is edited in place into the next step; when the Broker switches to a new message it must `dispose()` first and then register again.
  - External flows have **no timeout**: the `INPUT_TIMEOUT_MS` (10 minutes) timer is not started. The lifecycle is controlled entirely by the Broker: it is unregistered when the session closes, on `/stop`, or when the Broker calls `dispose()`.
  - The flow record gets a flag `external: true`, on which the controller bases the classification in the table below.
- **Before `resolveInput`**, the controller must first classify the text (applies only when the latest flow of that chat/thread is an external flow registered by the Broker; the behavior of existing `telegram-ui` flows is unchanged):

| Received text | Handling |
|---|---|
| `/stop` | Cancel the dialog (rule 6) and run `/stop`, unregister the input |
| A command in `pluginOnly` (`/tg`, `/status`, etc.) | Run normally, the input keeps waiting |
| Any other `/` command | Reply "A dialog is waiting for input, please reply or cancel first", do not consume |
| Text sent directly (not a reply), or text replying to the dialog's message | Hand to the Broker as input |
| Text replying to **another** message | Not input, handled as an ordinary message (consistent with the matching rule of the existing `resolveInput`: when there is a `replyToMessageId`, only the flow with the same `promptMessageId` matches) |

- Only the same thread is matched; text in other threads is unaffected.
- The plugin side sets no input timeout; the input is unregistered when the host closes the dialog.
- When `sensitive` is true, the user's message is deleted immediately after being consumed (following the existing `isSensitiveInput` + `deleteMessage` approach).
- **Implementation status (corrected after stage 2 testing)**: `registerExternalInput` has not landed yet, and the Broker's awaiting-text state and `waitInput` are still two tables. The controller orders them accordingly: first `deps.ui.resolveInput` (the flow the plugin started in this chat and which is waiting for a Telegram keyboard), then the mirrored dialog (search/input in the table above). This is equivalent to "latest flow first" in the single-table model: whoever asked last gets the answer. Without this ordering a chain failure seen in testing occurs: a dialog left over in the terminal (fields unreadable, only an "Unsupported dialog" snapshot mirror) swallows the user's answer to a secret prompt as a search term, and that prompt then deletes the next `/probe-custom` command as if it were its own answer, so the two steps fail together. Merging into one table (`registerExternalInput`) is still the goal, to be done together with the search routing of T3.6.

### 4.6 DialogModel and adapters

#### 4.6.1 DialogModel

```ts
type DialogItem = {
  key: string;            // identifier stable within the adapter (value/id first; otherwise "index in the full list + label")
  label: string;
  description?: string;
  value?: string;         // current value of a setting item
  current?: boolean;      // the currently effective value (for example the current model)
  checked?: boolean;      // multi-select
  focused?: boolean;      // the row the terminal cursor was on when read
};

type Question = {
  id: string;
  prompt: string;
  items: DialogItem[];
  multi: boolean;
  allowCustom: boolean;   // whether a free-text answer is allowed
  answered: boolean;
};

type DialogModel =
  | { kind: "select"; title: string; items: DialogItem[]; total: number;
      search?: { query: string }; multi?: boolean; extraActions?: { label: string; key: string }[] }
  | { kind: "settings"; title: string;
      items: (DialogItem & { values?: string[]; hasSubmenu?: boolean })[];
      search?: { query: string };
      submenu?: { itemKey: string; model: DialogModel } }          // a submenu is nested state, see §4.6.4 #5
  | { kind: "questionnaire"; title: string; questions: Question[]; active: number; canSubmit: boolean }
  | { kind: "approval"; title: string; detail?: string; options: { key: string; label: string }[] }
  | { kind: "confirm"; title: string; message?: string }
  | { kind: "input"; title: string; placeholder?: string; secret: boolean; prefill?: string }
  | { kind: "editor"; title: string; prefill?: string }
  | { kind: "progress"; text: string; cancellable: boolean }
  | { kind: "info"; title?: string; text: string; closable: boolean }
  | { kind: "snapshot"; title?: string; text: string };

type DialogAction =
  | { type: "choose"; key: string }
  | { type: "toggle"; key: string }
  | { type: "cycle"; key: string; value?: string }
  | { type: "submenu"; key: string }
  | { type: "question"; index: number }               // switch the question in a questionnaire
  | { type: "search"; query: string }
  | { type: "submit"; text?: string }
  | { type: "confirm"; yes: boolean }
  | { type: "approve"; key: string }
  | { type: "key"; name: string }                     // component-specific keys; snapshots allow only up/down/enter/esc
  | { type: "cancel" };
```

`items` is the full (filtered) list, not the one screen currently visible in the terminal. Paging is done on the Telegram side.

#### 4.6.2 Adapter interface

```ts
interface DialogAdapter {
  id: string;
  /** Judge by shape only; instanceof is forbidden. F is the focused object. */
  detect(F: object, ctx: AdapterContext): boolean;
  read(F: object, ctx: AdapterContext): DialogModel;
  /** Returning false means it cannot be executed; the Broker reports the failure and redraws, and does not switch to guessing some other way. */
  act(F: object, action: DialogAction, ctx: AdapterContext): boolean;
}

type AdapterContext = {
  host: "pi" | "omp";
  root?: object;
  entry?: EntryInfo;        // semantic information recorded by the entry hook
  sendKey(name: string): boolean;   // send to F.handleInput
  requestRender(): void;
};
```

#### 4.6.3 Looking down for data: `findShape`

The data is not necessarily on the focused object itself, nor in `children`. Example: the `filteredSessions`, `selectedIndex` and `searchInput` of `SessionSelectorComponent` are all on its field `sessionList`, and `SessionList` is an ordinary class, not a component, and is not in `children` (`class SessionList` in pi `session-selector.js`, L228).

```ts
function findShape<T>(start: object, test: (o: any) => o is T, maxDepth = 3): T | undefined
```

- Starting from `F`, traverse the object's **own enumerable fields** breadth-first (not limited to `children`); for arrays, expand only elements that are objects.
- Use a `WeakSet` to prevent cycles.
- Skip only field names that lead to **host global state**: `tui`, `ui`, `theme`, `keybindings`, `session`, `settingsManager`, `modelRuntime`, `terminal`. Cycles are handled by the `WeakSet`, so `parent` does not need to be skipped. **`editor` is not skipped**: the `editor` field of `ExtensionEditorComponent` is its internal Editor (`extension-editor.js` L42), and generic lookup needs to see it. The main editor is not entered by mistake, because dialog components do not hold it.
- Test `F` itself first, then go down layer by layer.

Shape check examples:

```ts
const isSelectList = (o: any) =>
  Array.isArray(o?.filteredItems) && Array.isArray(o?.items) &&
  typeof o?.selectedIndex === "number" && typeof o?.getSelectedItem === "function";

const isSettingsList = (o: any) =>
  Array.isArray(o?.items) && o.items.every((i: any) => typeof i?.id === "string" && "currentValue" in i) &&
  typeof o?.selectedIndex === "number" && typeof o?.onChange === "function";

const isFilteredList = (o: any) =>
  typeof o?.selectedIndex === "number" &&
  Object.keys(o).some((k) => k.startsWith("filtered") && Array.isArray(o[k])) &&
  (typeof o?.onSelect === "function" || typeof o?.onSelectCallback === "function" || typeof o?.handleSelect === "function");
```

#### 4.6.4 The unified way to operate: set state + send a key to the focused object

Selecting item i:

```ts
list.selectedIndex = liveIndex;      // list is the object found by findShape; SelectList can use setSelectedIndex(i)
F.handleInput("\r");                 // sent to the focused object; the host component's own logic completes the confirmation
ctx.requestRender();
```

- Keys are always sent to `F`, not to `list`. The host component hands the key to its internal list itself (for example `SessionSelectorComponent.handleInput` passes it to `sessionList`, and `SettingsList.handleInput` passes it to `submenuComponent` when a submenu is open).
- Do not call `onSelectCallback(...)` directly, because the callback arguments differ between components.
- Search: first send `ctrl+u` to clear, then `F.handleInput(ch)` character by character. This is the same as how a terminal user operates. Note that `SettingsList` strips spaces from the input (`data.replace(/ /g, "")` in `handleInput`), so a search term with spaces is merged in settings; this is host behavior and is not compensated.
- Before executing, confirm `selectedIndex` is a number and `liveIndex` is in range; if not, return `false`.

#### 4.6.5 Built-in adapter list (by priority)

Field names come from pi 0.81.1. The matching OMP adapters are written from the stage 0 probe results (`docs/host-probe/omp-18.12.5.json`); key conclusion: OMP's extension entry points are in the UI context, and the focused components of built-in selectors have no readable data fields, so on OMP #5-#9 go through snapshot first, and only the entry arguments (#1/#2/#3/#4/#10) can give a structured model.

| # | Adapter | Detection | Read / operate | Covers |
|---|---|---|---|---|
| 1 | `ExtensionSelectAdapter` | `entry.kind === "select"` (pi: `showExtensionSelector`; OMP: `select` of the UI context), or `F` has `options: string[]` + `selectedIndex` + `onSelectCallback` | Title and options come from the entry arguments. The entry of `showExtensionConfirm` is `select(title + "\n" + message, ["Yes","No"])`, recognized as `confirm`. **OMP 18.12.5**: the focused component has no `options`/`selectedIndex` (only `children` or empty), so options must come from the UI context entry arguments; the current cursor can only be confirmed by re-rendering after a key press | Extension `select`, `confirm` |
| 2 | `ExtensionInputAdapter` | `entry.kind === "input"`, or `F` has the Input-shaped fields `input` + `onSubmitCallback` | After `input.setValue(text)`, `F.handleInput("\r")`. `secret` is true only when the entry is explicitly a secret input (pi's `ExtensionUIContext.input` has no secret flag; OMP **has no** `inputSecret`, and the caller's marking is authoritative). **OMP 18.12.5**: the focused component has only `children`/`focused` and no `input` field; the input text can only be sent character by character through `F.handleInput` | Extension `input` |
| 3 | `ExtensionEditorAdapter` | `entry.kind === "editor"` | After the internal editor (field `editor`) `setText(text)`, send Enter to `F`. Verified: Enter submits, Shift+Enter inserts a newline (`extension-editor.js` L46-49). **OMP 18.12.5**: the focused component has only `children`/`focused` and the internal editor is unreachable; input with `F.handleInput` + Enter | Extension `editor` |
| 4 | `AskDialogAdapter` (OMP) | `entry.kind === "ask"` (`askDialog` of the tool UI context) | Outputs a `questionnaire` model: questions and options come from the **first argument** of `askDialog(questions, options)` (the question array, each with `id/question/header/options/recommended`), and the second argument is `{timeout, signal, acceptImages}`. **The focused component of OMP 18.12.5 has only `callbacks`/`options`, and the current tab, cursor and answered state are all in a closure**: the adapter must maintain `active`/`answers` itself and confirm by re-rendering after each operation; switching questions/options is all done with key presses (the probed legend is `Tab/←→` to switch question, `↑↓` to select, Enter to confirm, Esc to cancel) | OMP `ask` tool |
| 5 | `SettingsListAdapter` | `F` has the SettingsList shape (the focus of `/settings` is `getSettingsList()`) | The main list reads `items`/`filteredItems`, `selectedIndex`. **Submenu**: when `activateItem` opens a submenu it only sets the private field `submenuComponent` and does not call `setFocus`, and subsequent keys are forwarded by the same SettingsList (`handleInput`/`activateItem` in pi-tui `settings-list.js`). So a submenu is **nested state within the same session**: when `read()` finds `submenuComponent` non-empty, it uses `findShape` on it to find the SelectList and generates `submenu.model`; operations on the submenu are still sent to `F`. After setting `selectedIndex` of the SelectList inside `submenuComponent`, send `\r` to `F`. If the submenu shape is not a SelectList (for example `ThemeSubmenu` in `settings-selector.js`, which has its own mode state) → the submenu part degrades to a snapshot, offering only ↑↓/Enter/Esc. **cycle**: first confirm the target value is in `item.values` and `item.currentValue` is also in it (otherwise return `false`, for example when the current value is a display label that is not in `values`); compute the key count as `(indexOf(target) − indexOf(current) + n) % n`, select the item and send `\r` that many times; finally re-read to confirm `currentValue` has changed. **OMP 18.12.5**: the focused component of `showSettingsSelector` (`AU`) has no own fields at all, and the main list/submenu data is unreadable → the whole adapter degrades to a snapshot | `/settings` |
| 6 | `SelectListAdapter` | `findShape(F, isSelectList)` hits | `value/label/description` of `filteredItems`; for operations see §4.6.4. **OMP 18.12.5**: the focused components of built-in selectors (model/session/tree/oauth) have no `items`/`filtered*`/`selectedIndex`, so this adapter does not hit on OMP and hands over to #13 | theme, thinking, show-images and other selectors (pi) |
| 7 | `FilteredListAdapter` (generic) | `findShape(F, isFilteredList)` hits | The label extractor tries in turn `label ?? name ?? title ?? id ?? String(x)`; the current value is compared against the `current*` fields on the component. **OMP 18.12.5**: the data of the built-in model/session selectors is in closures, `findShape` does not hit → snapshot | model (`filteredModels`, `currentModel`), oauth (`filteredProviders`), session (`sessionList.filteredSessions`), scoped-models, tree, the message list of fork (pi) |
| 8 | Dedicated adapters | As needed | — | pi: `ModelSelectorAdapter` (`provider/id`, marks the current model, scope-toggle key), `SessionSelectorAdapter` (session name or first message, time; delete, sort, name filter and other keys are `extraActions`). OMP 18.12.5: the focused components of model/session/tree/oauth have no usable fields, so stage 3 can only provide keys by snapshot first; no new OMP-specific field adapters are added unless a later version exposes fields |
| 9 | `LoginDialogAdapter` | `F` or `root` has the login dialog shape (has `abortController`/`signal` + Input + a login-related entry: `showLoginDialog`, `showApiKeyLoginDialog`) | Input is always `secret: true`. After submit, `LoginDialogComponent` replaces the input box with the text `> value` (`replaceInputWithSubmittedText` in `login-dialog.js`), so **this adapter must not screenshot that dialog**, and the info text must be redacted first. **OMP 18.12.5**: `/login` first goes through `showOAuthSelector` (focus `CF`, only `children`), and no API key dialog was found; OMP's login list is handled by snapshot first in stage 3 | API key and authorization code input of `/login` (pi) |
| 10 | `ApprovalAdapter` (OMP) | `entry.kind === "approval"` (`approve` of the tool UI context) | The entry arguments are the three strings `{full, compact, session}`; the focused component has only `callbacks{onApprove,onDeny}` / `options{fullPrompt, timeout, session, draft}`. The model title/detail take `full`, and the options are decided by the keys the component renders itself (`handleInput` was detected); operations send keys to `F` and do not call `callbacks` directly | OMP `approve` |
| 11 | `CustomGoalAdapter` | See §4.6.6: all three shapes of pi-goal 0.6.x have only `render/invalidate/handleInput` and no fields, recognized by the exception rules | Single question → `select`; confirmation box → `confirm`; multiple questions → `questionnaire`. Completed by sending keys through `F.handleInput`, no longer bypassing `done` | pi-goal 0.6.x |
| 12 | `InfoPanelAdapter` | **Hits only on positive evidence**: pi by a whitelist of known constructors/fields; OMP 18.12.5 registered by an entry-semantics whitelist (`showCommandReport`, `showDebugSelector`, `showUsageDashboard`, `showExtensionsDashboard`, `showAgentsDashboard`), the focused component having only `children`/empty fields | `render(80)` with colors stripped and redacted, as read-only text, with only a "Close" button (sends Esc) | Confirmed read-only panels (pi + OMP entry whitelist) |
| 13 | `UnsupportedAdapter` (v6, replaces `SnapshotAdapter`) | Always true | Does not read the screen; takes only the component type name and the entry title (if any) | Unknown components. Telegram shows only "There is a dialog in the terminal that Telegram cannot handle (<type>), please handle it in the terminal", with only a "Cancel" button (sends Esc) (§0.1 item 3) |

Every adapter needs unit tests (§7.1).

#### 4.6.6 Opaque components: exceptions to principle 2 (only the two in this section)

Background: components that an extension provides through `ctx.ui.custom(factory)` are opaque, and the host does not know their structure. The existing way `custom-dialogs.ts` recognizes pi-goal dialogs is "render to text → regex match" (`detectShape`, `extractConfirmationHeader`, `parseTabBarIds`, etc.), which violates principle 2.

Order of handling:

1. **Structure first.** Stage 0 must probe pi-goal's three custom components (the confirmation box, the `goal_question` single question, the `goal_questionnaire` multi question), recording `constructor.name` and own fields. As long as fields for the questions, options and answering state can be found, write a structured adapter and do not use the exception.
2. **Enable the exception only after proving there are no usable fields**, and all of the following must hold:
   - It applies only to components produced by `custom()` that are known shapes registered in the `CustomGoalAdapter` whitelist (currently only pi-goal's three); custom components of other extensions always go to snapshot;
   - Rendered text may be used only to **recognize the shape and read option text**;
   - All operations are completed by sending keys through `F.handleInput` (for example the number of arrow key presses corresponding to the option index + Enter, or the component's own Tab to switch questions), and **must not** bypass the component and call `done` directly to construct the result as the existing code does;
   - Before sending keys, re-render and re-recognize to confirm the target option is still in its original position; if not, redraw the Telegram message and show "The list has changed";
   - The adapter is bound to the tested pi-goal version range (written in an adapter constant); when the version is outside the range or recognition fails, say so clearly per §0.1 item 3 and do not fall back to a snapshot;
   - The contract test uses the real pi-goal components of that version, and when a pi-goal upgrade changes the text the test fails first.
3. Whether the exception is enabled, and the probe file it rests on, is recorded at the end of this section (to be filled in after stage 0 is complete).

Stage 0 conclusion (2026-10-23, pi-goal 0.6.0): the confirmation box, the `goal_question` single question and the `goal_questionnaire` multi question are all returned by `ctx.ui.custom` as the **same Object shape**, whose own fields are only `render`, `invalidate`, `handleInput`; the questions, options, current tab and answered state are all in the factory closure, and the probe found no readable structured fields. The `render(80)` of the three shapes is recorded in `conclusions.piGoal` of `docs/host-probe/pi-0.81.1.json`.

Therefore **exception 1 (pi-goal) is enabled**, with the conditions narrowed to:

- The whitelist contains only these three shapes of pi-goal `0.6.x`; the confirmation box is recognized by the title `Confirm Goal Draft` / `Confirm Sisyphus Goal Draft` (single/multi questions do not have this title), and single vs. multi questions are told apart by the number of questions in the rendered text and the tab bar.
- Rendered text is used only to recognize the shape and read title/option text; the current cursor, answered state and current tab are maintained by `CustomGoalAdapter` itself, and after each operation it re-renders to confirm the target is still in its original position.
- All operations send keys through `F.handleInput` (↑↓ to select, Enter to confirm, Tab/←→ to switch question, Esc to cancel), and **do not call `done`**.
- Version not `0.6.x`, expected title/options not found in the rendering, or the re-rendered result inconsistent with the model → hand to `UnsupportedAdapter` to say so clearly (§0.1 item 3).
- The contract test always uses the real pi-goal 0.6.0 components; when an upgrade changes the text, the test fails first.

**Exception 2: locating the current row of an OMP entry dialog (enabled 2026-10-24; superseded by §4.11, kept for the transition period, deleted by T3.2g)**

Background: in OMP 18.12.5 the extension `select`/`input`/`editor` and `askDialog` components keep rows and cursor in private fields and their class names are minified, so they cannot be read by field (§9 decisions 28, 35, 36).

Conditions of use (use only if all hold, otherwise fall back to `SnapshotAdapter`):

- Only for OMP dialogs that have an entry record (`EntryInfo`). The question, title and option text are **always taken from the entry arguments**.
- The rendered frame (`render(80)` with colors stripped) is used for only two things: determining the currently highlighted row and determining the rows visible on the screen. Option text or any state value **must not** be read from the frame (except the key legend of `approve` below).
- All operations send keys through `F.handleInput`. Re-render before the keys, confirm the target row is still in the visible rows, and compute the step count by the visible rows; if they do not match, refuse the operation and redraw the Telegram message.
- Bound to the OMP version range `18.12.x` (written in an adapter constant); when the version is outside the range or cannot be determined, fall back to snapshot.
- The contract test always uses the real frames of OMP 18.12.5 (`conclusions.dialogFrames` of `docs/host-probe/omp-18.12.5.json`); when an OMP upgrade changes the frame format, the test fails first.
- The only text allowed to be read from the frame: the key legend in the footer of the OMP `approve` dialog (§4.6.5 #10), used to determine which options can be pressed; it is subject to the same version limit.
- **Must not** be used for OMP built-in selectors (components opened by `show*Selector` such as `/model`, `/settings`, `/resume`, `/tree`, `/login`), which still go through snapshot per §9 decision 18. Lists the plugin itself pops up through `ui.select` (for example Telegram's `/model` on OMP, handled by `lib/commands/model.ts`) are entry dialogs and fall under this exception.

### 4.7 TelegramDialogRenderer

#### 4.7.1 Callback data format

Telegram callback data is limited to 64 bytes. **All dialogs (including snapshots) use a new prefix uniformly**:

```
tgplus:dlg:<sessionId>:<generation>:<op>[:<arg>]
```

- `sessionId` and `generation` use base36.
- `op`: `c` (choose), `t` (toggle), `v` (cycle, arg = value index), `m` (submenu), `q` (switch question, arg = question index), `p` (page, arg = page number), `s` (search input), `y`/`n` (confirm), `a` (approval, arg = option index), `i` (text input), `k` (key, arg = key name), `x` (cancel).
- The arg of choose/toggle is the **in-page index**, which the server maps back to `item.key` through `session.keyMap[generation]`, so the callback length is independent of the key length.
- Add `encodeDialogCallback` / `decodeDialogCallback` in `lib/callback-protocol.ts`, with a unit test asserting that no combination exceeds 64 bytes.
- The old prefix `tgplus:tui:` is still handled by the old mirroring code during the transition; after stage 5 deletes mirroring, any old-prefix callback is answered with "This button has expired". Reason: old callbacks have no session identity, and after a process restart or a dialog change they would act on the wrong component.

#### 4.7.2 Layout of each type

| kind | Body | Keyboard |
|---|---|---|
| select | `<b>Title</b>`, with `🔍 term` appended during search, `Page x/y · n items total` | One row per item: `▸` (the terminal cursor when read) + `✓` (current value) + label (truncated to 45 characters); 10 items per page; `◀ Previous` `Next ▶`; `🔍 Search` `Cancel`; `extraActions` at most 3 per row |
| select (multi) | Same | `☑/☐` before each item, and `⏎ Submit` at the bottom |
| settings | `<b>Title</b>`, each item "label: current value" | One button per item; items with 2 values toggle directly; items with more than 2 expand into a value list (edited in place, with "Back"); items with a submenu enter the submenu view (shows `submenu.model`, with "Back", and "Back" sends Esc) |
| questionnaire | Title + current question + completion state of each question (`✓`/`·`) | A question-switch row `◀ Previous question` `Next question ▶`; the options of the current question (single/multi choice same as select); `✏️ Type my own` when `allowCustom`; `⏎ Submit all` when `canSubmit`; `Cancel` |
| approval | Title + detail | One button per option |
| confirm | Title + message | `✅ Yes` `❌ No` |
| input / editor | Title + placeholder/prefill (`<pre>`), with the prompt "Send a message directly as the input" | `Cancel` |
| progress | `⏳ text` | `Cancel` (when `cancellable`) |
| info | Text | `Close` |
| snapshot | Screenshot (`<pre>`) + "Unsupported dialog" | `↑` `↓` `Enter` `Esc` `⌨️ Type` |

#### 4.7.3 Message lifecycle

- Consecutive dialogs and progress within a **command scope** edit the same message in place (for example the multiple steps of `/login`); output (OutputCapture) is sent as subsequent new messages.
- After a session closes, the message is changed to a summary and the keyboard is removed.
- Dialogs within a **turn**: each dialog sends a new message, replying to the user message that triggered the turn (`TelegramTurn.sourceMessageId`).
- `▸` only shows the cursor position at read time and is not updated by terminal operations.

#### 4.7.4 Secret handling

- Sources: `LoginDialogAdapter` (fixed `secret: true`); input that the host entry explicitly marks as secret (including input started through the UI context's `inputSecret` during a Telegram turn, if the host provides that method). Do not guess from title keywords.
- Delete the message immediately after the user replies; do not log the content.
- The original text is stored in `SecretStore`, a **secret table per chat + thread** (so that secrets entered during a Telegram turn are covered too). Each record is kept for 24 hours; when that chat runs `/new` its records are cleared; they are discarded when the process exits and are not written to disk.
- **Secrets shorter than 8 characters are not registered** and do not take part in replacement. Replacing a short string (for example `b`) globally would hurt normal text. API keys and authorization codes are far longer than this.
- **Replace at the source, not at the transport layer.** The transport layer receives already escaped, converted HTML and a separate `richMarkdown`: when a secret contains `& < > "` they have become entities in the HTML and an exact match misses; replacing on HTML may also break tags. So replacement must happen on the **original text before conversion to HTML**, with each send source calling `SecretStore.redact(chatKey, text)` itself:
  - OutputCapture: the intercepted original string, before conversion to HTML/Markdown;
  - Broker: summaries, info text, snapshot text, before rendering;
  - `lib/renderer.ts`: assistant text, thinking, tool arguments and output, before the Markdown → HTML conversion (and also applied to the original markdown of `richMarkdown`).
  - The transport layer does **no** replacement.
- The summary only says "✅ Submitted (content hidden)".
- Limitations (to be written in the README):
  - Only strings **identical** to the input can be replaced; when the agent transforms a secret (truncates, encodes) before outputting it, it cannot be recognized;
  - Once a secret has entered the session history (for example the agent wrote it into an answer), it is not replaced when brought out again after 24 hours or after `/new`;
  - Paths that do not go through the three send sources above (for example send code added in the future) must call `redact` themselves.
- This is fixed behavior, with no config switch.

### 4.8 Terminal-only command mapping

Executed at step 2 of the Gateway priority.

| Command | Host behavior | Telegram equivalent |
|---|---|---|
| `/copy` | Copy the last reply to the clipboard | Not submitted. Read the last assistant text in the session and send it directly as a message |
| `/export [path]` | Export to a file, `showStatus("Session exported to: <path>")` | Submitted to the host. Wrap `session.exportToHtml` / `exportToJsonl`, take the **return value** as the file path, and after the command ends send the file to Telegram as a document (reusing the existing attachment sending). The path is not parsed from the output text. The wrapper is a resident instance hook, but **it records the return value only when the current command scope's label is `/export`**: `/share` also calls `exportToHtml(tmpFile)` internally, and that temporary file must not be sent as an export result |
| `/share` | Upload a gist, output a URL | Submit directly, output sent back by OutputCapture |
| `/hotkeys` | Show terminal hotkeys | Not submitted. Send the Telegram usage description generated by the plugin |
| `/quit`, `/exit` | Exit the process | Second confirmation on Telegram (`✅ Confirm quit` / `Cancel`), submitted after confirmation |
| `/debug` | Write a debug file | Submit directly, output sent back |
| `/import` | Import from a file | **Keep the native handler**, do not submit through the editor (§9 decision 21); arguments passed through |
| `/reload` | Reload extensions/skills/prompts | **Keep the native handler** (§9 decision 21) |
| `/fork`, `/clone` | Copy session/branch | **Keep the native handler** (§9 decision 21); the steps that need a selector are taken over by the stage 3 Broker |
| `/new` | Clear the current session | **Call the host `ctx.newSession()`**, do not submit through the editor (§9 decision 22); notify and restore the draft when done |
| External editor (`ctrl+g`) | Open `$EDITOR` | Not supported; an editor dialog can only take input by "sending a message" |
| Easter egg commands (`/arminsayshi`, `/dementedelves`) | Animation | Submit directly, output sent back |

OMP's similar commands are added to the table on the same principle: the default is "submit directly + send output back", and only those that need confirmation or are terminal-bound go in the table. The OMP 18.12.5 built-in registry detected in stage 0 has **87** commands in total (`BUILTIN_SLASH_COMMAND_DEFS`, full list in `catalog` of `docs/host-probe/omp-18.12.5.json`). Classified by behavior:

| OMP command | Host behavior (stage 0 probe) | Telegram equivalent |
|---|---|---|
| `/help`, `/status`, `/usage`, `/stats`, `/context`, `/changelog`, `/debug`, `/skills`, `/plugins`, `/extensions`, `/tools`, `/agents`, `/mcp`, `/plan`, `/session`, `/jobs`, `/todo`, `/memory` | Output information or open a read-only panel (`showCommandReport`/`showDebugSelector`/`showUsageDashboard`/`showExtensionsDashboard`/`showAgentsDashboard`) | **Connected to the Gateway in stage 3**: first implement `InfoPanelAdapter`/snapshot panel interception and send the body back; the only button is "Close". Not connected in stage 1, otherwise it would only reply with an ack (§9 decision 23) |
| `/model`, `/models`, `/switch`, `/modelpreset`, `/effort`, `/settings`, `/theme`, `/thinking`, `/sessions`, `/resume`, `/pin`, `/tree`, `/fork`, `/login`, `/logout` | Open a selector (`showModelSelector`/`showSettingsSelector`/`showSessionSelector`/`showTreeSelector`/`showOAuthSelector`); the probe confirmed these focused components have no readable data fields | Submit directly; in stage 3 `SnapshotAdapter` first provides ↑↓/Enter/Esc, without pretending to be a native list (§4.6.5 OMP conclusion) |
| `/new`, `/fresh`, `/clear`, `/delete`, `/fork` (confirmation), `/cleanse`, `/wt`, `/worktree` | May pop up a confirmation box or require arguments | Submit directly; the confirmation box is rendered as `confirm` per §4.7.2, with "Yes/No" buttons |
| `/copy`, `/open` | Read the last message/link; `/copy` may open `showCopySelector` | `/copy` is not submitted and sends the last assistant text to Telegram directly; `/open` is submitted directly and its output sent back |
| `/export` | Calls `session.exportToHtml(path, false)`, returning a Promise | Submit; wait for the Promise to resolve and send the resolved file as a document (`export-resolved` in the probe file; status text is not parsed) |
| `/share`, `/collab`, `/join`, `/leave`, `/hub` | Network/sharing flows; may have a progress bar | Submit directly, output sent back; the progress bar follows the `progress` model |
| `/quit`, `/exit`, `/restart`, `/reload-plugins`, `/marketplace`, `/ssh`, `/browser`, `/record`, `/live`, `/pause`, `/force` | Terminal/process bound or high risk | `/quit`, `/exit`, `/restart` are submitted after a second confirmation; the rest are submitted directly, arguments passed through |
| Other commands (`/goal`, `/guided-goal`, `/loop`, `/queue`, `/prewalk`, `/advisor`, `/ratchet`, `/computer`, `/skillful`, `/extended-context`, `/fast`, `/slow`, `/shake`, `/handoff`, `/seance`, `/btw`, `/tan`, `/omfg`, `/retry`, `/rename`, `/move`, `/add-dir`, `/remove-dir`, `/dirs`, `/git`, `/branch`, `/forget-approvals`, `/dump`, `/trace`, `/security`, `/setup`) | Mostly state toggles/output/argument commands | Default is submit directly + send output back; those with dialogs go through the Broker by entry kind |

OMP's `showAskDialog` and `approve` are not commands; they come from the `ask` tool and tool approval respectively, and their models are in §4.6.5 #4/#10.

### 4.9 Dialogs inside an agent turn

Current state: during a Telegram turn, `ExtensionUIContext` is replaced with the Telegram native UI (off/commands mode), or `createPromptObserverUi` (full mode).

Changed to (`on` mode, when the bridge is available):

1. During a Telegram turn (and during commands submitted by the Gateway, §4.2.6), `select/confirm/input/editor/custom/askDialog/approve` are **all delegated to the host UI**, drawn by the host in the terminal. The Broker takes over through the focus hook and pushes per §4.3. `createPromptObserverUi` is renamed `createHostPromptUi` and simplified to:
   - Prompt-type methods are passed straight to the host and no longer trigger `startPromptMirror`;
   - **`notify` is passed only to the host and no longer also calls `telegramUi.notify`.** The host converts `notify` into `showStatus`/`showError`/`showWarning` (`showExtensionNotify` L1891), which OutputCapture sends to Telegram by ownership. This way there is only one send path and nothing is sent twice. (`createRoutedTelegramUi` in `off` mode is unaffected.)
   - Editor-type methods (`pasteToEditor`, `setEditorText`, `getEditorText`) do nothing during a Telegram turn (inheriting principle 3 of the old document).
2. Delete `startPromptMirror` and `promptMirrorHook`; the parameter of `runWithTelegramUi` becomes `uiMode` (§4.2.6).
3. `custom()`: the host produces the component and gives it focus, and the Broker takes over as usual; if it cannot be recognized, say so clearly per §0.1 item 3. It no longer returns `undefined` directly.
4. (Deleted in v6: when the bridge is unavailable the plugin errors out at startup, and there is no `off` mode, §0.1.)
5. **Delete local command mirroring.** The existing `bridge.onLocalSubmit` subscription (the `unsubscribeLocalTui` section in the controller) pushes the `/` and `!` commands the local user types in the terminal, together with a screenshot of their results, to the active chat, which violates "whoever initiates, displays" (§9 decision 1). In `on` mode this subscription is no longer registered; `off` mode never pushed (that subscription returns directly under `off`). Delete the matching "local-command mirror" wording and cases in the README and E2E accordingly.

### 4.10 Configuration

Values of `tuiBridge`:

| Value | Meaning |
|---|---|
| `on` (default) | The architecture of this plan |
| `off` | **Deleted in v6** (§0.1 item 4): the `tuiBridge` config item is deleted entirely, and when an old config is read it is ignored and a note is logged once |

Old value migration: unset, `commands`, `full` → `on`. The migration is written in the read logic of `lib/config.ts` and does not rewrite the config file until the user next saves in `/tg → Config`.

**This is an intentional behavior change**: users who never changed the config (the original default was `commands`, with read-only interactive dialogs) get operable dialogs and the shared "whoever initiates, displays" behavior directly after upgrading. It must be listed separately as a "behavior change" in `CHANGELOG.md`, and the matching paragraph in the README must be updated.

No other config items are added.

The `/tg → Config` menu (where `config.tuiBridge` is read in `lib/commands/tg-menu.ts` and `lib/commands/tg-config.ts`) keeps only `on`/`off`.

**v6: the `off` mode and the `tuiBridge` config item are deleted** (task D1), and the matching option in the `/tg → Config` menu is deleted with them.

---

### 4.11 OMP structured channel (v5, 2026-10-24)

Basis: the OMP 18.12.5 source (MIT, local read-only copy `/Users/jaly/Documents/project/research/oh-my-pi-18.12.5`) and three feasibility checks on 2026-10-24 (S20 read structure, S21c structured operation, S22 collab request). OMP ships two sets of structured interfaces: **collab** (remote guests answering dialogs) and **TSP** (a component describes itself as a semantic tree and receives structured events). Dialogs on OMP always go through these two channels or output interception, and **no longer read the screen and no longer simulate key presses**. The pi side is unaffected.

#### 4.11.1 Channel assignment

| OMP dialog | Channel | Read | Operate |
|---|---|---|---|
| Extension `select`, `confirm`, `input`, `editor`, `askDialog`, `approve` | Extension UI race (§4.12, v7 replaces collab) | Call arguments | Whichever side answers first wins and the other side is closed |
| Extension `custom`; built-in selectors and dashboards (`/model`, `/settings`, `/login`, `/resume`, `/tree`, `/agents`, etc.) | TSP | The `describe(cx)` semantic tree of the focused component or its child components | `handleNativeEvent(event)`: `select`, `activate`, `action` (`confirm`, `close`, `submit`, `cancel`, etc.), `change`, `edit` |
| Reports (`showCommandReport`) | Output interception (§4.4, S17/S19) | Entry argument `title` + `body` rendering | — |
| Components without `describe()` | `UnsupportedAdapter`: explicit notice + cancel (decision 47) | — | Cancel = Esc |

#### 4.11.2 collab bridge (void in v7)

Replaced by the §4.12 extension UI race (decision 53). S22 proved collab works, but the race does not occupy `mode.collabHost`, so there is no need to yield when the user opens `/collab` themselves, and pi and OMP share one approach.

#### 4.11.3 TSP adapter (`TspAdapter`)

- **Recognition**: a focused component or one of its child components (`children`, depth ≤ 4) that has both a `describe` and a `handleNativeEvent` method → `TspAdapter`, which takes priority over the other adapters on OMP.
- **Context**: `cx = { cols: 80, reduceMotion: true, dark: true, hour12: false, supports: () => true, feature: () => false }` (enables the picker form).
- **Read**: the semantic tree is converted into a `DialogModel`: `picker` → select (items, selected item, available actions); `prefs` → settings; card + list → select; form/input → input; everything else → info (read-only text + close). The traversal must guard against circular references; objects among child nodes that are not a `NativeNode` are ignored.
- **Operate**: button actions are converted into `NativeUiEvent` (example: option → `{ type: "select", key: "picker", item }`, confirm → `{ type: "action", key: "picker", act: "confirm", mods: [] }`, close → `act: "close"`). Until T3.2f verifies the `edit` event, text input keeps using the existing input path (write the value, then submit).
- **Refresh**: re-`describe()` after each operation; changes on the terminal side trigger a re-read through focus events and redraws.
- **Version**: see §4.11.4.

#### 4.11.4 Version constraint: fail on mismatch, no degradation

- collab and TSP are both OMP internal interfaces, and the structured channel supports only OMP `18.12.x` (the version is taken from `VERSION` of `@oh-my-pi/pi-utils`).
- **When the version does not match or cannot be read: fail directly, and do not fall back to any other approach** (no screen reading, no mirroring, no simulated keys). At startup the plugin says clearly in the status bar and in Telegram "Unsupported OMP version <x>, 18.12.x is required", and OMP dialogs are not bridged to Telegram (decided by the user on 2026-10-24: "if the version is wrong just fail, don't do multiple sets").
- To support a new version: pull the OMP source of the matching tag to check the interfaces, get the dialogs and commands suites passing, and only then widen the version range.

#### 4.11.5 What is superseded

- §4.6.6 exception 2: after OMP's select, confirm and approve move to collab/TSP, delete the matching code (`OMP_FRAME_VERSIONS`, `frameRows`/`frameCursor` on the OMP path, reading the key legend for approve). Kept during the transition and deleted by T3.2g.
- Decision 18 is void; the parts of decisions 25, 28, 35, 36 about recognizing and operating OMP by focus/by screen are superseded. Decisions 30 and 40 (distinguishing progress from loader) are unaffected.
- The broker remains the sole hub for sessions and Telegram rendering; the session source is extended from "focus change" to "focus change + race request" (§4.12). The adapters left on OMP are only: the race model, `TspAdapter`, `infoPanelAdapter` (dashboards without `describe()`) and `UnsupportedAdapter`.

### 4.12 Extension UI race (v7, 2026-10-25, shared by pi and OMP)

Basis: measurements in S25 (OMP, pi) and S25b (pi), and `ExtensionUIDialogOptions.signal` in pi 1.4.0 `core/extensions/types.ts` ("AbortSignal to programmatically dismiss the dialog"). After the host receives an abort it closes its own dialog and the original call ends with `undefined`.

- **Methods that support the race**: in pi 1.4.0 these are `select`, `confirm`, `input` (`editor` does not accept `opts`); in OMP 18.12.x they are `select`, `confirm`, `input`, `editor`, `askDialog`, `approve`. Methods that do not accept a signal (pi's `editor`, and `custom` on both hosts) do not race and are handled by the existing adapters (`custom` is reported clearly per §4.6.5, with pi-goal taking exception 1).
- **Interception point**: the UI context object the extension actually gets (`extensionRunner.getUIContext()`, where FocusTracker's `attachEntryHooks` already hooks the entries).
- **Ownership**: follows the broker's ownership rules (§4.3): only dialogs inside a Telegram-initiated command scope or Telegram turn are sent to Telegram (whoever initiates, displays; decision 42 is kept).
- **Flow**:
  1. Call the host method with the caller's signal plus the plugin's own `AbortController` (`AbortSignal.any`); the terminal draws the dialog as usual;
  2. The host draws the dialog as usual, and the broker creates a session through the focus change as usual (one dialog has only one session); the model comes from the entry arguments (title, options, prompt text);
  3. Telegram answers first → the adapter no longer simulates key presses, but hands the value directly to the caller through the race handle, then aborts the host (the `undefined` the host returns is discarded);
  4. The terminal answers first → resolve with the host's value, and the broker withdraws the Telegram keyboard and writes the summary as usual;
  5. The caller's signal aborts first → the host closes the dialog, and the call ends with the host's result;
  6. The race handle hangs on the entry record (`EntryInfo.race`) and is registered by the outermost race wrapper before the host method is called; locally initiated dialogs also have a handle, but only Telegram's buttons use it, so terminal behavior is not changed.
- **Measured conclusion**: on both hosts the plugin's answer reached the extension, the host dialog closed about 2ms after the abort, and the subsequent input, secret, custom and ask steps passed as usual. In S25 pi's confirm step failed, and S25b found the cause was the test script: `clearDialog()` sent two Escapes within about 400ms, which, when the pi editor is empty, triggers the double-Escape action (`doubleEscapeAction`, default `tree`, pi 1.4.0 `interactive-mode.ts` lines 3036–3050) and opens the Session Tree; commands sent afterwards were rejected by the plugin by design ("There is an unfinished dialog in the terminal"). A baseline run without the race also opened the Session Tree 6 times, but the timing did not block the later steps. The first 3B task fixes the test script: write `doubleEscapeAction: "none"` in the agent settings used by the tests.

## 5. List of file changes

### New

| File | Content |
|---|---|
| `lib/tui/host.ts` | `wrapMethod`, mode capture (migrated from `tui-bridge.ts`), `HostCapabilities`, reinstallation of instance hooks |
| `lib/tui/focus.ts` | FocusTracker, focus classification, focus validation timer, local editor input marker |
| `lib/tui/origin.ts` | OriginTracker, CommandScope |
| `lib/tui/gateway.ts` | Dispatch priority, submit, draft protection, terminal-only mapping, `runAsTelegramCommand` |
| `lib/tui/output.ts` | OutputCapture, redaction |
| `lib/tui/broker.ts` | DialogBroker, external text input registration |
| `lib/tui/model.ts` | Types |
| `lib/tui/find-shape.ts` | `findShape` and shape checks |
| `lib/tui/adapters/*.ts` | The adapters of §4.6.5, with `index.ts` defining the registration order |
| `lib/tui/render-telegram.ts` | Renderer |
| `lib/tui/snapshot.ts` | Snapshot fallback |
| `lib/tui/probe.ts` | Stage 0 probe |
| `lib/__tests__/tui-*.test.ts` | §7 |

### Modified

| File | Change |
|---|---|
| `lib/controller.ts` | Extract `holdThroughEnqueuedTurns` (§4.2.6); change the `observePrompts` parameter of `runWithTelegramUi` to `uiMode`, rename `createPromptObserverUi` to `createHostPromptUi` and change it per §4.9 (`notify` goes only to the host); in `on` mode no longer register the `bridge.onLocalSubmit` subscription (§4.9 item 5); export `getTopTelegramTurn`; change `dispatchNamedCommand` to §4.2.2; in message handling add the §4.5.1 classification before `resolveInput`; add `tgplus:dlg:` to callback dispatch; stage 5 deletes the mirroring code (`TuiMirror`, `refreshTuiMirror`, `startPromptMirror`, `promptMirrorHook`, `runTuiCommand`, `runTuiCommandInner`, `buildSelectorKeyboard`, `formatSelectorMessage`, `tuiKeyRows`, `advertisedKeys`, `formatTuiSnapshot`, `trimScreenChrome`, `snapshotLinks`, `hasInputPrompt`, `handleTuiCallback`, and the three command-set constants) |
| `lib/telegram-ui.ts` | Add `registerExternalInput` (§4.5.1) |
| `lib/renderer.ts` | Call `SecretStore.redact` before conversion (§4.7.4) |
| `lib/tui/secrets.ts` (new) | `SecretStore`: register, clear per chat, `redact` |
| `lib/tui-bridge.ts` | From stage 1 the content migrates to `lib/tui/host.ts` and `lib/tui/snapshot.ts`, and this file keeps only re-exports for callers not yet migrated; **deleted in stage 5** |
| `lib/callback-protocol.ts` | dialog callback encoding/decoding |
| `lib/config.ts`, `lib/types.ts` | §4.10 |
| `lib/commands/tg-menu.ts`, `tg-config.ts` | Config menu |
| `index.ts` | Initialization order: `installTuiBridge` → after the mode is captured install the focus/output/submit hooks → Broker starts |
| `README.md`, `CHANGELOG.md` | Description of new behavior and behavior changes; rewrite the paragraph "Interactive modals are Telegram-only during a Telegram turn" and the paragraph "Mirrored dialogs arrive as one Telegram message" |
| `docs/telegram-interactions-plan.md` | Note at the top that principle 1 is superseded by this document and principles 2-4 remain in force |

### Deleted (stage 5)

- `lib/tui-selector.ts` and `lib/__tests__/tui-selector.test.ts`
- `lib/tui-bridge.ts`

---

## 6. Phased implementation

Each stage can be merged separately, keeping `npm run typecheck` and `npm test` passing.

### Stage 0: host probe (must be done before implementation)

Purpose: obtain OMP's real method names, argument shapes and component fields, replacing unverified conclusions such as "found the string in the binary"; also recheck pi's focused objects.

- `lib/tui/probe.ts`: when the environment variable `PITG_PROBE=<output file>` is set:
  - record all method names of `InteractiveMode.prototype` and the own field names of the mode instance and the `mode.ui` instance;
  - wrap all entry methods in the §4.1.2 table, recording the arguments of each call (for objects only field names and primitive values, not large objects);
  - wrap `ui.setFocus` and `showOverlay`, recording for each the `constructor.name` and own field names of the focused object, and the hit result of `findShape`.
- Using the existing tmux + mock E2E environment (`scripts/e2e/`), run all commands in turn on OMP and pi, and trigger one `ask`, one extension `select/input`, and one `approve`.
- Install pi-goal (`@capyup/pi-goal`), use the mock provider to trigger in turn the confirmation box, `goal_question` and `goal_questionnaire`, record the fields of these three custom components, and fill in the conclusion of §4.6.6 accordingly.
- Additionally record: OMP's default editor field name, how the current focus is read, the main-loop related fields (matching pi's `pendingUserInputs`, `onInputCallback`), and the constructor names and fields of agent-rendered components in the chat area.
- Produce `docs/host-probe/omp-18.12.5.json` and `docs/host-probe/pi-0.81.1.json`, and revise §4.1.2, the OMP part of §4.6.5 and the OMP command table of §4.8 accordingly.
- **Acceptance**: the two probe files are committed; all OMP-related "to be probed" items in this document have a conclusion.

**Stage 0 execution result (2026-10-23)**: the two files were generated and committed (`docs/host-probe/pi-0.81.1.json`, `docs/host-probe/omp-18.12.5.json`). pi 0.81.1 ran the commands + extension dialogs with `scripts/e2e/run-probe.mjs`, and the three shapes of pi-goal 0.6.0 were run separately; OMP 18.12.5 ran 87 built-in commands, extension `select/confirm/input/editor/custom`, `ask` single/multi question, and `approve`. Key conclusions:

1. **pi focus**: there is no `getFocused()`; `ui.focusedComponent` is a data field that lags by one event; the overlay's `setFocusInternal` receives `{component, overlayFocusRestore}`. The focus event is authoritative.
2. **OMP focus**: `ui.getFocused()` is usable; all dialogs go through `setFocus`.
3. **OMP entries**: extension entries are in the UI context (`select`/`confirm`/`input`/`editor`/`custom`), and the tool context additionally has `askDialog`/`approve`; wrapping only the mode prototype would miss them. The source of the tool context methods has been recorded (the signatures of `askDialog`/`approve`).
4. **OMP built-in selectors are opaque**: the focused components of model/settings/session/tree/oauth have no items/selectedIndex fields (some have only `children` or are empty), so stage 3 can only provide keys by snapshot first; this is the "some dialogs degrade to snapshots" in the §11 risk table.
5. **OMP ask/approve**: ask's questions/options are in the entry arguments and its state is in a closure; approve's entry arguments are `{full,compact,session}`. Both can only be confirmed by key presses + re-rendering, and state cannot be read from fields.
6. **pi-goal**: all three shapes are Objects of `{render,invalidate,handleInput}` with no fields; the exception in §4.6.6 is enabled narrowed to 0.6.x.
7. **OMP chat-area components**: only `children`, with minified constructor names; the whitelist is in §4.4.
8. **Export**: `exportToHtml`/`exportToJsonl` return a Promise, and the path is the resolved value, not a synchronous return value.

### Stage 1: infrastructure + output-only commands

- `host.ts`, `focus.ts`, `origin.ts`, `gateway.ts`, `output.ts`.
- The Gateway is enabled only for pi commands on a **static whitelist**: the commands in the "output only" part of Appendix A that can be submitted and do not replace the runtime. Commands off the whitelist still go through the old path (including old mirroring). Commands on the whitelist **never** enter `runTuiCommand`. `/new` goes through `ctx.newSession()`; `/reload`, `/fork`, `/clone`, `/import` keep the native handlers (§9 decisions 21, 22). OMP's similar commands are connected in stage 3 (§9 decision 23).
- This stage does not instantiate the Broker; FocusTracker serves only the scope-end judgment and OutputCapture. While the old and new hooks coexist, the new hooks are passive (observe only, send no Telegram dialog messages), and the dialog screen is still handled by the old mirroring.
- Fix the draft overwrite problem (for whitelisted commands).
- **Acceptance**: on pi, `/session`, `/compact`, `/name x`, `/new`, `/changelog`, `/share`, `/export` run from Telegram give the same host state as running in the terminal, the output is sent back in full (including the result after `/compact` completes), and the local draft is not lost. **OMP's similar commands are not in this stage's acceptance scope and move to stage 3.**

### Stage 2: Broker + extension dialogs

- `broker.ts`, `model.ts`, `render-telegram.ts`, `find-shape.ts`; adapters 1-4, 10, 11, 12, 13.
- Extraction and hookup of the holding logic of §4.2.6; the text routing of §4.5.1; §4.9.
- **Acceptance**:
  - mock provider triggers `ask` (the existing E2E scenario) and extension `select/confirm/input`: answered from Telegram and from the terminal respectively, the other side closes automatically in both cases, and the answer the agent gets is the same;
  - sending `/goals <topic>` from Telegram, the confirmation of `propose_goal_draft` appears in Telegram;
  - OMP `ask` multi-question can be fully answered from Telegram (going through the plugin's original Telegram answering path is enough; brokering is in T3.0 and §9 decision 25).


**Measurements (2026-10-24, `npm run test:e2e:dialogs`, the README describes this suite)**

- pi all green: `select`/`confirm`/`input`/secret/`custom` all go through the broker dialect, either Telegram or the terminal can answer, whoever answers first wins and the keyboard on the other side is withdrawn.
- OMP had never been in the broker dialect before; the root cause is unrelated to §4.6: the host resolves this package into two module instances, and the one that patched first sees the TUI mode while the one serving the chat sees `host: unknown`, so `tuiBridge: full` effectively did not exist for it. Fixed: the capture state is hung on a process-level key and shared (`lib/tui-bridge.ts`).
- Measured after sharing: OMP's confirm/custom become the broker dialect and "terminal answers first" passes; but the select/input/`ask` components render into an overlay and do not take focus, FocusTracker sees only the editor and `progress`, the adapters cannot read the entries, and Telegram is left with only arrow keys. So `hostOwnsPrompts()` was opened only for pi for now, and these OMP dialogs continue to be answered by the plugin in Telegram. Stage 2 closing addition: turning off only `hostOwnsPrompts()` is not enough, because the broker still tracks and takes over interaction on OMP (the commands suite dropped from 132/132 to 119/126, with `/exit` and `/tg-cwd-disconnect` failing), so the broker shares the same host switch with it, and OMP as a whole returns to its behavior before the closing (decision 27).
- The remaining OMP gap = the §4.6 adapters must recognize OMP components. The measured conclusion differs from the original idea: there is no need to guess fields in the overlay subtree. OMP's hook dialogs **do** take focus, and what is missing is ① classification (row labels are in private fields and class names are minified, so shape checks miss) and ② reading (parse the title/rows/`❯` current row from the color-stripped `render(80)` frame). After both landed, the host restriction in `hostOwnsPrompts` was deleted, and OMP and pi share the same switch (decision 28).
- In host mode a command initiated from Telegram gets the **host's own context** (`setUIContext` swaps the runner's UI, and the command context is a proxy of it). UI members unique to the plugin do not exist on the host side, so the proxy must fall back to the plugin implementation: the nested `menu` keyboard (and its inverse `closeMenu`) are plugin controls, and the management interface of `/tg` relies on them to expand level by level in host mode; otherwise `ctx.ui.menu` is `undefined` and the menu disappears.
- The plugin's own management commands (the `/tg` family) have no host component behind them and do not take part in the broker; what host mode changes is only who answers the host components and extension dialogs.
- The entry hooks must go on the **host's UI context**: `attachEntryHooks` originally ran only once when capturing the host, reading "the context installed in the runner at that moment". If the plugin's swap was in effect at that moment, the host's real context was skipped, and afterwards no dialog had an `EntryInfo`, so adapters could only give snapshots (`modelKind:"snapshot"`), and input-type dialogs became a pile of arrow keys with no way to send keys in. Now the proxy exposes `__piTelegramPlusRoutedBaseUi` for unwrapping, and FocusTracker's once-per-second verify tick re-runs the hook (`hookEntryMethods` marks per object, so repeated calls have no side effects).

### Stage 3: lists, settings, login

**v6 split**: stage 3 is split into 3A cleanup and alignment → 3B extension dialogs → 3C OMP built-in selectors → 3D pi built-in selectors → 3E final acceptance, and 3A is split again into 4 checkpoints; see "Stage 3 breakdown" in the task list. The original description below is kept as background.

- Adapters 5-9; switch all commands to the Gateway; delete the three command-set constants.
- **OMP output-only commands connected to the Gateway**: first implement `InfoPanelAdapter`/snapshot panel interception, covering full-screen reports such as `showCommandReport`, `showDebugSelector`, `showUsageDashboard`, `showExtensionsDashboard`, `showAgentsDashboard`; then add `/status`, `/usage`, `/stats`, `/context`, `/changelog`, `/help`, `/skills`, `/plugins`, `/extensions`, `/tools`, `/agents`, `/mcp`, `/plan`, `/jobs`, `/todo`, `/memory` to the OMP whitelist. The panel body must be visible in Telegram and must not reply with only an ack.
- **Acceptance**: `/model` (with search, paging, current value), `/resume`, `/settings` (with value toggling, submenu), `/login` (multi-step, including API key input, with no plaintext appearing in Telegram), `/logout`, `/scoped-models`, `/tree`, `/fork` (editor text sent to Telegram, local draft restored) work on pi and OMP, and the resulting state matches the terminal; **OMP's output-only commands are executed from the Gateway and the panel body is intercepted**.

### Stage 4: terminal-only commands and wrap-up

- The §4.8 mapping table all lands; the snapshot fallback is verified on an unknown component.
- **Acceptance**: the equivalent behavior of `/copy`, `/export`, `/hotkeys`, `/quit`; construct an unknown custom component, and Telegram can see a screenshot and can cancel.

### Stage 5: cleanup

- Delete the old mirroring code, `tui-selector.ts`, `tui-bridge.ts`; the old callback prefix becomes "expired"; config migration; documentation update.
- **Acceptance**: the parity test of §7.2 passes on pi `1.4.0` and OMP `18.12.x`, and the "to be migrated" list is empty (§0.1).

---

## 7. Test plan

### 7.1 Unit tests

- **Fake host** (`lib/__tests__/_fake-host.ts`): a minimal mode object containing `ui` (`setFocus`, `showOverlay`, `hideOverlay`, `requestRender`, `focusedComponent`/`getFocused`, a simulable `setFocusInternal` bypass path), `editor` (`getText`, `setText`, `handleInput`, `onSubmit`), `chatContainer`, `session`, `showStatus`/`showError`/`showWarning`. The command handlers simulate the await type and the return-immediately type respectively.
- **Real component contract tests**: pi's component classes can be imported from `@earendil-works/pi-coding-agent`. Each adapter tests `detect/read/act` with at least one real instance (including the submenu of `SettingsSelectorComponent` and the nested `sessionList` of `SessionSelectorComponent`). For those whose dependencies are too heavy to instantiate, test the field shape and state the reason in the test. Purpose: when a host upgrade changes fields, the test fails first.
- **Focus classification**: editor / inert / progress / dialog; a `setFocusInternal` bypass is found to close by validation.
- **Broker state machine**: Telegram operates first, terminal operates first, a callback arrives after the focus has left, generation expired, not found by key, `/stop`, dialog replaced, submenu nesting.
- **Scope end**: the completion output of long await-type tasks is not lost; the scope does not end during a return-immediately dialog; it does not end when briefly returning to the editor between multi-step dialogs; the 30-minute cap.
- **Draft protection**: one case for each of the four situations in the table of §4.2.4.
- **Text routing**: one case for each of the four kinds of text in the table of §4.5.1; other threads are unaffected.
- **Secrets**: the input is deleted and the summary contains no plaintext; the text from all three sources, OutputCapture, Broker and renderer, is redacted; secrets entered during a Telegram turn also take effect; secrets containing `& < >` are replaced correctly with the HTML structure intact; input shorter than 8 characters is not registered; cleared after `/new`.
- **Dialog guard**: while a Broker session or a native input flow is active, `/tg`, `/cwd` and host commands are rejected, and `/stop`, `/status` pass.
- **Text input**: text replying to another message is not treated as input.
- **Message reuse**: multi-step dialogs and progress within a command scope reuse the same message; dialogs within a turn each send a new one; after progress ends the message is changed to the finished state and the keyboard is removed.
- **Content domain**: assistant/tool components the host adds during a Telegram turn are not intercepted (already sent by the renderer); `notify` is sent only once in `on` mode; history rebuild after `chatContainer.clear()` is not intercepted; a single scope with more than 20 components is collapsed.
- **Extension command completion signal**: on the idle path `onSubmit` returns first and `session.prompt` starts shortly after and pops up a dialog, and the scope does not end early; when the main loop is busy and the text queues in `pendingUserInputs` for over 2 seconds it still matches; in the streaming path, when `session.prompt` is called synchronously inside `onSubmit` it can be matched; after a built-in command (`/session`) is submitted there is no waiting, and the next Telegram command is not misjudged as busy.
- **Output content domain**: while the agent is streaming, `/session` sent from Telegram has its info block intercepted; at the same time assistant/tool components are not intercepted.
- **Hook reinstallation**: after replacing `mode.editor` (simulating `setCustomEditorComponent`) and `mode.session`, the tick can re-wrap, and submit, the local input marker and `session.prompt` matching keep working.
- **Entry association**: when `showExtensionConfirm` nests `showExtensionSelector` the kind is `confirm`; when an async custom factory returns after a 1-second delay the entry can still be associated.
- **Dispatch priority**: `pluginOnly`, the mapping table, host built-in (including the `/debug` name clash), fallback, rejection.
- **Callback encoding**: all combinations ≤ 64 bytes.

### 7.2 E2E parity (rework `scripts/e2e/audit-parity.mjs`)

The current criterion is "whether what Telegram received is plain text or an invalid button". Change it to **state equivalence**:

1. Execute each command in two fresh isolated hosts: A is operated in the terminal by sending keys through tmux, B sends the command from mock Telegram and clicks buttons, and both sides perform the same sequence of operations.
2. After execution export a host state snapshot: current model, thinking level, session file, settings file, and the corresponding fields in the auth file.
3. The snapshots of A and B must be identical.
4. An extra assertion: the set of options listed on Telegram equals the component's full list.

Keep the existing Bot API contract check (`scripts/e2e/telegram-contract.mjs`).

---

## 8. Risks and degradation

| Risk | Impact | Mitigation |
|---|---|---|
| A host upgrade changes private fields or method names | Adapter recognition fails | Support only fixed versions (pi `1.4.0`, OMP `18.12.x`), and error out at startup when the version does not match; before upgrading, read the new version's source, get the contract tests and E2E passing, and only then open the version (§0.1) |
| OMP's actual structure differs from expectation | Some OMP dialogs degrade to snapshots | Stage 0 has probed it: OMP's built-in model/settings/session/tree/oauth components have no readable fields, so stage 3 implements them by snapshot first; the extension entry arguments still provide a structured model (§4.6.5) |
| Both sides operate at the same time | Race | A host modal dialog takes effect only once; the Broker validates focus before operating; callbacks carry sessionId + generation; locate by key |
| When a command is submitted from Telegram the terminal has a dialog open or the previous command has not ended | The command cannot land in the editor | The Gateway rejects it and shows a notice (§4.2.3) |
| The host changes focus bypassing `setFocus` | Close event lost | Focus validation (§4.1.3) |
| Output duplicates agent messages | Flooding | Intercept only output of scopes that have an owner |
| Consecutive Telegram-side operations cause edits to exceed the rate limit | 429 | 1 per second per chat; no edit if the model is unchanged; terminal changes do not trigger edits |
| Hook code throws | Affects the host | Principle 7 |
| Secrets pass through Telegram | Leak | §4.7.4 (fixed behavior) |
| Text the host writes into the editor for the initiator (`/fork`) | Overwrites the local draft | §4.2.4 |
| Default-value migration changes behavior for existing users | Surprises users | CHANGELOG lists the behavior change separately |

---

## 9. Confirmed decisions

| # | Question | Decision |
|---|---|---|
| 1 | Whether locally initiated dialogs are pushed to Telegram | **Not pushed**. Whoever initiates, displays. An `ask` in a local agent turn is not pushed either |
| 2 | Whether `tuiBridge` keeps `off` | ~~Keep for now, no cleanup~~ **Overturned in v6: delete the `off` mode and the plugin's native implementation immediately** (decision 48) |
| 3 | Whether `/quit` can be run from Telegram | **Allowed**, with a second confirmation |
| 4 | Whether terminal changes are synced to Telegram | **Not synced**. Before executing, locate by live state and key |
| 5 | When a command scope ends | `onSubmit` and the hold both ended + no active session + focus on the editor + 1.5 seconds without output; 30-minute cap (§4.3) |
| 6 | When the draft is restored | At scope end; untouched if the local user is already editing; text the host wrote for the initiator is sent to Telegram and then the draft is restored (§4.2.4) |
| 7 | Ownership of enqueued turns | The Gateway reuses the existing holding logic; ownership is decided by the top of the Telegram UI stack (§4.2.6, §4.3) |
| 8 | Default-value migration | `commands`/`full`/unset → `on`, written into the CHANGELOG as a behavior change (§4.10) |
| 9 | What OutputCapture intercepts | Agent messages and tool calls are sent only by `renderer.ts`; OutputCapture handles host status/error/warning (including `notify`), plus chat-area content inside a command scope that is non-streaming, non-rebuild and not message-type (§4.4). In `on` mode `notify` is no longer sent directly to Telegram (§4.9) |
| 10 | Completion signal of extension commands | Hook `session.prompt`, match the call with this submit's text, and count its end in the scope end condition (§4.3) |
| 11 | Local command mirroring | Deleted per decision 1 (§4.9 item 5) |
| 12 | pi-goal's opaque custom component | Structure it per the stage 0 probe first; when the probe proves there are no usable fields, open the **single, narrowed** exception of §4.6.6: whitelisted shapes only, text used only for recognition and reading options, all operations through key presses, version bound |
| 13 | Criterion for output interception | Do not use `isStreaming`; exclude agent-rendered components by component identity (§4.4) |
| 14 | Position of the redaction layer | Replace before conversion at the three send sources, not at the transport layer; do not register secrets shorter than 8 characters (§4.7.4) |
| 15 | Scope of the completion signal | Register only for non-built-in commands, register first and then submit; expiry is "idle + nothing queued + main loop waiting for input" holding continuously for 500ms, with a 60-second cap (§4.3) |
| 16 | Telegram commands while a dialog is open | Let through only `/stop` and `/status`; reply "Please handle the current dialog first" to all others (§4.2.2 step 0') |
| 17 | Where OMP's extension entry hook goes | **The UI context**, not the `InteractiveMode` prototype. OMP extensions/tools call through their own `ctx.ui` (`select/confirm/input/editor/custom/askDialog/approve`), and stage 0 proved that the `showHook*` of the mode prototype is not triggered for the extension context |
| 18 | OMP built-in selectors (model/settings/session/tree/oauth) have no readable fields | **Degrade to snapshot first**, offering only ↑↓/Enter/Esc; do not parse rendered text to fake native lists. If a later OMP version exposes fields, upgrade according to the probe results |
| 19 | OMP's `mode.editor.onSubmit` does not exist at capture time | Handed to the once-per-second tick of §4.1.1 to install; capture only records field names and assumes no initialization order |
| 20 | Source of the `/export` path | `exportToHtml`/`exportToJsonl` return a **Promise**; the string it resolves to is used as the path. `/share` calls the same method internally, so they are told apart by scope label (§4.8) |
| 21 | Whether `/reload`, `/fork`, `/clone`, `/import` are submitted to the host editor | **Not submitted; keep the native handlers.** Submitting to the editor takes the `runtimeHost` session replacement path and bypasses pi's `withSession` ordering; the extension runtime is reloaded while the old polling instance has not yet been released, and the singleton coordinator rejects the new instance ("another local pi instance is already polling this bot token"). The native handlers already complete the same state change inside the host control API. **(v6 revision: `/fork` and `/clone` are changed to be handed to the host, see decision 52; `/reload` and `/import` unchanged)** |
| 22 | How `/new` is executed | **Call the host `ctx.newSession()`, do not submit to the editor.** The editor path goes `handleClearCommand()` → `runtimeHost.newSession()`, which likewise bypasses `withSession` and triggers a polling instance handover; `ctx.newSession()` in the command context is the host-supported replacement entry. The command scope still needs to save/restore the draft. |
| 23 | When OMP is connected to the Gateway | **Postponed to stage 3.** Stage 0 proved that OMP's `/status`, `/usage`, `/stats`, `/context`, `/skills` etc. go through the full-screen `showCommandReport` panel, whose content is not in the `addChild` stream of `chatContainer`; stage 1 has no `InfoPanelAdapter`, so connecting would only reply with an ack and no body. Stage 3 first does panel interception, then adds OMP's output-only commands to the whitelist. |
| 24 | In which step the `session.prompt` completion signal is implemented | Decisions 10 and 15 are unchanged, but it is implemented together with the Gateway wiring (§4.2.3, §4.3): register only for non-built-in commands, set `promptDone = true` immediately for built-in commands, plus a 500ms quiet window and a 60-second cap. The half-finished version previously in `origin.ts` waited for a prompt for every command and installed no hook, which would make every output-only command wait idly up to the 60-second cap, so it was deleted rather than leaving half a mechanism. |
| 25 | When OMP's extension `select`/`input`/`ask` go through the broker | **Moved to T3.0 in stage 3, and the earlier premise is corrected.** The stage 2 closing retest (`focusEvents` and `conclusions.dialogFrames` of `docs/host-probe/omp-18.12.5.json`): OMP's hook dialogs **do** switch focus — after the `select`/`confirm`/`input` entry calls comes `via:"setFocus"` right away, the focused component is a `children` container (`QT`, `FD`, `Fy`), the `askDialog` component carries `callbacks`+`options` (`Ej`), and an extension custom dialog is a plain object with `render`/`handleInput`; the earlier note "does not call `setFocus`" no longer appears in the retest (in that collection the plugin was answering natively in Telegram, so whether the host dialog was really built cannot be confirmed), and this data is authoritative. What is missing is not focus but recognition and reading: OMP keeps labels in private fields (the row component's own keys are empty), every shape check in `classify` of `lib/tui/focus.ts` misses, and the constructor names are minified output, so the classification lands on `"progress"` and adapters cannot read the entries either. So the interface of §4.1.3 "identify dialogs by focus" needs no change: a focused component bound to an entry is a dialog; labels are taken from the frame the component draws (the probe has recorded the color-stripped frame text by component shape), and operations keep using the key injection of `act()`. Until then `hostOwnsPrompts()` is opened only for pi (decision 27), and "OMP `ask` multi-question fully answered from Telegram" in the stage 2 acceptance may continue to be answered by the plugin in Telegram; the rest of the stage 2 acceptance is unchanged. |
| 26 | Who gets the text when a plugin-native prompt and a mirrored dialog are both waiting for the same text | **The plugin-native prompt started in this chat**: the controller first calls `deps.ui.resolveInput`, then asks the Broker. This is consistent with "latest flow first" in the single-table model of §4.5.1 — whoever asked last gets the answer. Measured failure (before merging): a snapshot mirror left over in the terminal swallowed the answer to a secret prompt as a search term, and that prompt then deleted the next `/probe-custom` command as if it were its own answer, so the two steps failed together. The work of merging the two tables with `registerExternalInput` is done together with T3.6 (§4.5.1 implementation status). |
| 27 | When the Broker is enabled | **It shares the same host switch as `hostOwnsPrompts()`.** With only `hostOwnsPrompts()` off, the broker still tracks focus, models dialogs and competes for the same text: in stage 2 testing the OMP commands suite dropped from 132/132 to 119/126, and `/exit` and `/tg-cwd-disconnect` also failed. The closing condition is `tuiBridge: full` + host bridge available (the `enabled` of DialogBroker in `lib/controller.ts` directly calls `hostOwnsPrompts` of `lib/tui-bridge.ts`). That switch was briefly opened only for pi (`getHost() === "pi"`), because at that time the broker could not read OMP's dialogs; once classification and reading were completed that condition was deleted, and the acceptance line for opening is still that the commands suite not fall below the stage 1 baseline of 132/132 (completion criteria of T3.0 in the task list, decision 28). |
| 28 | How OMP dialogs are classified and when they count as closed | **Classify by the entry, wait for confirmation to close.** A focused component bound to an entry, or first focused within the "entry call not yet finished" window, is classified as `dialog` (`FocusTracker.entryFor`; OMP's UI context entries have no component field and are associated through the pending entry), no longer relying on class names or shapes. Components whose rows are hidden in private fields are handled by the adapter that reads per frame: the color-stripped text of `render(80)` is parsed for the title, rows, the current row marked by `❯`, and the footer keys, and operations still use key injection, without requiring the host to expose private fields. **Closing**: focus returning to the editor must last 250ms to count as closed (the §4.1.3 classification table has been supplemented accordingly), while jumping straight to another dialog counts as closed immediately. **progress creates no session**: a spinner with `signal`/`abortController` is not a dialog, and the broker sends no Telegram message for it (reason in §4.1.3), while mirroring continues to show it as before. While the broker is drawing a dialog, mirroring keeps broadcasting the screen but no longer offers its own arrow-key keyboard (one keyboard per question). **Why closing looks at focus rather than the entry Promise**: the end of the entry Promise is only used to invalidate the entry record (`retire` in `lib/tui/entry.ts`), while session closing is still decided by focus; the confirmation window is 250ms (`FOCUS_CLOSE_GRACE_MS` in `lib/tui/focus.ts`) rather than 1.5 seconds, because in testing OMP's focus returns to the editor for just one frame during a redraw, 250ms is enough to filter that, and a longer window would leave the Telegram keyboard lingering after the dialog really closed. A multi-question `ask` is not closed early between two questions, verified by `test:e2e:dialogs` (OMP, pi). pi and OMP use the same rule. |
| 29 | What the session does when focus is handed to a container component | **Change the key target, not the session.** After OMP opens an overlay it hands the focus from the dialog to the `children` container (`QT`) that carries it, and the two share the same entry object. If the session were rebuilt for the new component, all buttons already sent to the chat would be voided (a click replies "this menu has expired") and multi-step flows would die on the spot. So the broker compares `FocusTracker.entryFor(component)` with the entry recorded in the session: if it is the same entry it only changes `session.focus` (the key target), and keeps the message, keyboard, `generation` and pending input unchanged, and adds `session.subject` to record the component that really holds the state — reading, adapter `act` and key injection all go to `subject`, because the container only forwards. |
| 30 | Whether a progress component grabbing focus counts as the dialog closing | **No.** A spinner (the `BorderedLoader` kind) takes focus so that Esc can interrupt the turn, and the question behind it is still open. The old implementation retired the session on seeing `progress` and withdrew the keyboard from the message being waited on: in OMP's multi-question `ask` "Next question/Submit" could never be clicked. Now `progress` neither creates a session nor mirrors (decision 28 unchanged), but an existing session stays alive and drivable (`canDrive` allows "focus is progress"), and the real close is still decided by focus returning to the editor (250ms confirmation) or jumping to another dialog. |
| 31 | A new command arrives before the dialog is fully answered | **Press Esc only for this chat; a dialog elsewhere is only explained, not answered on someone's behalf.** The host queues an unanswered dialog before all subsequent commands, so when a command arrives while an unanswered dialog is still there, it must be clear whose it is. Narrowed to three rules: ① the session's Telegram message is in this chat → press Esc once for the user, only remove the dead keyboard from that message (do not overwrite the body: the new command answers on the same message per §4.7.3), and add in the chat "Closed an unanswered dialog: <title>"; when focus has already returned to the editor (the session is only held up by a command scope that has not ended) **reclaim silently** instead, without pressing Esc or announcing, otherwise the notice would arrive ahead of the command output. ② A dialog that is not this chat's — including one the terminal opened itself, and one never sent to any chat — **is never answered on its behalf**: `abandonFor` returns `blocked`, the controller replies "There is an unfinished dialog in the terminal. Please handle it in the terminal first, or send /stop." and **does not submit the command to the host** (the scope just opened ends with `error`), so it does not sit silently behind someone else's question for 30 seconds. The earlier approach of "an unclaimed dialog counts as this chat's and is closed in passing" was dropped: it decides on behalf of others and would swallow an answer the terminal is about to read. |
| 32 | How mirroring and the broker divide the work | **Divide ownership by message, not by chat.** The old way was "this chat has a broker session → mirroring does not start at all", so a leftover dialog could leave every later command without output. Now mirroring starts as usual and yields only on the message the broker is drawing; there is still only one keyboard: `mirrorsFor` counts only sessions that **have drawn a message in this chat**, and a session owned by the terminal itself must not take away the mirror keys. The condition that the command receipt becomes "the selector is in the message above" is tightened in the same way to "opened by this command and drawn in this chat" (comparing `DialogSession.openedAt` with the submit time); otherwise the output is mirrored as usual. |
| 33 | Who owns `ui.menu` | **If the host has `menu`, use the host's.** The proxy layer had forcibly kept `menu`/`closeMenu` for the plugin's native keyboard, so the same question had both a plugin keyboard and a host dialog (the host one mirrored by the broker), and where a click landed was luck; the whole chain of the management menu (the `/tg` family) worked on and off. After deleting this special case: when the host has no `menu` the proxy still falls back to the plugin implementation, when the host has one it goes to the host, with the broker as the single exit. |
| 34 | A screen no adapter can model | **Hand back to screen mirroring; the broker creates no session.** A dialog going through `SnapshotAdapter` can only show the whole-screen text and cannot give buttons that really answer; sending it to the chat from the broker amounts to grabbing the message with a fake keyboard while, per §4.5, silencing the mirror that can really inject keys (the `/tg` family was measured to show two keyboards, "broker menu + plugin native menu", with clicks landing on one side by luck). Now when `open()` selects the snapshot adapter it returns directly (leaving only a debug note), and the screen is still broadcast by the mirror and can be operated with arrow keys. |
| 35 | The option strings given by the host carry indentation and a "current value" dot; how to match them to the rows on the frame | **Strip decoration from both sides, then compare.** The option strings OMP hands to extensions carry their own indentation and current-value marker (such as `"  hidden"`, `"● brief"`), and the frame draws a cursor marker plus the same text, so a character-by-character comparison never matches: `act` can only refuse (`frame marks no known row`), and the config submenu of `/tg` and the whole `/model` group cannot be clicked. `longestLabelMatch` first strips leading whitespace and leading status symbols from the label before comparing, still taking the longest match (one row's text may start with another row's). |
| 36 | How many arrow key presses, and counted by what | **Counted by the rows actually shown on the frame.** When the data is in private fields, the full option set and the rows on screen are not the same thing: counting by the full set after searching or paging in the terminal makes Enter land on the wrong row. `frameRows` gives the position of the visible rows and the highlighted row, and the step count is computed between the two; a row not on screen is refused directly, without guessing. |
| 37 | When generation increments | **Only when the buttons the user can press change.** The old way incremented +1 on every redraw, and OMP repeatedly redraws the same question (a focus flicker counts too), so the keyboard in front of the user was judged "The list has changed, please select again" when nothing had actually moved, and a multi-question `ask` could not reach Submit. Now the "button surface" of two draws is compared (button text + callback arg→key): if identical the original generation is kept; before comparing, terminal cursor markers such as `▸`/`❯`/`→` are stripped — they are embedded in the button text, but each button resolves to the live model by its own key, so moving them does not change the meaning of any button. A page change alters the button surface and increments as usual, and since the arg carries the page number, old buttons still resolve by their own arg. |
| 38 | After the host takes over prompts, how commands that only send a notification get back into the chat | **Replace the `ui` of the command context with a routing proxy, but only when the host itself does not deliver to the chat.** After `hostOwnsPrompts` was opened for OMP, `runCommandHandler` hands the command context to the host as is, and `ctx.ui` became the host's raw UI: `notify` only prints in the terminal, and commands such as `/changelog`, `/copy`, `/debug` that reply with just one notification turn into a 30-second timeout on the Telegram side. Now in host mode the command context is also wrapped with `createHostPromptUi(hostUi, telegramUi)`: prompts still belong to the host (the terminal can answer). But the `ui` pi hands to the command context is already the plugin's routing context (carrying the `__piTelegramPlusRoutedUi` marker), and its notify already delivers to the chat, so copying it again would send the same message two or three times; `createHostPromptUi` therefore checks this marker first, passes through directly if it already delivers to the chat, and each notification is sent only once. |
| 39 | Whether to remove the keyboard in passing when editing a message fails | **No.** When a `show()` redraw failed it used to follow up with a `removeInlineKeyboard`, on the grounds of "content unchanged or rate limited" — but neither failure says whether the dialog is alive; the question is still open, and withdrawing the only buttons that can answer leaves the chat with nothing to do but wait. Now a failure only logs, and the next redraw naturally catches up; the only things that should remove the keyboard are `publish()` (the dialog really ended) and `abandonFor` (pressed Esc on the user's behalf). |
| 40 | Which comes first, "has an entry means dialog" or "is a loader means progress" | **Loader first.** Recognizing a dialog with no readable rows depends on claiming the entry the host recorded (`entryFor` binds it to the current component), and that action has a cost: when a spinner panel gets focus first, it is classified as a dialog carrying the question's identity and also uses up the entry, so the real dialog arriving later becomes a nameless snapshot (exactly what decisions 28/30 sought to prevent). So the order in `classify` is changed to: shape check → loader/signal check → only then entry claiming is allowed. |
| 41 | By what OMP dialogs are read and operated | **collab + TSP, no screen reading and no simulated key presses** (§4.11, decided by the user on 2026-10-24). Based on the OMP source and the S20/S21c/S22 measurements: extension select/editor/ask/approve go through `mode.collabHost.requestGuestUi`; the other dialogs and built-in selectors go through the component's `describe()`/`handleNativeEvent()`. Supersedes decision 18, and the parts of decisions 25, 28, 35, 36 about OMP screen reading. |
| 42 | Whether locally initiated dialogs are pushed to Telegram through collab | **No.** The bridge takes over only when there is a Telegram-initiated command scope or Telegram turn; otherwise it returns `null` and the dialog shows only in the terminal (decision 1). |
| 43 | What to do when the user opens `/collab` themselves | **Yield to the real collab host, find no other path.** The bridge stops taking over when it finds `mode.collabHost` has been replaced; in the meantime Telegram-initiated select/editor/ask/approve reply directly "The terminal is in /collab collaboration, please handle it in the terminal or on the collaboration side"; after collab ends it is hooked back on. |
| 44 | Version constraint of the OMP structured channel | **Bound to `18.12.x`, fail on mismatch, no degradation** (decided by the user on 2026-10-24: "if the version is wrong just fail, don't do multiple sets"). When the version does not match or cannot be read the plugin reports an explicit error and OMP dialogs are not bridged; supporting a new version requires checking the source and getting E2E passing first (§4.11.4). Likewise the S8 (`558d574`) approach of "fall back to snapshot on version mismatch" is abandoned, and the related code is deleted with T3.2g. |
| 45 | How the existing broker is adjusted on OMP | **Kept as the hub, with the adapters switched to structured sources** (the user asked on 2026-10-24 that the existing broker also be moved to the new plan). Collab requests are added as a session source; the focus + screen + key path on OMP is deleted in T3.2g. |
| 46 | Which host versions are supported | **Only pi `1.4.0` and OMP `18.12.x`, no compatibility with multiple versions** (user 2026-10-24: align only with 1.4.0, no more compatibility with multiple versions). Error out at startup on version mismatch; delete the multi-version test matrix and the compatibility code that exists only for old versions. |
| 47 | What to do with a dialog that cannot be recognized | **Say so clearly, do no half-baked operations** (user 2026-10-24). Remove snapshot arrow keys and "hand back to screen mirroring" (decision 34 is void); `UnsupportedAdapter` gives the notice and offers only "Cancel". |
| 48 | The `off` mode and the plugin's native implementation | **Delete immediately** (user 2026-10-24, overturning decision 2). Error out at startup when the bridge is unavailable; `pluginOnly` management commands are kept. |
| 49 | When to delete the old paths | **Delete now, before migration** (user 2026-10-24: not currently in use, deletion has no effect). Unmigrated commands temporarily have no output, and the E2E "to be migrated" list distinguishes expected failures from regressions. |
| 50 | What host behavior is based on | **Host source is authoritative**: first read the pi `1.4.0` / OMP `18.12.5` source to establish the premises, and use runtime experiments only for verification (twice before, groping by runtime experiments without reading the source wasted many rounds). |
| 51 | Who executes `!command` / `!!command` sent from Telegram | **Handed to the host to execute, with the plugin keeping only the dangerous-command confirmation** (user agreed 2026-10-25). The editors of pi 1.4.0 and OMP both natively support `!`/`!!`, and before executing, the host sends a `user_bash` event so extensions can take over or refuse (`handleBashCommand` in pi `interactive-mode.ts`); having the plugin call `session.executeBash` directly would **bypass this extension hook** (for example sandbox and permission extensions). So the plugin no longer calls the bash executor directly, but first confirms in Telegram per the `bashConfirm` policy (the plugin's own remote-execution safety gate, with no counterpart concept in the host), and after confirmation submits the original text to the host editor through the gateway, with output sent back as usual. Task D3b. |
| 52 | Who `/fork` and `/clone` are handed to | **Handed to the host to execute** (user agreed 2026-10-25; revises decision 21). The reasons of decision 21 (an editor submit replaces the runtime, polling singleton conflict) have been eliminated by `e046a98` (in-process lock takeover) and `bf81fd5` (commit the cursor before destructive calls). The rule is unified: commands with a selection interface (`/fork`, `/clone`) are handed to the host and their selectors are taken over by adapters (pi: `UserMessageSelectorComponent`; OMP: TSP), after which the plugin's own message list is deleted; commands with no interface that only call the control interface (`/new`, `/reload`, `/import`) continue to call the host control API. Folded into 3C and 3D respectively, with 3E verifying runtime replacement through E2E. |
| 53 | How extension dialogs are connected to Telegram on the two hosts | **Extension UI race (§4.12), replacing the collab bridge** (user chose the race direction on 2026-10-24; S25/S25b confirmed on both hosts on 2026-10-25). Revises decision 41: extension select/confirm/input/editor/ask/approve go through the race, and TSP is used only for built-in selectors, `custom` and dashboards. Decision 43 (`/collab` yields) is void: the race does not occupy `collabHost`. |
| 54 | How plain text from Telegram is handled while a dialog is open | **If the dialog takes text (an input box, a list with search), hand it to the dialog; if it does not, do not submit it as a prompt, and reply "There is a dialog waiting in the terminal (<title>); please answer with the buttons, or send /stop to cancel".** A `/` command first closes this chat's dialog per §4.5 rule 6 and then executes (3E found that the gateway path missed this step after D2, and F9 `a4a2dbe` added it). Basis: consistent with the terminal — while a dialog holds focus no prompt can be sent in the terminal; decided by the controller 2026-10-25 (F8 `7589384`), the user may change it. |
| 55 | What the plugin does in OMP sub-agent sessions | **Nothing in sub-agents; the main session owns the runtime exclusively** (2026-10-26, issues #13/#15). OMP calls the extension factory again in the same process for each sub-agent (`ctx.agent.kind === "sub"`, OMP `extensibility/extensions/types.ts`). `lib/main-only-pi.ts` wraps `pi.on` handlers so that they do not run in sub-agents; "taking over the runtime" (tearing down the old runtime, writing `runtimeState.dispose`) happens only in the main session's `session_start`, and the factory no longer tears down unconditionally at its start. pi has no sub-agents and no `ctx.agent`, so a missing field is always treated as the main session. **Known and unhandled**: on pi, a third-party extension opening a nested session with the SDK will load this plugin again, pi has no distinguishing field, and no guard is added (there is no reliable criterion, and no guessing-based guard is made). Things done directly in the factory (the coordinator timer, the broker/gateway timers inside the controller) also start in sub-agent instances: the first time `mainOnlyEvents` is triggered by a sub-agent context it calls `disposeInertRuntime`, which tears down only this instance's own timers and controller and does not touch shared state (status bar, process-level menu refresh, the coordinator lease, `runtimeState`) (e97081a, real OMP trace: the sub-agent instance was cleaned up 8ms after creation, and its coordinator timer fired 0 times). Command/tool registration remains on the sub-agent's own runner. |
| 56 | How wrapping of host dialog methods is de-duplicated | **Scoped per FocusTracker instance; use object marks only when the host's reads are unstable** (initial version 2026-10-26, revised 2026-10-27; issue #16, and the pi regression it caused). Two facts about the hosts (both measured): the tool UI object OMP gives extensions and the `setFocus` of pi's TUI object **return a new function on every read** (unstable reads); pi rebuilds the plugin runtime inside the same process (`/new`, `/reload`), creating a new FocusTracker each time (`new FocusTracker()` in `lib/controller.ts`). Requirements: the same tracker wraps the same method of the same object only one layer (otherwise on OMP one layer is stacked per tick, and the stack overflows after about 3000 times); while each new tracker must install its own layer (otherwise events are delivered only to the destroyed old tracker). Implementation (`lib/tui/install-marks.ts`): the de-duplication state of the three kinds of hooks — entry hook `hookEntryMethods`, race `installRace`, `hookMethod` — is stored per `scope` (the FocusTracker instance) under `globalThis[Symbol.for("pi-telegram-plus.install-marks…")]` (shared across module instances); function identity (both the wrapped function and the wrapper are registered) blocks repeated wrapping on hosts with stable reads, and the object mark `hasStickyMark` only takes effect when two consecutive reads give different functions. The `hookMethod` calls in `output.ts` pass no `scope` and are still de-duplicated process-wide. **Mistakes of the initial version**: it made de-duplication "by (object, method), shared process-wide, not distinguishing trackers", and removed per-tracker function-identity de-duplication. On pi this caused three regressions (all located by tracing): entry hooks were no longer installed after a runtime rebuild (the old version installed 4 times per `showExtension*`, the initial version 1); `installRace` registered a global set while the entry hook consulted the tracker set, so `select/confirm/input` stacked a layer per tick (425 times vs about 45); focus hooks such as `setFocus` were blocked by the sticky object mark (`stableRead=false, sticky=true -> SKIP`), the new tracker received no focus events, and the `/model` dialog was registered as sourceless and stayed open, blocking all later commands. Fixes: 1e44c29, 8e1ba00, b09184b, c5a9030, 8d989f7; `pi:main` recovered from 53/64 to 75/75. **Lesson**: when changing the scope of "who shares state with whom", run all three E2E suites for commands, dialogs and the TUI bridge on both hosts. |
| 57 | How the OMP login dialog is connected to Telegram | **A dedicated adapter `tsp-login`, one adapter for both phases** (2026-10-26, issue #14). On real OMP four layers of problems were found and fixed in turn: focus classification judged the login dialog carrying a `signal` as progress (`describesLoginSheet`); the adapter was chosen when the dialog had just appeared (with only a link) and the input box appearing later did not change the adapter; the text is in `p.spans` rather than `p.text`, the title is in the inner `overlay.p.head`, and the status is in `spinner.p.label`; the input `TextFormField` has only `describe()` and no `handleNativeEvent()`, so the read descends requiring only `describe` (`describableChild`), while sending events still uses `asComponent`. The link-only phase uses the `progress` model (plain text, the link is clickable; `info` uses `<pre>`), and once an input box exists it reuses the reading and writing of `tspInputAdapter`; the `input` model gains an optional `detail` (description, device code, link). |
| 58 | Whether to delete the user's message when a dialog turns into a secret input midway | **Judge by the current model, not by the snapshot at dialog opening** (2026-10-26). `isSecretSession`: use `pendingInput` if there is one, otherwise look at the `secret` of the current model. So while the dialog still shows a secret input box, later messages (for example a retry after a typo) are also treated as secrets: remembered and deleted; once the model becomes non-secret they are not deleted. The expectation in an existing case that "the second message after a secret reply does not count as a secret" is revised (that was a by-product of `pendingInput` being cleared). |
| 59 | Telegram-initiated `!` commands: the result and the terminal input box | **The result always goes back to this command's own message; reject if the previous one is still running; when finished the input box is restored to what it was before the command** (2026-10-27, issue #17; the user confirmed "when sent back to back, be consistent with the TUI: reject with a notice"). All three causes were reproduced by E2E and located by tracing/host source: (1) while an agent turn is in progress, both hosts put the bash output component into `pendingMessagesContainer` (pi `interactive-mode.js` `isDeferred = this.session.isStreaming`; OMP `command-controller.ts` `handleBashCommand`), and it is moved into the chat area only at the next submit; the plugin listened only to the chat area, the scope ended after 1.5 seconds of silence, and the result never reached Telegram. Fix: `output.ts` also claims bash components in the pending area inside the `"!"` scope (`output-pending-add-child`), `hasRunningBash` keeps the scope open until `setComplete`; when the component is later moved into the chat area it is de-duplicated by `bashTracked/bashPushed` (1623a64). (2) While the previous bash was still running the host refused the new `!` and put the text back into the input box, while the scope the plugin opened for the new command replaced the previous one's, so output got attached to the new message. Fix: before submitting check `session.isBashRunning || bashSubmitInFlight`, and on a hit reply with a notice directly and do not submit (37e693a); `bashSubmitInFlight` covers the gap, when the plugin handles messages concurrently, of "submitted but the host sets isBashRunning only about 60ms later" (trace data, 256e0c0). (3) The plugin wrote the command into the editor and submitted it (`submitToHostResult` in `tui-bridge.ts` bypassing the editor's own clearing on Enter), and `restoreDraft` originally wrote back only when the draft was non-empty, so when the draft was empty the command text stayed in the input box. Fix: when the input box is empty or equals the command text always write the draft back (including the empty string); if the user edited the input box themselves while the command ran, it is not overwritten (e35f15e). Acceptance: `Telegram ! commands leave the TUI input clean` (12 runs + draft variants) and `Telegram ! command results under load` (during a turn, back to back, long output, dialog open, `!!`) pass on both OMP and pi; before the fixes they were 0/12 and failing during a turn/back to back respectively. |

On the relation between "whoever initiates, displays" and "shared ownership": a dialog initiated from Telegram is drawn by the host in the terminal, so it can certainly also be seen and operated in the terminal (shared, whoever operates first wins); but changes in the terminal are not actively pushed to Telegram, and locally initiated dialogs do not appear in Telegram either.

---

## 10. Follow-up TODO (not in the scope of this refactor)

- [x] ~~Clean up the `off` mode~~: v6 changed it to immediate deletion, see §0.1 item 4 and tasks D1–D4.

- [x] ~~E2E: `settings mirror matches the host screen` (OMP) fails occasionally~~: screen mirroring was deleted in D2, and this step no longer exists.
- [x] ~~**When the runtime is replaced, Telegram calls queued but not yet sent are silently dropped.** `lib/active-transport.ts` returns a fallback result directly when `isActive()` / the lease does not match (`sendButtons` returns `message_id: 0`), the caller gets no error, and it looks like "the menu was not sent". In the S5 measurement on 2026-10-24 there were a few in the last second of each stage. It should be changed to fail explicitly or to resend in the new runtime.~~: Z1 `736e794`: the results of `/new` and `/reload` are now sent by the new runtime (`lib/pending-notices.ts`); the dropping rule itself is kept (to prevent inactive instances from sending messages).

- [x] ~~**Remaining checks of OMP built-in selectors** (T3.2e/T3.2f): `/model`, `/settings`, `/login`, `/agents`, `/hub` have been confirmed by E2E; OMP's `/resume`, `/tree` and the text input boxes in built-in dialogs (TSP `edit` event) have not been specifically verified.~~: Z2 `f346ee3` (tabs, scope, action bar, search), Z4 `704c595` + Z4b `a5ab7cf` (built-in text input boxes); E2E already covers switching tabs in `/tree` and `/resume` with historical sessions (Z6 `23cf7ab`).
- [x] ~~**Other controls on OMP's settings page**: number, text, multi-select and hotkey settings show only "Please change in the terminal" on Telegram.~~: Z3 `ec48a21` + Z3b `a8be6ba` + Z8 `f0a8b27`: number, text, multi-select and action types can all be changed in Telegram, and the settings page is searchable; hotkey settings are still changed only in the terminal (meaningful only in the terminal).
- [x] ~~**Plugin commands have the same names as host commands**: `/status` and `/debug` are handled by the plugin and shadow the host's same-named commands; the Thinking level in `/tg → Config` duplicates the host's own `/thinking`.~~: `/debug` moved into `/tg` (N1 `fd4cb1f`); neither host has a top-level `/status` (only an OMP subcommand), so there is no conflict; on pi the Thinking level in Config is hidden (Z5 `2dabd41`), OMP has no `/thinking` command, so it is kept.

- [x] ~~Telegram rejects a dialog when a bottom button row has more than 8 buttons~~: Z7 `c7b4da0` at most 3 per row, and the render exit guarantees no more than 8; the E2E assertion is changed to skip rejected calls (Z7, Z8).

---

## 11. Revision notes

### v6 (relative to v5, 2026-10-24)

Decided by the user: support only pi `1.4.0` and OMP `18.12.x`; dialogs that cannot be recognized are reported clearly; delete immediately the `off` mode, the plugin's native implementation, the old screen mirroring and snapshot arrow keys; E2E uses a "to be migrated" list to distinguish expected failures. Added §0.1 and decisions 46–50; decisions 2 and 34 are void; principles 1 and 5 and §4.2.5, §4.6.5 #13, §4.10, §8, §10 are rewritten accordingly. The pi 0.81.1 line number citations in the text await updating after task A1 checks the 1.4.0 source.

### v5 (relative to v4, 2026-10-24)

Based on the OMP 18.12.5 source (it had mistakenly been thought that OMP had only a compiled binary and the source was not consulted) and three feasibility checks, OMP's side is changed to a structured channel: added §4.11 and decisions 41–45; §4.6.6 exception 2 enters a transition period and is deleted by T3.2g; decision 18 is void. The pi side is unchanged.

### v4 (relative to v3)

Based on the third review round (6 high, 6 medium, and several details), all verified against the source. pi-goal is not installed on this machine and its component fields cannot be verified, so item 1 was changed to "decide after the stage 0 probe". Stage 0 (2026-10-23) is complete: the probe files for pi 0.81.1, OMP 18.12.5 and pi-goal 0.6.0 are in `docs/host-probe/`, and the conclusions are filled back into §4.1.2, §4.1.3, §4.3, §4.4, §4.6.5, §4.6.6, §4.8 and §6.

| Review point | Where changed |
|---|---|
| CustomGoalAdapter violates principle 2 | §2 principle 2 points to the exception; new §4.6.6; stage 0 adds a pi-goal probe; §9 decision 12 |
| `isStreaming` pre-filter loses command output | §4.4 drops that condition; §9 decision 13 |
| Wrong field checks for message-type components | §4.4 changed to `streamingComponent` + constructor name + `lastMessage`/`hasToolCalls`/`toolCallId` |
| Transport-layer redaction misses matches and breaks HTML | §4.7.4 changed to source replacement and an 8-character lower bound; §5 file list; §9 decision 14 |
| Timing and scope of `expect` | §4.2.3 code registers first and submits after, built-in commands not registered; §4.3; §9 decision 15 |
| The 2-second window misses a queued prompt | §4.3 expiry condition changed to state checks + a 60-second cap |
| `/more`, `/pair` are not in `pluginOnly` | §4.2.1, §4.2.2 step 0 |
| pi's `hostBuiltin` cannot be derived | §4.2.1 changed to the static list in Appendix A |
| `pluginOnly` bypasses the focus check | §4.2.2 step 0' guard; §4.2.3 checks `hasPendingInput`; §9 decision 16 |
| "A reply to another message also counts as input" conflicts with `resolveInput` | §4.5.1 table |
| progress has no close semantics | §4.5 rule 7 |
| Message reuse contradicts new-message-per-turn | §4.5 rules 2, 4.1; §4.7.3 distinguishes by owner type |
| Details | Delete `CommandScope.secrets`; §4.3 rule 3 wording; owner compared by `chatId + messageThreadId`; `keyMap` keeps 3 generations; `entryStack` pops in `finally`; SecretStore `/new` clearing and limitation notes; the `/export` wrapper takes effect by scope label |

### v3 (relative to v2)

Based on the second review round (4 structural issues, 7 medium or detail issues), all verified against the source. Two more points not raised by the review were added: the existing local command mirroring violates decision 1; and the chat-area rebuild of `/resume` and `/fork` would be intercepted by `addChild` and cause flooding.

| Review point | Where changed |
|---|---|
| Agent/tool output is sent twice by OutputCapture and renderer | §4.4 content domain split and `addChild` interception conditions; §9 decision 9 |
| `notify` is sent twice | §4.9 item 1: in `on` mode `notify` goes only to the host |
| The UI mode of the Gateway contradicts `runCommandHandler`; `pluginOnly` is the exception | §0, §2 principle 1, §4.2.1, §4.2.6 (`uiMode`) |
| Extension commands have no completion signal | §4.1.2 adds the `session.prompt` hook; §4.3 second completion signal; §9 decision 10 |
| Instance hooks go stale | §4.1.1 tick re-wraps; the submit hook moves to `defaultEditor.onSubmit` |
| `mode.editor.editor` does not exist; `focusedComponent` is a private field | §4.1.3 classification table; §4.1.2 how focus is read |
| The scope of local submit suppression is too large | §4.2.3 wraps only the synchronous call |
| Wrap-up of the 30-minute cap | §4.3 |
| InfoPanel makes Snapshot unreachable | §4.6.5 #12 changed to a whitelist |
| Entry association window, confirm nesting | §4.1.2 entry association (`WeakMap` + stack + wrapped factory) |
| Secret scope and redaction range | §4.7.4 `SecretStore` + transport-layer redaction |
| Summary priority when a dialog is replaced | §4.5 rule 4 |
| settings cycle computation | §4.6.5 #5 |
| `findShape` skips `editor` | §4.6.3 |
| ExtensionEditor submit key | §4.6.5 #3 (Enter confirmed) |
| `hideOverlay` path wording | §4.1.3 |
| `registerExternalInput` details | §4.5.1 |
| (Added) local command mirroring | §4.9 item 5; §9 decision 11 |
| (Added) chat-area rebuild flooding | §4.1.2 `chatContainer.clear` hook; §4.4 |

### v2 (relative to v1)

Based on one review of the pi 0.81.1 source and the plugin code, all 14 comments were verified as valid (except "OMP is not installed": OMP is installed at `~/.local/bin/omp`, but as a compiled binary it indeed cannot be directly rechecked, so stage 0 was added). Main changes:

| Review point | Where changed |
|---|---|
| `onSubmit` hangs only for some commands | §4.2.3 lists the await type and the return-immediately type; draft restoration moved to scope end (§4.2.4); scope end conditions rewritten (§4.3) |
| SettingsList submenu does not call `setFocus` | §4.6.5 #5: a submenu is nested state within the same session; `ThemeSubmenu` degrades |
| Field locations, focused object | §4.1.3 session identity is based on the focused object; §4.6.3 adds `findShape`; Appendix B corrected |
| Focus ≠ dialog; non-capturing overlays; `setFocusInternal` | §4.1.3 focus classification, focus validation; non-capturing overlays listed as a non-goal |
| Scope ends too early and loses output | §4.3 |
| `/fork` writes the editor | §4.2.4 |
| Ownership of enqueued turns | §4.2.6, §4.3 rule 2 |
| Text input routing, secret sources | §4.5.1, §4.7.4, `LoginDialogAdapter` |
| Snapshot callback cross-talk | §4.7.1 snapshots uniformly use `tgplus:dlg:` |
| Multi-question questionnaire, approve | `questionnaire`, `approval` models; adapters #4, #10 |
| Plugin command priority, `/debug` name clash | §4.2.1, §4.2.2 |
| Default-value migration, config contradiction | §4.10; §8 deletes "configurable disabling of secrets" |
| Post-hoc judgment in stage 1 | Stage 1 changed to a static whitelist; new hooks only observe in stage 1 |
| Miscellany | Doc header changed to "supersedes principle 1"; `/export` changed to take the host method's return value; `tui-bridge.ts` unified as "deleted in stage 5"; plugin code citations changed to function names |

---

## Appendix A: pi built-in command classification (0.81.1, `setupEditorSubmitHandler` L2085-2218)

| Category | Commands | `onSubmit` behavior |
|---|---|---|
| Opens a dialog | `/settings`, `/fork`, `/tree`, `/trust`, `/logout`, `/resume` | Returns immediately |
| Opens a dialog | `/scoped-models`, `/login`, `/model` (no argument, or the argument has no exact match) | await |
| Output only | `/name`, `/session`, `/changelog`, `/debug`, Easter egg commands | Returns immediately |
| Output only | `/export`, `/share`, `/compact`, `/model <exact name>` | await |
| Host control (native handler) | `/reload`, `/fork`, `/clone`, `/import` | await or returns immediately; **not submitted to the editor** (§9 decision 21) |
| Host control (session replacement) | `/new` | Goes through `ctx.newSession()`, not submitted to the editor (§9 decision 22) |
| Terminal-only (§4.8) | `/copy`, `/hotkeys`, `/quit` | — |
| Prefix | `!`/`!!` | Keep the existing `runTelegramBash` |

`/model <term>`: when `handleModelCommand` (L3586) matches a model exactly it switches directly and calls `showStatus`; otherwise it opens the selector with the search term.

Extension commands, prompt templates and skills are not in this `if` chain and fall through to the generic submit logic after it (while compacting L2236, while streaming L2248, when idle `onInputCallback` L2262), and the Gateway's "submit directly" applies to them equally.

The stage 1 whitelist takes the commands in the two "output only" rows that can be submitted and do not replace the runtime: `/name`, `/session`, `/changelog`, `/debug`, `/export`, `/share`, `/compact` and the Easter egg commands; `/new` goes through `ctx.newSession()`; `/reload`, `/fork`, `/clone`, `/import` keep the native handlers. OMP's commands are connected in stage 3.

## Appendix B: pi dialog component structure (0.81.1)

| Dialog | Focused object | Where the data is |
|---|---|---|
| Extension select/confirm | `ExtensionSelectorComponent` | On itself: `options`, `selectedIndex`, `onSelectCallback` |
| Extension input | `ExtensionInputComponent` | On itself: `input` (Input), `onSubmitCallback` |
| `/settings` | `selector.getSettingsList()` (SettingsList) | On the SettingsList itself: `items`, `filteredItems`, `selectedIndex`, `onChange`; when a submenu is open it is `submenuComponent` (mostly a SelectList inside the submenu class, with `ThemeSubmenu` the exception). `SettingsSelectorComponent` holds only one main `settingsList` |
| theme / thinking / show-images | Each component | Internal `SelectList`: `items`, `filteredItems`, `selectedIndex`, `setSelectedIndex()`, `getSelectedItem()` |
| `/model` | `ModelSelectorComponent` | On itself: `filteredModels`, `selectedIndex`, `currentModel`, `searchInput`, `scope` |
| `/logout`, `/login` provider | `OAuthSelectorComponent` | On itself: `filteredProviders`, `selectedIndex`, `searchInput` |
| `/resume` | `SessionSelectorComponent` | Field `sessionList` (an ordinary class `SessionList`, not a component): `filteredSessions`, `selectedIndex`, `searchInput`, `sortMode`, `nameFilter` |
| `/fork` | `selector.getMessageList()` | A message list object (fields to be confirmed during implementation) |
| `/login` input | `LoginDialogComponent` | `Input`; after submit the input box is replaced by `> value` text |
| `/share` etc. | `BorderedLoader` | Progress, not a dialog |
| `/reload` | `reloadBox` (Box) | No `handleInput`, ignored |
| `/tree`, `/scoped-models`, `/trust`, config | Each component | Confirm with `findShape` during implementation |

Conclusion: pi-tui's base controls (`SelectList` / `SettingsList`) cover only settings-type dialogs; high-frequency selectors such as model, session and login are self-drawn lists that mostly follow the convention "a `filtered*` array + `selectedIndex` + a selection callback", but the data may be on nested non-component objects, handled by `findShape` + the generic `FilteredListAdapter`, with dedicated adapters added as needed.
