import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";
import { getTelegramUpdates } from "./telegram-api.ts";
import type { TelegramConfig, TelegramUpdate } from "./types.ts";

export type TelegramPollingRuntime = {
  start(): void;
  stop(): Promise<void>;
  isActive(): boolean;
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const POLL_LOCK_STALE_MS = 45_000;
const POLL_LOCK_TOUCH_MS = 5_000;

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
  } catch {
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
  } catch {
    return undefined;
  }
}

async function isPollingLockStale(lockPath: string): Promise<boolean> {
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readPollingLockOwner(ownerPath);
  const age = Date.now() - (await stat(ownerPath).then((s) => s.mtimeMs).catch(() => 0));
  if (age > POLL_LOCK_STALE_MS) return true;
  return owner !== undefined && !isPidAlive(owner.pid);
}

/**
 * Atomically claim the polling lock. Uses a temporary candidate file written
 * with `wx` (exclusive create) inside the agent dir, then renames it into the
 * lock directory. No check-then-rm-then-mkdir TOCTOU window exists: only one
 * process can successfully rename its candidate into the lock's owner.json.
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

  // Clean up stale lock if it exists.
  if (!await isPollingLockStale(lockPath)) return undefined;
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);

  // Create lock directory; if another process won, bail out.
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Someone else created it after our stale check — their lock is fresh now.
    return undefined;
  }

  // Write a temp candidate with exclusive flag, then rename atomically.
  const tmpPath = join(getAgentDir(), `tg-poll-candidate-${owner.id}.tmp`);
  try {
    await writeFile(tmpPath, ownerText(owner), { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another process's candidate won; clean up and bail.
    await rm(tmpPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }

  try {
    const { rename: nodeRename } = await import("node:fs/promises");
    await nodeRename(tmpPath, ownerPath);
  } catch {
    // rename failed (e.g. cross-device or another process already wrote owner.json).
    await rm(tmpPath).catch(() => undefined);
    return undefined;
  }

  const touch = setInterval(() => {
    void (async () => {
      const current = await readPollingLockOwner(ownerPath);
      if (current?.id !== owner.id) return;
      owner.touchedAt = new Date().toISOString();
      await writeFile(ownerPath, ownerText(owner), { mode: 0o600 }).catch(() => undefined);
    })();
  }, POLL_LOCK_TOUCH_MS);

  return {
    owns: async () => (await readPollingLockOwner(ownerPath))?.id === owner.id,
    release: async () => {
      clearInterval(touch);
      const current = await readPollingLockOwner(ownerPath);
      if (current?.id === owner.id) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}


export function createTelegramPollingRuntime(deps: {
  getConfig: () => TelegramConfig;
  setConfig: (config: TelegramConfig) => void;
  persistConfig: (config: TelegramConfig) => Promise<void>;
  handleUpdate: (update: TelegramUpdate) => Promise<void>;
  reloadConfig?: () => Promise<void>;
  onError: (error: unknown) => void;
  onSuccess?: () => void;
}): TelegramPollingRuntime {
  let abort: AbortController | undefined;
  let pollLock: { token: string; owns: () => Promise<boolean>; release: () => Promise<void> } | undefined;

  const releasePollLock = async () => {
    const lock = pollLock;
    pollLock = undefined;
    await lock?.release().catch(() => undefined);
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

    while (!signal.aborted) {
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
        const refreshedToken = deps.getConfig().botToken;
        if (!refreshedToken) continue;
        if (refreshedToken !== token) continue;

        const updates = await getTelegramUpdates(deps.getConfig(), signal);
        backoffMs = MIN_BACKOFF_MS;
        deps.onSuccess?.();

        for (const update of updates) {
          if (signal.aborted) return;
          try {
            await deps.handleUpdate(update);
          } catch (error) {
            deps.onError(error);
            // Do not advance offset on failure; retry on next poll loop.
            continue;
          }
          const nextConfig = { ...deps.getConfig(), lastUpdateId: update.update_id };
          try {
            await deps.persistConfig(nextConfig);
            deps.setConfig(nextConfig);
          } catch (error) {
            deps.onError(error);
            continue;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        deps.onError(error);
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
    await releasePollLock();
  };

  return {
    start() {
      if (abort) return;
      abort = new AbortController();
      void loop(abort.signal).catch((error) => {
        abort = undefined;
        void releasePollLock();
        deps.onError(error);
      });
    },
    async stop() {
      abort?.abort();
      abort = undefined;
      await releasePollLock();
    },
    isActive() {
      return !!abort;
    },
  };
}