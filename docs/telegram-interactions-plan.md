> **Superseded (2026-10-25)**: Principle 1 of this document (in a Telegram-triggered turn, modal dialogs go only to Telegram and do not pop up in the terminal) has been superseded by `docs/tui-parity-refactor-plan.md`. The current approach: the host draws the dialog in the terminal as usual, the same question also appears on Telegram, and whichever side answers first wins (plan §4.12, decision 53). This document is kept for history only.

# Plan: Telegram remote interaction must not break the TUI (using the `/goals` confirmation as the example)

## 0. Design principles (highest constraint)

**Remote operation through Telegram must not break the local TUI experience.** Any plan must satisfy all of the following:

1. **Interactive modal dialogs (confirm/select/input/custom)**: whoever triggered the turn gets the dialog.
   - Telegram-triggered turn → the modal goes through Telegram (buttons/text). **It does not grab the TUI keyboard focus and does not pop up a dialog in the TUI.**
   - TUI-triggered turn (the local user types `/goals` in the terminal) → everything goes through the TUI. **Telegram is not involved and behavior is completely unchanged.**
2. **Persistent/status UI (goal widget, status line, working indicator, footer/header, etc.)**: always written back to the TUI, so the TUI state the local user sees is accurate, **even when the trigger came from Telegram**.
3. **Editor operations (pasteToEditor/setEditorText/getEditorText/setEditorComponent/onTerminalInput, etc.)**: no-op during a Telegram turn. The remote side must not push anything into the input box the local user is editing, and must not read the local user's draft.
4. **No hanging**: any detection failure must degrade to `undefined` (the RPC-mode `custom` contract). A tool promise must never stay pending forever.

> The previous version's Layer A made `setWidget/setStatus/...` all no-ops, which violated principle 2: goal
> creation/updates triggered from Telegram were not written back to the TUI, so the local goal status bar/widget broke. That is itself
> "Telegram affecting the TUI". This version fixes it with **selective forwarding**.

## 1. Symptoms

- In a `/goals` / `/sisyphus` flow, the agent calls `propose_goal_draft` → pi's TUI pops up a
  "Confirm Goal Draft / Continue Chatting" dialog. The Telegram side cannot see or operate it.
- The agent calls `goal_question` / `goal_questionnaire` → the TUI shows a Q&A component.
- While a goal runs, a `GoalWidget` status bar (display only) appears at the top of the TUI.

## 2. Root cause analysis

### 2.1 How the Telegram UI context is built

`create(chatId)` in `lib/telegram-ui.ts`:

```ts
const base = deps.getSession()?.extensionRunner.getUIContext?.();  // ← at this point it is the TUI UI
return {
  ...(base as ExtensionUIContext),   // ← spreads the whole TUI UIContext
  chatId,
  notify: ..., confirm: ..., input: ..., inputSecret: ..., editor: ..., select: ...,
};
```

Key fact: `create()` is called **before** the `runWithTelegramUi` swap (see `controller.ts`:
`const telegramUi = deps.ui.create(chatId);` comes before `runWithTelegramUi({...})`),
so `base` is the **real TUI UI context**. This lets us forward stateful methods to `base`.

It only overrides `notify/confirm/input/editor/select/inputSecret`. All other methods (`custom` /
`setWidget` / `setStatus` / `setFooter` / `setHeader` / `setWorkingMessage` / ...)
are **inherited entirely from the TUI base**.

### 2.2 How pi-goal starts a confirmation

`propose_goal_draft` in `@capyup/pi-goal`:

```ts
const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: PI_GOAL_AUTO_CONFIRM });
// = !hasUI || env==="1"
if (headless) decision = "confirm";
else decision = await showProposalDialog(ctx, draftSummary, focus);
```

`showProposalDialog` → `runGoalQuestionnaire` → **`ctx.ui.custom<GoalQuestionnaireResult>(factory)`**.

`runner.hasUI()` = `uiContext !== noOpUIContext` (`dist/core/extensions/runner.js:245`).
During a Telegram turn, `uiContext` is our Telegram UI (not noOp), so `hasUI===true`,
and pi-goal takes the TUI dialog branch. But `ctx.ui.custom` is inherited from the TUI → **the confirmation dialog renders into the terminal** and **grabs
the TUI keyboard focus**. This is the worst case of "Telegram affecting the TUI": an operation triggered by the remote user takes over the local user's
terminal. Likewise `setWidget` draws straight into the TUI (not bad in itself, but see 2.3).

### 2.3 Why `hasUI=false` is not an option

`shouldAutoConfirmProposal` would then return true → auto-confirm, skipping user confirmation, which defeats the purpose of
`propose_goal_draft`. The direction must be "make the confirmation dialog usable in Telegram", not "turn it off".

### 2.4 Why status methods must not be no-ops (the previous version's mistake)

pi-goal's `updateUI(ctx)` calls `ctx.ui.setWidget(GOAL_WIDGET_KEY,
factory, {placement:"aboveEditor"})` and `ctx.ui.setStatus("goal", ...)` on goal creation/update/events. `widgetRegistered`
is a module-level flag in pi-goal. If `setWidget` is a no-op during a Telegram turn:
- `widgetRegistered` is set to true, but the TUI widget is never registered → the local TUI does not show the goal status bar.
- When goal creation happens inside a Telegram turn, the TUI widget never appears.

→ This violates principle 2. **Status methods must be forwarded to the TUI base.**

### 2.5 The essential constraint on `custom`

The factory of `ExtensionUIContext.custom<T>(factory)` is
`(tui, theme, kb, done) => Component & { render(width); handleInput(key); invalidate() }`,
opaque, with no structured protocol. pi-core's own RPC mode implements `custom` only as `async custom(){ return undefined }`.
pi-goal is a third-party package whose source we cannot change. Conclusion: **there is no generic bridge for `custom`**; the only option is "bridge known shapes + degrade safely on unknown ones".

## 3. Solution strategy (layered)

### Layer A — Selective forwarding (the core of the revised plan)

`create()` in `telegram-ui.ts` no longer spreads `...(base)`. Instead it **implements each method explicitly by category**:

| Method category | Methods | Implementation |
|---|---|---|
| **Interactive modals** | `confirm` `select` `input` `editor` `inputSecret` | Existing Telegram implementations, **kept**. Not forwarded to base (to avoid a TUI dialog grabbing focus). |
| **Interactive modals** | `custom` | New Telegram bridge (Layer B), **not forwarded to base**. |
| **Persistent/status UI** | `setWidget` `setStatus` `setWorkingMessage` `setWorkingVisible` `setWorkingIndicator` `setHiddenThinkingLabel` `setFooter` `setHeader` `setTitle` `setToolsExpanded` `getToolsExpanded` | **Forwarded to `base`** (keeps the TUI accurate). Not mirrored to Telegram (Telegram has its own status line mechanism; goal run notifications are already sent to Telegram by pi-goal through `ctx.ui.notify`). |
| **Editor/terminal input** | `onTerminalInput` `pasteToEditor` `setEditorText` `getEditorText` `setEditorComponent` `getEditorComponent` `addAutocompleteProvider` | **no-op** (the remote side must not touch the local editor; `getEditorText` returns `""`, `getEditorComponent` returns `undefined`). |
| **Theme** | `setTheme` `getTheme` `getAllThemes` | `getTheme`/`getAllThemes` forward to base (read-only, for factory rendering); `setTheme` forwards to base (a setting operation should really take effect). |
| **`theme` getter** | — | Points to the base theme (read-only; `theme.fg(...)` must work inside factories). |
| **`notify`** | — | Keeps the Telegram implementation (already Telegram; not forwarded to base. The local TUI's notify is handled by the TUI's own ctx.ui and does not belong to a Telegram turn). |

> Key invariant: `runWithTelegramUi` swaps the UI only inside **Telegram-triggered** turns/commands.
> When the local TUI user types `/goals`, it goes through the TUI's own command dispatch, `ctx.ui` is the TUI UI, and **this plan is not involved at all**,
> so behavior has zero change. This architecturally guarantees "Telegram does not affect the TUI".

### Layer B — Bridge pi-goal's `custom`

Implement `custom<T>(factory): Promise<T | undefined>` in `lib/custom-dialogs.ts`:

1. Build a minimal `tui` shim (it only needs to satisfy `new Editor(tui, editorTheme)` /
   `tui.requestRender()` in the pi-goal factory). No real terminal is needed; the factory just has to run and `render(width)` has to return text.
   - If the `Editor` dependency surface is too large for a shim → fall back to **matching factory source features**
     (`factory.toString()` contains `GoalQuestionnaireResult` / `confirmationText`), used only for the
     confirmation dialog + single-question case.
2. `const component = factory(tuiShim, theme, kbShim, done)`, with try/catch.
3. `const text = stripAnsi(component.render(80).join("\n"))`.
4. **Recognize the shape from the rendered text**:
   - **Goal confirmation dialog**: the first line matches `^Confirm (Sisyphus )?Goal Draft` and the last two options contain
     `Confirm — create this goal now` and `Continue chatting`.
     → Reuse the existing flow mechanism `sendOrReplaceButtons` to send `✅ Confirm` / `💬 Continue chatting`;
     `/stop`/timeout counts as cancel.
     → Confirm: `done({ questions:[], answers:[{ id:"confirm", question:<header>, answer:"Confirm — create this goal now", wasCustom:false }], cancelled:false })`
     → Continue: replace `answer` with `"Continue chatting — keep refining"`.
     → Cancel: `done({ questions:[], answers:[], cancelled:true })`.
     (`showProposalDialog` only looks at `result.answers[0]?.answer.startsWith("Confirm")` and
     `cancelled`. The component is bypassed and only these two fields matter.)
   - **`goal_question` single question**: the rendered text has the current question + the `displayOptions()` labels.
     → Send the question text + option buttons (paginated) + `✏️ Type answer` (switch to free text, take the next Telegram
     text message) + `Cancel`.
     → `done({ questions:[{...}], answers:[{ id, question, answer, wasCustom }], cancelled:false })`.
   - **`goal_questionnaire` multiple questions**: degraded in v1 —
     `done({ questions:[], answers:[], cancelled:true })` +
     `notify("Multi-question questionnaires are not yet supported on Telegram. Please ask the questions one by one in the chat.")`.
     After the agent receives cancelled, it keeps asking in the Telegram chat, which is an acceptable experience.
   - **Unknown component**: `notify("⚠️ A terminal-only dialog was cancelled automatically. The agent will continue.")` then **do not call `done`**,
     and `return undefined` (consistent with RPC-mode `custom`). When `custom` returns undefined, pi-goal
     takes the cancelled path, which is safe.
5. Throughout, reuse the existing flow in `telegram-ui.ts` (`beginFlow / waitInput / sendOrReplaceButtons /
   resolveInput`), consistent with `confirm/select`, with no reinvented wheel. `done` is called only once.

**Safety invariant**: any detection failure lands on "unknown component → `undefined`/cancelled" and **never hangs**. The strings detection depends on
(header, two options) are literals in pi-goal and fairly stable across versions; even if they change later, it degrades safely.

### Layer C — Consistency and lifecycle

- **Swap lifecycle**: `runWithTelegramUi` restores the TUI UI in `finally` with `setUIContext(previousUi)`.
  Our Telegram UI forwards `setWidget` to base (the TUI UI), so the widget is registered on the TUI, and after the turn ends
  the TUI widget is still shown correctly. **There is no "TUI widget lost / modal left behind after the turn ends"**.
- **`custom` does not call the TUI's custom**: no modal is installed on the TUI, so no focus grab is left behind after the turn ends.
- **`hasUI` stays true**: pi-goal takes the dialog branch (which we bridge to Telegram) and does not wrongly take auto-confirm.

### Layer D — Documentation

Add a "Third-party dialog support" section to `README.md`: the supported pi-goal scenarios, the `goal_questionnaire` multi-question degradation,
the tested pi-goal version range, and the guarantee that "a Telegram turn does not affect the local TUI".

## 4. Concrete change list

### `lib/telegram-ui.ts` (main change)
- Rewrite `create(chatId)`: no more `...(base)`; implement each method explicitly following the Layer A table.
- Keep the `base` reference (already obtained in `create`) for forwarding status methods.
- Add `custom<T>(factory)`: delegates to `lib/custom-dialogs.ts`, passing `base.theme` and the flow utilities.
- Status method forwarding: `setWidget: (k,c,o)=>base.setWidget(k,c,o)`, `setStatus`,
  `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`,
  `setFooter`, `setHeader`, `setTitle`, `setToolsExpanded`, `getToolsExpanded`, `setTheme`,
  `getTheme`, `getAllThemes` are all `=> base.xxx(...)`.
- Editor-type no-ops: `onTerminalInput: ()=>()=>{}`, `pasteToEditor: ()=>{}`,
  `setEditorText: ()=>{}`, `getEditorText: ()=>""`, `setEditorComponent: ()=>{}`,
  `getEditorComponent: ()=>undefined`, `addAutocompleteProvider: ()=>{}`.
- `theme` getter: `get theme() { return base.theme; }`.
- `notify/confirm/input/editor/select/inputSecret`: keep the existing Telegram implementations.
- Extract the button flow into a shared utility for the `custom` bridge to reuse.

### `lib/custom-dialogs.ts` (new)
- Export `bridgeCustomDialog<T>(deps: { factory, theme, width, sendButtons, waitInput, cancel, notify }) => Promise<T | undefined>`.
- Inside: tui shim → instantiate → render → stripAnsi → shape recognition → Telegram button flow → call `done`.
- Inline `stripAnsi` (a one-line regex, not depending on the pi-core deep path `dist/utils/ansi.js`).

### `lib/html.ts` or new `lib/ansi.ts`
- Add a `stripAnsi(s)` utility (reuse it if it already exists).

### `lib/__tests__/telegram-ui-custom.test.ts` (new)
- A stub factory (`render(width)` returns fixed text lines) simulates the goal confirmation dialog:
  - Click `✅ Confirm` → `done` receives `answers[0].answer === "Confirm — create this goal now"`, `cancelled:false`.
  - Click `💬 Continue chatting` → `answer === "Continue chatting — keep refining"`.
  - `/stop`/timeout → `cancelled:true`.
- Unknown-component factory (render returns random text) → `bridgeCustomDialog` resolves `undefined`, and `notify` is called once.
- One more: a status-method forwarding test — call `setWidget("goal", factory, opts)` on the Telegram UI and
  assert `base.setWidget` was called with the same arguments (ensures the TUI widget is written back).

### `README.md`
- Add a "Third-party dialog support / Telegram does not affect the TUI" section.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The header/option strings change after a pi-goal upgrade | Detection failure degrades safely to `undefined` (cancelled) and never hangs; the docs state the tested version. |
| The tui shim cannot satisfy the `Editor` dependency | Fall back to factory source feature matching (confirmation/single question only). |
| When forwarding status methods to base, base is stale (`runner.uiContext` is reset after a session rebind) | `create()` takes the latest base each time; after a rebind the Telegram turn calls `create()` again and re-fetches base, never holding an old reference across turns. |
| Degrading multi-question `goal_questionnaire` to cancelled hurts the experience | The agent keeps asking in the Telegram chat, which is acceptable; a driver-style bridge can be iterated on later. |
| `setWidget` forwarded to the TUI makes the goal widget suddenly appear for the local TUI user | This is the **correct behavior** (the goal really is active), not breakage; it matches the result of the local user typing `/goals-set` themselves. |
| The local TUI user is also operating during a Telegram turn | Interactive modals go only to Telegram and do not grab TUI focus; status writes go back to the TUI so the local user sees the real state; editor no-ops prevent the remote side from tampering with the local draft. Together these three keep the TUI experience uninterrupted. |
| An unknown extension depends on `custom` returning a real structure | Same as RPC-mode behavior (`undefined`); extensions should already handle `custom` being unsupported. |

## 6. Acceptance criteria

1. **The TUI is not interrupted**: when Telegram sends `/goals <topic>` and the agent finishes the discussion and calls `propose_goal_draft`,
   the TUI **shows no** confirmation dialog or keyboard focus grab; Telegram receives `✅ Confirm` / `💬 Continue chatting` buttons.
2. **Telegram is interactive**: click Confirm → the goal is created, the agent ends this turn and reports; click Continue → the agent
   keeps asking in the Telegram chat; `/stop`/timeout → cancelled.
3. **TUI state is accurate (key addition)**: for a goal created from Telegram, its `GoalWidget` and status line
   are **shown correctly** in the local TUI (because `setWidget/setStatus` are forwarded to base). After the turn ends the TUI has no leftover modal.
4. **Local TUI `/goals` is completely unchanged**: typing `/goals` in the local terminal goes through the TUI's own UI, the confirmation dialog pops up normally in the TUI,
   and behavior matches that before this extension was installed.
5. **goal_question single question**: Telegram shows the question + option buttons + a free-text entry; after answering, the agent receives the answer.
6. **goal_questionnaire multiple questions**: Telegram receives the degradation notice, and the agent asks the questions one by one in the chat instead.
7. **Unknown custom**: Telegram receives the "cancelled automatically" notice, and the agent does not hang.
8. **Editor isolation**: during a Telegram turn, any `setEditorText/pasteToEditor` does not affect the local TUI input box.
9. `npm run typecheck` passes; `npm test` is all green (including the new tests); the `TelegramUiRuntime` type signature does not break
   the existing calls in `controller.ts/index.ts`.
