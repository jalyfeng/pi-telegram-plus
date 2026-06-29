# Logging — pi-telegram-plus

Design and implementation notes for the extension's file-based logging system.
Implemented in [`lib/logger.ts`](../lib/logger.ts); wired up in
[`index.ts`](../index.ts) at activation.

## 1. Why

Before this system the extension had **no logging**:

- One `console.warn` in `telegram-api.ts` (HTML-fallback diagnostics). This
  polluted the pi TUI input box — pi runs in TUI/RPC/JSON modes where console
  output corrupts the terminal.
- ~30 silent rejections across `lib/`: `catch {}`, `.catch(() => undefined)`,
  and `catch { /* suppressed */ }`. Network errors, lock-cleanups, render-event
  failures, and callback acks were all swallowed with zero trace.

Remote Telegram issues (a failed send, a stuck poll, an undelivered render
event) were therefore **un-diagnosable** after the fact. This system gives every
swallowed error a structured, on-disk trace without touching the terminal.

## 2. Interface

```ts
import { log, initLogger, getLogDir, getLogLevel, isLoggingEnabled } from "./logger.ts";

log.debug(msg, fields?);
log.info(msg, fields?);
log.warn(msg, fields?);
log.error(msg, fields?);

// Scoped sub-logger — every record carries `scope` (nested scopes join with ":"):
const apiLog = log.child("telegram-api");
apiLog.warn("HTML fallback", { reason, snippet });

// `.catch` helper — logs the rejection at <level> with msg + fields + err,
// then resolves the chain to undefined (preserves `T | undefined` for probes):
await stat(path).catch(log.child("session").swallow("debug", "stat target cwd failed", { path }));
```

`initLogger({ dir?, level?, maxFileSize?, maxFiles?, enabled? })` is called once
from `index.ts` at activation. The root `log` and every `child()` share one
config object, so re-initialization is picked up by existing loggers.

## 3. Levels & semantics

| Level   | Numeric | Use for |
|---------|---------|---------|
| `debug` | 10      | Best-effort cleanup (rm temp, lock release, chmod), existence probes (`stat`), callback acks, typing pulses |
| `info`  | 20      | Normal operational events (default minimum level) |
| `warn`  | 30      | Recoverable failures a user might care about: HTML fallback, sendText/sendDocument failures, lock cleanup on stale path |
| `error` | 40      | Unexpected failures in prompt dispatch (steer/queue task rejected), top-level wrapper failures |

Minimum level is set at `initLogger` and overridable via the
`PI_TELEGRAM_PLUS_LOG_LEVEL` environment variable (`debug`/`info`/`warn`/`error`).

## 4. Sink — file location & format

- **Directory:** `<agent dir>/logs/`, where the agent dir is `~/.pi/agent/` or
  `$PI_CODING_AGENT_DIR` (the same dir that holds `tg.json`). Resolved by
  `defaultLogDir()` in `logger.ts`, which mirrors `config.getAgentDir()` without
  importing it (to avoid a config↔logger import cycle).
- **One file per UTC day:** `pi-telegram-plus-YYYY-MM-DD.log`.
- **Format: JSON Lines** — one self-contained JSON object per line, so a remote
  session can be inspected with `grep`/`jq` after the fact:
  ```json
  {"ts":"2026-06-29T21:03:33.123Z","level":"warn","scope":"telegram-api","msg":"HTML sendMessage rejected; falling back to plain text","reason":"can't parse entities: unexpected character","snippet":"<b>hi</b>"}
  ```
- **Schema:** `ts` (ISO 8601, UTC) · `level` · `msg` · optional `scope` ·
  arbitrary caller `fields`. `Error` instances serialize to
  `{name, message, stack}`; non-serializable values (circular, BigInt, Symbol,
  functions) are downgraded to strings; the line is always valid JSON.

## 5. Rotation

logrotate-style, per day:

- When the current day file would exceed `maxFileSize` (default **10 MiB**), the
  base file is renamed to `…-YYYY-MM-DD.1.log`, existing `.N` shift up to
  `.N+1`, and the oldest beyond `maxFiles` (default **5**) is dropped. The next
  append recreates the base file fresh.
- A day rollover (UTC midnight) opens a new base file and re-stats its size.
- In-memory byte counting avoids a `stat()` on every write; rotation is driven
  by the running size estimate. Multi-process interleaving (multiple pi bots)
  may slightly overshoot the cap on a single file — acceptable over a hard
  crash, and JSON Lines stays parseable across interleaved appends.

## 6. Invariants (non-negotiable)

1. **Never touches the console.** No `console.log/warn/error` anywhere in the
   extension outside `logger.ts`. The logger writes files only. (Enforced by
   the test suite — see `telegram-api.test.ts`'s `console.warn` spy.)
2. **Never throws.** Every public method swallows its own internal errors. A
   logging failure (read-only fs, disk full, unserializable field) can never
   crash the extension or alter control flow. The localized silent catches
   inside `logger.ts` are the only intentional silent catches left in the codebase.
3. **Serialized writes.** A single module-level promise chain orders all appends
   and rotations. The root logger and every `child()` share one sink, so they
   cannot interleave or race on the same day file.
4. **Best-effort degradation.** If the log directory cannot be created, the
   logger flips to disabled and becomes a no-op for the rest of the process.

## 7. Migration points (the silent catches this replaced)

Every `catch {}`, `.catch(() => undefined)`, and `console.warn` in `lib/` and
`index.ts` was replaced with a scoped `logger` call. Files touched:

| File | Sites | Scope | Notes |
|------|-------|-------|-------|
| `telegram-api.ts` | 1 `console.warn` + 5 `.catch` | `telegram-api` | HTML fallback now logs to file; `removeInlineKeyboard`/`sendChatAction`/fallbacks at debug; `deleteMessage` at warn |
| `polling.ts` | 6 `.catch` | `polling` | Stale-lock rm, candidate-tmp rm, lock-touch write, release — debug/warn |
| `attachments.ts` | 2 `.catch` | `attachments` | sendText error-notice failures at warn |
| `renderer.ts` | 5 `.catch` + 5 `catch {}` | `renderer` | Edit-fallback pointer, sendPhoto/sendDocument, temp-code rm, and all `/* suppressed */` render-event handlers now log |
| `controller.ts` | 5 `.catch` + 1 `catch {}` | `controller` | Steer/queue task rejections at error; enqueued-turn wrapper + media receipt at warn; callback ack + waitForIdle interrupt at debug |
| `config.ts` | 3 `.catch` | `config` | Stale-lock rm, rmdir-on-release, chmod — warn |
| `commands/telegram-commands.ts` | 3 `.catch` | `tg-commands` | `getTelegramBotUsername` failures during token setup at warn |
| `commands/session.ts` | 1 `.catch` | `session` | `stat` target-cwd probe at debug (existence check, failure is user-visible via notify) |
| `heartbeat.ts` | 1 `catch {}` | `heartbeat` | Typing-pulse sendChatAction at debug |
| `menu-commands.ts` | 1 `catch {}` | `menu-commands` | `syncTelegramCommands` at warn |
| `index.ts` | 1 `.catch` | `polling` | sendText polling-failure notice at error |

Non-empty recovery catches (e.g. `renderer.ts`'s edit-failed→sendText fallback,
`polling.ts`'s rename-failed→rm+return) were left intact — they perform real
recovery and are not "silent" per the objective's definition
(`catch {}` / `.catch(() => undefined)`).

## 8. Configuration & operation

- **Env override:** `PI_TELEGRAM_PLUS_LOG_LEVEL=debug|info|warn|error` (read in
  `index.ts`).
- **Location query:** `getLogDir()` returns the active log directory (for
  `/status` diagnostics and tests).
- **No Telegram view command** by design (per the confirmed goal): inspect logs
  by reading the file directly, e.g.
  `tail -f ~/.pi/agent/logs/pi-telegram-plus-$(date -u +%F).log | jq .`

## 9. Testing

`lib/__tests__/logger.test.ts` covers: JSON Lines schema & scope nesting, level
filtering, Error serialization, unserializable-field downgrade, logrotate-style
rotation (base file stays under cap, `.1` suffix appears), no-throw degradation
on an unwritable dir, and accessor reflection.

`lib/__tests__/telegram-api.test.ts` was updated to assert the warn now lands in
the log file (not `console.warn`) and to enforce the no-console invariant.

## 10. Out of scope

- A `/logs` Telegram command to view recent records (explicitly declined).
- Migrating non-empty recovery catches that already do real work.
- A memory ring buffer / `ui.notify` sink (the confirmed goal chose file-only).
- Log shipping / remote aggregation.