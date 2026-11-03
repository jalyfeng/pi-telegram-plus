# Compatibility

- **Supported hosts:** pi coding agent `1.4.0` (`@earendil-works/pi-coding-agent`, pinned in
  `package.json`) and OMP `18.14.x` (`@oh-my-pi/pi-coding-agent`).
- **Requires:** Node.js `>=22.19.0`.
- **Any other version is refused.** At startup the extension reads the host version (pi:
  `VERSION` from `@earendil-works/pi-coding-agent`; OMP: `VERSION` from `@oh-my-pi/pi-utils`).
  If the version does not match, or cannot be read, it installs none of its host hooks, shows
  the reason in the status bar and answers Telegram messages with that reason. There is no
  degraded mode and no fallback path (plan §0.1, decisions 44 and 46).
- **Enabling a new host version** means reading the new host source, updating the adapters
  and the pinned version, and passing the unit, contract and E2E suites on it. Until then it
  stays refused.

The multi-version matrix (`test:pi-versions`, `compat:gen`, `compat:check`,
`docs/compat-results.json`) was removed with the move to a single supported version.

## Why the extension loads without a static host import

Every `@earendil-works/pi-coding-agent` reference in this package is either an `import type`
or a guarded dynamic `import()`. Optional symbols are resolved once at module scope via
top-level `await`, so extension registration stays synchronous: pi rejects extension API
calls made after an `await` inside the extension factory (`Extension runtime not initialized.
Action methods cannot be called during extension loading.`), and it awaits module scope
before invoking the factory.

## OMP (`@oh-my-pi/pi-coding-agent`)

OMP is a pi fork with a rewritten session core, so it does not share pi's attach point: its
`AgentSession` has no `bindExtensions()`. The extension runner is built *before* the session
and handed to `new AgentSession(...)`, so a patched prototype never fires.

Capture therefore resolves OMP's process-global agent registry on every lookup:

```ts
AgentRegistry.global().get(MAIN_AGENT_ID)?.session        // "Main"
  ?? AgentRegistry.global().list().find(ref => ref.kind === "main")?.session
```

`get(mainId)` is the fast path; the `list()` scan covers embedded hosts that pass a custom
root `agentId`. The ref's session is re-attached on `/new` and session switches and detached
to `null` on dispose. Resolution happens per call rather than once at load, so capture also
works when the extension loads after the session already exists (`/reload`).

Inside an OMP extension, `import("@earendil-works/pi-coding-agent")` is aliased to the OMP
module. Host detection therefore checks for the OMP version first and only then treats the
host as pi.

OMP also resolves the package under two module paths, so one process holds two copies of
this extension, each with its own module state. Only the copy whose prototype patch landed
first learns about the captured TUI mode, so the bridge state hangs off a process-wide key in
`lib/tui-bridge.ts`; otherwise the copy serving the chat would conclude there is no bridge.

OMP keeps its runner UI context private (`runner.setUIContext()` does not exist), so the
plugin overrides `getUIContext()` / `createContext()` per runner: during a Telegram turn they
return the routed UI, otherwise the host TUI. Built-in `ask` and eval-prelude contexts receive
`ui` from OMP's private `ToolContextStore` and are routed by wrapping the tool execution
context and `ToolSession.getToolContext`.

OMP's advertised command catalog over-reports: entries such as `/theme`, `/undo`, `/help` and
`/cost` are not dispatched by its input handler, so typing them falls through to the model as
prompt text. Telegram forwards them to the host editor the same way, so both surfaces behave
identically.

## Dialog support

How a dialog raised by a Telegram-started command or turn reaches the chat. "Structured" means the plugin reads the dialog's data from the host (call arguments, component fields, or the semantic description) and answers through the host's own input or event path; it never parses screen text to decide what to show.

| Dialog | pi 1.4.0 | OMP 18.14.x |
|---|---|---|
| Extension `select` / `confirm` / `input` | Structured (race: the answer goes to the waiting call, the host's copy is closed by its cancel signal) | Structured (race) |
| Extension `editor` | Structured (component fields, answered through the host input) | Structured (race) |
| `ask` tool, single and multi-question | — (pi has no ask tool) | Structured (race; the answer object is built from the Telegram choices) |
| Tool approval | — | Structured (race: Allow once / session / Deny) |
| Model picker (`/model`) | Structured (component fields) | Structured (semantic description, including the role-assignment step) |
| Scoped models (`/scoped-models`) | Structured | — |
| Settings (`/settings`) | Structured (values, submenus, search) | Structured (pages, on/off and choice rows; other row types say "change it in the terminal") |
| Sessions (`/resume`), session tree (`/tree`), fork/clone message lists | Structured | Structured where the picker describes itself; otherwise announced |
| Login providers and login prompts | Structured; typed keys are secrets (deleted from the chat, never echoed) | Structured (semantic description) |
| `@capyup/pi-goal` dialogs | Dedicated adapter (§4.6.6 exception 1) | Dedicated adapter |
| Anything else (unknown `custom()` components, dialogs with no readable data) | Announced: "The terminal shows a dialog Telegram can't handle", with a single Cancel button | Same |

Known gaps: OMP settings rows other than on/off and choice can only be changed in the terminal. In the mock environment OMP does not persist settings toggled from either side, so the state-equivalence suite skips that case.

## Secrets

Values typed into secret prompts (the plugin's own and the host's login prompts) are remembered per chat for 24 hours, or until a new session starts, and replaced with `***` in everything the plugin sends: dialog text and buttons, command output, assistant replies (including code blocks sent as files), and plugin notices. Values shorter than 8 characters are not tracked, so short secrets are not masked. Secrets you paste as an ordinary chat message are not tracked either.

## Verification

| Suite | What it checks | Command |
|---|---|---|
| Typecheck | `tsc --noEmit` over the package | `npm run typecheck` |
| Unit / regression | Module and contract tests | `npm test` |
| Round trip | pi in `tmux` + mock Telegram Bot API + mock OpenAI provider: `getMe`, the `getUpdates` loop, a real turn, the reply sent back, and the update-cursor rewind after restart | `npm run test:e2e` |
| OMP round trip | The same for OMP `18.14.x`, plus `/new` confirmation staying on Telegram | `npm run test:e2e:omp` |
| TUI bridge | Host command catalog, dialogs reaching Telegram, `!`/`!!` paths on both hosts | `npm run test:e2e:tui-bridge` |
| Command acceptance | Every advertised command and the `/tg` menu levels on both hosts | `npm run test:e2e:commands` |
| Dialog round trip | Extension `select` / `confirm` / `input` / secret input / `custom` and the `ask` tool, answered from Telegram and from the terminal, asserting the value the host actually resolved | `npm run test:e2e:dialogs` |
| Interaction parity | Host screen and Telegram surface recorded side by side for every advertised command | `npm run test:e2e:parity` |
| State equivalence | The same operation done once in the terminal and once from Telegram on fresh hosts; the resulting host state (session name, model, settings, scoped models, OMP model roles) must match | `npm run test:e2e:state` |
| Real Bot API smoke | One message through api.telegram.org (send → edit → delete), plus a rejected-tag check | `npm run test:e2e:real` |

The E2E suites use `node_modules/.bin/pi` (`--pi-bin` or `--pi` overrides it). Commands that reach external services (`/share`, `/collab`, `/join`, `/leave`, `/update`, `/upgrade`) are not run by the suites. Steps that are
known to fail until a later migration task lands are listed in
`scripts/e2e/pending-migration.json`; only regressions outside that list count as failures.

**What the mocks cannot prove.** The Bot API is mocked, so the suites observe neither real
rate limits (`429`), network retries, nor the `409` Conflict of two pollers on one token. The
provider is scripted, so model output is fixed; streaming cadence, 4096-character splitting
and varied tool arguments only come from real runs.

## Publish gate

`prepublishOnly` (mirrored by the publish workflow) runs `npm test`, `npm run typecheck` and
`npm run changelog:check`. E2E is run manually before a release, because each run starts
isolated `tmux` sessions.
