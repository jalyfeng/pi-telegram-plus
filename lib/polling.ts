import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentDir } from "./config.ts";
import { getPendingTelegramUpdates, getTelegramUpdates } from "./telegram-api.ts";
import type { TelegramConfig, TelegramUpdate } from "./types.ts";
import { log } from "./logger.ts";
import { runDetached } from "./tui/command-context.ts";

const pollLog = log.child("polling");

export type TelegramPollingRuntime = {
  start(): void;
  stop(): Promise<void>;
  isActive(): boolean;
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const POLL_LOCK_STALE_MS = 45_000;
const POLL_LOCK_TOUCH_MS = 5_000;
// Keep live candidate dirs long enough that a concurrent stager cannot be swept mid-write.
const POLL_LOCK_CANDIDATE_MAX_AGE_MS = POLL_LOCK_TOUCH_MS * 2;

type PollingLockOwner = {
  id: string;
  pid: number;
  at: string;
  touchedAt: string;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

function tokenLockPath(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
  return join(getAgentDir(), `tg-poll-${hash}.lock`);
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    pollLog.debug("isPollingLockStale stat failed (treated as not stale)", { err });
    return false;
  }
}

function ownerText(owner: PollingLockOwner): string {
  return JSON.stringify(owner, null, 2) + "\n";
}

async function readPollingLockOwner(ownerPath: string): Promise<PollingLockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<PollingLockOwner>;
    if (typeof owner.id !== "string" || typeof owner.pid !== "number") return undefined;
    return {
      id: owner.id,
      pid: owner.pid,
      at: typeof owner.at === "string" ? owner.at : "",
      touchedAt: typeof owner.touchedAt === "string" ? owner.touchedAt : "",
    };
  } catch (err) {
    pollLog.debug("readPollingLockOwner failed (treated as no owner)", { err });
    return undefined;
  }
}

type PollingLockSnapshot = {
  exists: boolean;
  stale: boolean;
  staleId: string;
};

async function inspectPollingLock(lockPath: string): Promise<PollingLockSnapshot> {
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (!lockStat) return { exists: false, stale: false, staleId: "missing" };
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readPollingLockOwner(ownerPath);
  const heartbeatPath = owner ? join(lockPath, `heartbeat-${owner.id}`) : ownerPath;
  const modifiedAt = await stat(heartbeatPath).then((value) => value.mtimeMs).catch(() => lockStat.mtimeMs);
  const age = Date.now() - modifiedAt;
  const sameProcess = owner?.pid === process.pid;
  return {
    exists: true,
    // A lock held by this very process belongs to a runtime that is being
    // superseded: an extension reload / session replacement re-activates the
    // plugin in-process, and the newest runtime always wins the token. The old
    // loop is not necessarily dead yet — it keeps polling until session_shutdown
    // aborts it — but breaking its lock is safe: that loop's release() only
    // retires the live path while it still owns it (see acquirePollingLock), so
    // it can never delete this successor's lock. Breaking it now avoids the 45s
    // stale window and the 30s poll backoff that would otherwise stall the
    // replacement session's first command.
    stale: owner ? sameProcess || age > POLL_LOCK_STALE_MS || !isPidAlive(owner.pid) : age > POLL_LOCK_STALE_MS,
    staleId: (owner?.id ?? `unknown-${Math.trunc(modifiedAt)}`).replace(/[^a-zA-Z0-9_-]/g, "_"),
  };
}

async function removeLockArtifact(path: string, reason: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(pollLog.swallow("debug", reason, { path }));
}

/**
 * Best-effort cleanup of tombstones left by prior retire/quarantine and of
 * abandoned candidate directories from crashed acquirers. Safe because live locks
 * use the bare `*.lock` name; only suffix artifacts are removed.
 *
 * Young `.candidate-*` dirs are retained so a concurrent acquirer staging
 * owner/heartbeat files is not deleted out from under write/rename.
 */
async function cleanupPollingLockArtifacts(lockPath: string, retainPath?: string): Promise<void> {
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const names = await readdir(dir).catch(() => [] as string[]);
  const cleanedAt = Date.now();
  await Promise.all(names.map(async (name) => {
    if (name === base) return;
    const isRetired = name.startsWith(`${base}.retired-`);
    const isCandidate = name.startsWith(`${base}.candidate-`);
    if (!isRetired && !isCandidate) return;
    const path = join(dir, name);
    if (retainPath && path === retainPath) return;
    if (isCandidate) {
      const ageMs = await stat(path)
        .then((value) => cleanedAt - value.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (ageMs < POLL_LOCK_CANDIDATE_MAX_AGE_MS) return;
    }
    await removeLockArtifact(path, "remove polling lock artifact failed");
  }));
}

async function quarantineStalePollingLock(lockPath: string): Promise<boolean> {
  const snapshot = await inspectPollingLock(lockPath);
  if (!snapshot.exists) return true;
  if (!snapshot.stale) return false;
  const stalePath = `${lockPath}.retired-${snapshot.staleId}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  // Rename frees the live lock path atomically; the tombstone is disposable.
  await removeLockArtifact(stalePath, "remove retired polling lock failed");
  return true;
}

/**
 * Atomically claim the polling lock by fully preparing an owner directory and
 * renaming that non-empty candidate into place. No process can observe an
 * ownerless published lock or overwrite another owner's metadata.
 */
async function acquirePollingLock(token: string): Promise<{ owns: () => Promise<boolean>; release: () => Promise<void> } | undefined> {
  await mkdir(getAgentDir(), { recursive: true });
  const lockPath = tokenLockPath(token);
  const ownerPath = join(lockPath, "owner.json");
  const owner: PollingLockOwner = {
    id: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
    touchedAt: new Date().toISOString(),
  };
  const candidatePath = `${lockPath}.candidate-${owner.id}`;
  const heartbeatName = `heartbeat-${owner.id}`;

  // Drop abandoned leftovers, but retain any in-flight candidate we are about to (re)use.
  await cleanupPollingLockArtifacts(lockPath, candidatePath);

  try {
    await mkdir(candidatePath, { mode: 0o700 });
    await writeFile(join(candidatePath, "owner.json"), ownerText(owner), { mode: 0o600, flag: "wx" });
    await writeFile(join(candidatePath, heartbeatName), owner.touchedAt, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    throw error;
  }

  // Atomically quarantine a stale lock. The owner-derived tombstone path keeps
  // concurrent stale-lock breakers from deleting a newly acquired lock.
  if (!await quarantineStalePollingLock(lockPath)) {
    await rm(candidatePath, { recursive: true, force: true });
    return undefined;
  }

  try {
    await rename(candidatePath, lockPath);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(pollLog.swallow("debug", "remove polling lock candidate failed", { candidatePath }));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return undefined;
    throw error;
  }

  // Sweep any race-created artifacts now that we own the live lock path.
  await cleanupPollingLockArtifacts(lockPath);

  const heartbeatPath = join(lockPath, heartbeatName);
  const touch = setInterval(() => {
    owner.touchedAt = new Date().toISOString();
    void writeFile(heartbeatPath, owner.touchedAt, { mode: 0o600 })
      .catch(pollLog.swallow("warn", "polling lock heartbeat write failed", { heartbeatPath }));
  }, POLL_LOCK_TOUCH_MS);

  const owns = async () => (await readPollingLockOwner(ownerPath))?.id === owner.id;
  return {
    owns,
    release: async () => {
      clearInterval(touch);
      // A newer runtime in this process may already have broken and replaced
      // this lock (same-pid takeover on reload). Only retire the live path when
      // we still own it, so a superseded loop never deletes its successor's
      // lock out from under it.
      if (!await owns()) return;
      const retiredPath = `${lockPath}.retired-${owner.id}`;
      try {
        await rename(lockPath, retiredPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return;
        pollLog.warn("retire polling lock on release failed", { lockPath, error });
        return;
      }
      // Tombstone only exists to free the live path safely; delete immediately.
      await removeLockArtifact(retiredPath, "remove retired polling lock on release failed");
      await cleanupPollingLockArtifacts(lockPath);
    },
  };
}


export type TelegramUpdateBatchDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (config: TelegramConfig) => void;
  persistConfig: (config: TelegramConfig) => Promise<void>;
  persistUpdate?: (config: TelegramConfig, update: TelegramUpdate) => Promise<void>;
  /**
   * Overwrite (lower) the stored cursor after proof that it is not part of the
   * bot's current update_id stream. See `createTelegramPollingRuntime`.
   */
  resetCursor?: (updateId: number) => Promise<void>;
  shouldProcess?: () => boolean;
  handleUpdate: (update: TelegramUpdate) => Promise<void>;
  /** `context` distinguishes a transport/polling failure from an update
   *  handler or cursor-persist failure ("processing"). */
  onError: (error: unknown, context?: "polling" | "processing") => void;
};

type UpdateCursorContext = { update: TelegramUpdate; deps: TelegramUpdateBatchDeps };
const updateCursorContext = new AsyncLocalStorage<UpdateCursorContext>();

/**
 * Commit the cursor for the update currently being processed, before its
 * handler performs an irreversible side effect — a session replacement or
 * runtime reload. Those commands re-activate the plugin in-process; the
 * replacement runtime re-reads the on-disk cursor, and if this update is still
 * unconfirmed Telegram re-serves it and the command runs a second time (a
 * second new session, a second reload). Handlers that replace the session call
 * this immediately before the host's replacement method. No-op outside an
 * update context. Best-effort: a persist failure leaves the cursor where it
 * was, and the normal post-handler persist still runs.
 *
 * @internal Exported for the session/reload handlers; not public API.
 */
export async function checkpointCurrentUpdateCursor(): Promise<boolean> {
  const ctx = updateCursorContext.getStore();
  if (!ctx) return false;
  const { update, deps } = ctx;
  const cursor = deps.getConfig().lastUpdateId;
  if (typeof cursor === "number" && update.update_id <= cursor) return true;
  const nextConfig = { ...deps.getConfig(), lastUpdateId: update.update_id };
  try {
    if (deps.persistUpdate) await deps.persistUpdate(nextConfig, update);
    else await deps.persistConfig(nextConfig);
    deps.setConfig(nextConfig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process one getUpdates batch in strict order. If handling or persisting an
 * update fails, stop immediately: later updates must not advance lastUpdateId
 * past the failed update, otherwise Telegram will never deliver it again.
 *
 * @internal Exported for tests; not part of the public package API.
 */
export async function processTelegramUpdatesBatch(
  updates: TelegramUpdate[],
  deps: TelegramUpdateBatchDeps,
  signal?: AbortSignal,
): Promise<boolean> {
  const batchToken = deps.getConfig().botToken;
  for (const update of updates) {
    if (signal?.aborted || (deps.shouldProcess && !deps.shouldProcess())) return true;
    // Telegram re-serves updates that were processed but not yet confirmed
    // (a backlog probe with offset 0, or a fetch issued before the cursor
    // advanced). Re-running one would repeat its side effects — fatally so for
    // /reload, which would fire ctx.reload() again on every re-delivery.
    const cursor = deps.getConfig().lastUpdateId;
    if (typeof cursor === "number" && update.update_id <= cursor) continue;
    try {
      await updateCursorContext.run({ update, deps }, () => deps.handleUpdate(update));
    } catch (error) {
      deps.onError(error, "processing");
      return false;
    }
    if (deps.getConfig().botToken !== batchToken) return true;
    const nextConfig = { ...deps.getConfig(), lastUpdateId: update.update_id };
    try {
      if (deps.persistUpdate) await deps.persistUpdate(nextConfig, update);
      else await deps.persistConfig(nextConfig);
      deps.setConfig(nextConfig);
    } catch (error) {
      deps.onError(error, "processing");
      return false;
    }
  }
  return true;
}

/**
 * Rewind a cursor that is ahead of the bot's real update_id stream.
 *
 * Telegram returns the first update with `update_id >= offset`, and the poller
 * always asks for `lastUpdateId + 1`. An update below that offset therefore
 * proves the stored cursor is not part of this bot's stream — seen in practice
 * when a bot is deleted and re-created, a token moves between bots, or an
 * intermediary (proxy or self-hosted Bot API server) assigns its own update_id
 * sequence.
 *
 * Such a cursor is permanent unless corrected: every persist path is a monotonic
 * max, so polling would keep asking for updates past the end of the stream.
 * Telegram then re-serves the earliest pending batch, which the poller re-handles
 * on every cycle — an unbounded replay that ends in chat flood control. Rewinding
 * to `firstUpdateId - 1` restores the invariant, and the batch below is handled
 * and persisted normally.
 *
 * Only an update STRICTLY below the cursor proves this. `first === stale` is the
 * ordinary re-delivery of the last processed (not yet confirmed) update — the
 * offset-0 backlog probe at startup returns it on every restart — and rewinding
 * for it would drop the cursor below an already-handled update, replaying its
 * side effects. The batch loop's `update_id <= cursor` skip covers that case.
 *
 * Best-effort by design: if the rewind fails the batch is still handled (it was
 * already acknowledged by this very request), leaving the loud log as the signal.
 */
async function resyncCursorIfOutOfRange(
  updates: TelegramUpdate[],
  deps: TelegramUpdateBatchDeps,
): Promise<void> {
  const stale = deps.getConfig().lastUpdateId;
  const first = updates[0]?.update_id;
  if (typeof stale !== "number" || typeof first !== "number" || first >= stale) return;
  const corrected = first - 1;
  pollLog.warn("poll cursor is ahead of the update stream; rewinding", {
    staleLastUpdateId: stale,
    deliveredUpdateId: first,
    correctedLastUpdateId: corrected,
  });
  try {
    await deps.resetCursor?.(corrected);
  } catch (error) {
    deps.onError(error);
  }
  deps.setConfig({ ...deps.getConfig(), lastUpdateId: corrected });
}

export function createTelegramPollingRuntime(deps: TelegramUpdateBatchDeps & {
  reloadConfig?: () => Promise<void>;
  onSuccess?: () => void;
  shouldPoll?: () => boolean;
}): TelegramPollingRuntime {
  let abort: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let pollLock: { token: string; owns: () => Promise<boolean>; release: () => Promise<void> } | undefined;

  const releasePollLock = async () => {
    const lock = pollLock;
    pollLock = undefined;
    await lock?.release().catch(pollLog.swallow("warn", "poll lock release failed"));
  };

  const ensurePollLock = async (token: string): Promise<boolean> => {
    if (pollLock?.token === token) {
      if (await pollLock.owns()) return true;
      await releasePollLock();
    } else {
      await releasePollLock();
    }
    const lock = await acquirePollingLock(token);
    if (!lock) return false;
    pollLock = { token, owns: lock.owns, release: lock.release };
    return true;
  };

  const loop = async (signal: AbortSignal) => {
    let backoffMs = MIN_BACKOFF_MS;
    // One backlog probe per runtime start (see getPendingTelegramUpdates).
    let probedCursor = false;

    try {
      while (!signal.aborted) {
        if (deps.shouldPoll && !deps.shouldPoll()) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        const token = deps.getConfig().botToken;
        if (!token) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        if (!(await ensurePollLock(token))) {
          deps.onError(new Error("Telegram polling skipped: another local pi instance is already polling this bot token."));
          await sleep(MAX_BACKOFF_MS, signal);
          continue;
        }

        try {
          // Refresh config after owning the poll lock. A process that waited for
          // the lock may have stale in-memory lastUpdateId; re-reading prevents it
          // from polling an already-persisted update after another process/reload.
          await deps.reloadConfig?.();
          if (signal.aborted) return;
          if (deps.shouldPoll && !deps.shouldPoll()) continue;
          const refreshedToken = deps.getConfig().botToken;
          if (!refreshedToken) continue;
          if (refreshedToken !== token) continue;

          // The first fetch of this runtime asks with the stored cursor, so a
          // cursor that is ahead of the bot's stream has to be detected before it
          // is used — otherwise a server that drops out-of-range requests discards
          // every message without a trace. Non-fatal: a failed probe just leaves
          // the stored cursor in place and the normal fetch reports real errors.
          if (!probedCursor) {
            probedCursor = true;
            if (typeof deps.getConfig().lastUpdateId === "number") {
              try {
                await resyncCursorIfOutOfRange(await getPendingTelegramUpdates(deps.getConfig(), signal), deps);
              } catch (error) {
                if (signal.aborted) return;
                pollLog.warn("cursor backlog probe failed; keeping the stored cursor", {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }

          const updates = await getTelegramUpdates(deps.getConfig(), signal);
          if (deps.getConfig().botToken !== refreshedToken) continue;
          if (deps.shouldPoll && !deps.shouldPoll()) continue;
          backoffMs = MIN_BACKOFF_MS;
          deps.onSuccess?.();

          await resyncCursorIfOutOfRange(updates, deps);
          const processed = await processTelegramUpdatesBatch(updates, deps, signal);
          if (!processed) {
            // The cursor stays on the failed update, so the next fetch returns
            // it again. Back off instead of hammering the API (and the user)
            // in a tight retry loop.
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          }
        } catch (error) {
          if (signal.aborted) return;
          deps.onError(error);
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      await releasePollLock();
    }
  };

  return {
    start() {
      if (abort || (deps.shouldPoll && !deps.shouldPoll())) return;
      const controller = new AbortController();
      abort = controller;
      // The loop outlives whatever started it (a /resume re-running session_start, a
      // /tg menu toggle): it must not carry that command's scope onto later updates.
      loopPromise = runDetached(() => loop(controller.signal))
        .catch((error) => {
          deps.onError(error);
        })
        .finally(() => {
          if (abort === controller) abort = undefined;
          loopPromise = undefined;
        });
    },
    async stop() {
      const controller = abort;
      controller?.abort();
      await loopPromise;
      if (abort === controller) abort = undefined;
    },
    isActive() {
      return !!abort;
    },
  };
}
