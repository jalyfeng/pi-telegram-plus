import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";
import { log } from "./logger.ts";

const coordinatorLog = log.child("instance-coordinator");

const DEFAULT_HEARTBEAT_STALE_MS = 12_000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 40;
// Candidate dirs must outlive LOCK_WAIT_MS so a waiting acquirer is not swept mid-flight.
const LOCK_CANDIDATE_MAX_AGE_MS = LOCK_STALE_MS;

export type TelegramInstanceMetadata = {
    id: string;
    pid: number;
    startedAt: string;
    heartbeatAt: string;
    cwd: string;
    sessionId?: string;
    sessionName?: string;
    model?: string;
    busy?: boolean;
};

export type TelegramReplayRequest = {
    chatId: number;
    messageThreadId?: number;
    sourceMessageId?: number;
    requestedAt: string;
};

export type TelegramActiveInstance = {
    instanceId: string;
    generation: number;
    updatedAt: string;
    reason: "initial" | "explicit" | "failover";
    replay?: TelegramReplayRequest;
};

export type TelegramInstanceSnapshot = {
    active: TelegramActiveInstance;
    instances: TelegramInstanceMetadata[];
    changed: boolean;
};

type CoordinatorOptions = {
    token: string;
    instanceId: string;
    startedAt: string;
    rootDir?: string;
    now?: () => number;
    heartbeatStaleMs?: number;
    isPidAlive?: (pid: number) => boolean;
};

type InstanceHeartbeat = Omit<TelegramInstanceMetadata, "id" | "pid" | "startedAt" | "heartbeatAt">;

type CursorState = {
    updateId: number;
    updatedAt: string;
};

type CoordinatorLockOwner = {
    id: string;
    pid: number;
    createdAt: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function telegramTokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function defaultIsPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException)?.code === code;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
    }
}

/**
 * Distinguish expected lock contention from unexpected filesystem permission failures.
 * On Windows, rename onto an existing destination directory throws EPERM instead of
 * EEXIST/ENOTEMPTY. EPERM is treated as normal contention only if the destination path exists.
 *
 * @internal Exported for unit tests of platform error handling.
 */
export async function isLockContentionError(
    error: unknown,
    lockPath: string,
    platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
    if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
        return true;
    }
    if (platform === "win32" && isErrno(error, "EPERM")) {
        return await pathExists(lockPath);
    }
    return false;
}

async function removeCoordinatorArtifact(path: string, reason: string): Promise<void> {
    await rm(path, { recursive: true, force: true }).catch(coordinatorLog.swallow("debug", reason, { path }));
}

/**
 * Best-effort cleanup of lock tombstones and abandoned candidate directories.
 * Live locks use the bare `state.lock` name; only suffix artifacts are removed.
 *
 * Young `.candidate-*` dirs are retained: concurrent acquirers stage owner.json
 * inside them, and deleting a live candidate races the stager into ENOENT on
 * write/rename (multi-instance reconcile hits this every few seconds).
 */
async function cleanupCoordinatorLockArtifacts(lockPath: string, retainPath?: string): Promise<void> {
    const dir = dirname(lockPath);
    const base = basename(lockPath);
    const names = await readdir(dir).catch(() => [] as string[]);
    const cleanedAt = Date.now();
    await Promise.all(names.map(async (name) => {
        if (name === base) return;
        const isStale = name.startsWith(`${base}.stale-`);
        const isCandidate = name.startsWith(`${base}.candidate-`);
        if (!isStale && !isCandidate) return;
        const path = join(dir, name);
        if (retainPath && path === retainPath) return;
        if (isCandidate) {
            const ageMs = await stat(path)
                .then((value) => cleanedAt - value.mtimeMs)
                .catch(() => Number.POSITIVE_INFINITY);
            if (ageMs < LOCK_CANDIDATE_MAX_AGE_MS) return;
        }
        await removeCoordinatorArtifact(path, "remove coordinator lock artifact failed");
    }));
}

function parseTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export class TelegramInstanceCoordinator {
    readonly instanceId: string;
    readonly tokenHash: string;

    private readonly startedAt: string;
    private readonly runtimeDir: string;
    private readonly instancesDir: string;
    private readonly activePath: string;
    private readonly cursorPath: string;
    private readonly lockPath: string;
    private readonly now: () => number;
    private readonly heartbeatStaleMs: number;
    private readonly isPidAlive: (pid: number) => boolean;
    private cachedActive?: TelegramActiveInstance;
    private cachedActiveAt = 0;

    constructor(options: CoordinatorOptions) {
        this.instanceId = options.instanceId;
        this.startedAt = options.startedAt;
        this.tokenHash = telegramTokenHash(options.token);
        this.runtimeDir = join(options.rootDir ?? getAgentDir(), "tg-runtime", this.tokenHash);
        this.instancesDir = join(this.runtimeDir, "instances");
        this.activePath = join(this.runtimeDir, "active.json");
        this.cursorPath = join(this.runtimeDir, "cursor.json");
        this.lockPath = join(this.runtimeDir, "state.lock");
        this.now = options.now ?? Date.now;
        this.heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
        this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    }

    isActive(): boolean {
        return this.cachedActive?.instanceId === this.instanceId
            && this.now() - this.cachedActiveAt <= this.heartbeatStaleMs;
    }

    getActive(): TelegramActiveInstance | undefined {
        return this.cachedActive;
    }

    async reconcile(heartbeat: InstanceHeartbeat): Promise<TelegramInstanceSnapshot> {
        await this.ensureDirectories();
        await this.writeInstanceHeartbeat(heartbeat);
        return await this.withStateLock(async () => {
            const instances = await this.listAliveInstancesUnlocked(true);
            const previous = await this.readJson<TelegramActiveInstance>(this.activePath);
            const previousAlive = previous && instances.some((instance) => instance.id === previous.instanceId);
            let active = previousAlive ? previous : undefined;
            let changed = false;

            if (!active) {
                const candidate = [...instances].sort((left, right) => {
                    const started = parseTimestamp(left.startedAt) - parseTimestamp(right.startedAt);
                    return started || left.id.localeCompare(right.id);
                })[0];
                if (!candidate) throw new Error("No live Telegram instances are registered");
                active = {
                    instanceId: candidate.id,
                    generation: (previous?.generation ?? 0) + 1,
                    updatedAt: new Date(this.now()).toISOString(),
                    reason: previous ? "failover" : "initial",
                };
                await this.writeJsonAtomic(this.activePath, active);
                changed = true;
            }

            this.cacheActive(active);
            return { active, instances, changed };
        });
    }

    async listInstances(): Promise<TelegramInstanceMetadata[]> {
        await this.ensureDirectories();
        return await this.listAliveInstancesUnlocked(false);
    }

    async switchTo(
        instanceId: string,
        replay: Omit<TelegramReplayRequest, "requestedAt"> | undefined,
        expected: Pick<TelegramActiveInstance, "instanceId" | "generation">,
    ): Promise<TelegramActiveInstance> {
        return await this.withStateLock(async () => {
            const instances = await this.listAliveInstancesUnlocked(true);
            if (!instances.some((instance) => instance.id === instanceId)) {
                throw new Error(`Telegram instance is offline: ${instanceId}`);
            }
            const previous = await this.readJson<TelegramActiveInstance>(this.activePath);
            if (!previous
                || previous.instanceId !== expected.instanceId
                || previous.generation !== expected.generation) {
                if (previous) this.cacheActive(previous);
                throw new Error("Telegram active instance changed while the switch was pending; run /tg-switch again");
            }
            const active: TelegramActiveInstance = {
                instanceId,
                generation: previous.generation + 1,
                updatedAt: new Date(this.now()).toISOString(),
                reason: "explicit",
                ...(replay ? { replay: { ...replay, requestedAt: new Date(this.now()).toISOString() } } : {}),
            };
            await this.writeJsonAtomic(this.activePath, active);
            this.cacheActive(active);
            return active;
        });
    }

    async completeReplay(generation: number): Promise<void> {
        await this.withStateLock(async () => {
            const active = await this.readJson<TelegramActiveInstance>(this.activePath);
            if (!active || active.instanceId !== this.instanceId || active.generation !== generation || !active.replay) return;
            const completed: TelegramActiveInstance = { ...active };
            delete completed.replay;
            await this.writeJsonAtomic(this.activePath, completed);
            this.cacheActive(completed);
        });
    }

    async syncCursor(fallbackUpdateId?: number): Promise<number | undefined> {
        return await this.withStateLock(async () => {
            const cursor = await this.readJson<CursorState>(this.cursorPath);
            const current = typeof cursor?.updateId === "number" ? cursor.updateId : undefined;
            const next = typeof fallbackUpdateId === "number"
                ? Math.max(current ?? -1, fallbackUpdateId)
                : current;
            if (next !== undefined && next !== current) {
                await this.writeJsonAtomic(this.cursorPath, {
                    updateId: next,
                    updatedAt: new Date(this.now()).toISOString(),
                } satisfies CursorState);
            }
            return next;
        });
    }

    async persistCursor(updateId: number): Promise<number> {
        const result = await this.syncCursor(updateId);
        return result ?? updateId;
    }

    private async ensureDirectories(): Promise<void> {
        await mkdir(this.instancesDir, { recursive: true, mode: 0o700 });
    }

    private async writeInstanceHeartbeat(heartbeat: InstanceHeartbeat): Promise<void> {
        const record: TelegramInstanceMetadata = {
            id: this.instanceId,
            pid: process.pid,
            startedAt: this.startedAt,
            heartbeatAt: new Date(this.now()).toISOString(),
            ...heartbeat,
        };
        await this.writeJsonAtomic(join(this.instancesDir, `${this.instanceId}.json`), record);
    }

    private async listAliveInstancesUnlocked(removeStale: boolean): Promise<TelegramInstanceMetadata[]> {
        const names = await readdir(this.instancesDir).catch((error) => {
            if (isErrno(error, "ENOENT")) return [];
            throw error;
        });
        const instances: TelegramInstanceMetadata[] = [];
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const path = join(this.instancesDir, name);
            const record = await this.readJson<TelegramInstanceMetadata>(path);
            const fresh = !!record
                && typeof record.id === "string"
                && typeof record.pid === "number"
                && this.now() - parseTimestamp(record.heartbeatAt) <= this.heartbeatStaleMs
                && this.isPidAlive(record.pid);
            if (fresh) {
                instances.push(record);
            } else if (removeStale) {
                await rm(path, { force: true }).catch(coordinatorLog.swallow("debug", "remove stale instance record failed", { path }));
            }
        }
        return instances.sort((left, right) => left.cwd.localeCompare(right.cwd) || left.id.localeCompare(right.id));
    }

    private cacheActive(active: TelegramActiveInstance): void {
        this.cachedActive = active;
        this.cachedActiveAt = this.now();
    }

    private async withStateLock<T>(run: () => Promise<T>): Promise<T> {
        await this.ensureDirectories();
        const started = Date.now();
        const owner: CoordinatorLockOwner = {
            id: randomUUID(),
            pid: process.pid,
            createdAt: new Date(this.now()).toISOString(),
        };
        const ownerPath = join(this.lockPath, "owner.json");
        const candidatePath = `${this.lockPath}.candidate-${owner.id}`;
        // Candidate dir is private until renamed into place; plain write avoids an
        // extra temp+rename window concurrent cleaners can interrupt with ENOENT.
        const ownerBody = `${JSON.stringify(owner, null, 2)}\n`;

        const stageCandidate = async (): Promise<void> => {
            // Drop abandoned leftovers, then stage a fresh private candidate dir.
            await cleanupCoordinatorLockArtifacts(this.lockPath, candidatePath);
            await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
            await mkdir(candidatePath, { mode: 0o700 });
            await writeFile(join(candidatePath, "owner.json"), ownerBody, { mode: 0o600, flag: "wx" });
        };

        const timedOut = (): boolean => Date.now() - started > LOCK_WAIT_MS;

        let acquired = false;
        try {
            await stageCandidate();
            while (true) {
                try {
                    await rename(candidatePath, this.lockPath);
                    acquired = true;
                    break;
                } catch (error) {
                    // Candidate swept mid-flight (or parent vanished): restage and retry.
                    if (isErrno(error, "ENOENT")) {
                        if (timedOut()) {
                            throw new Error("Timed out waiting for Telegram instance coordinator lock");
                        }
                        await stageCandidate();
                        continue;
                    }
                    if (!await isLockContentionError(error, this.lockPath)) {
                        // On Windows, if destination was in the middle of deletion by another process,
                        // NTFS transiently throws EPERM while in delete-pending state.
                        if (process.platform === "win32" && isErrno(error, "EPERM")) {
                            await sleep(LOCK_RETRY_MS);
                            if (timedOut()) {
                                throw error;
                            }
                            if (await isLockContentionError(error, this.lockPath)) {
                                // Destination now exists, normal lock contention
                            } else {
                                try {
                                    await rename(candidatePath, this.lockPath);
                                    acquired = true;
                                    break;
                                } catch (retryErr) {
                                    if (isErrno(retryErr, "ENOENT")) {
                                        await stageCandidate();
                                        continue;
                                    }
                                    if (await isLockContentionError(retryErr, this.lockPath)) {
                                        // Contention on retry
                                    } else {
                                        throw retryErr;
                                    }
                                }
                            }
                        } else {
                            throw error;
                        }
                    }
                    const currentOwner = await this.readJson<CoordinatorLockOwner>(ownerPath);
                    const modifiedAt = await stat(this.lockPath).then((value) => value.mtimeMs).catch(() => this.now());
                    const stale = this.now() - modifiedAt > LOCK_STALE_MS
                        && (!currentOwner || !this.isPidAlive(currentOwner.pid));
                    if (stale) {
                        const staleId = (currentOwner?.id ?? `unknown-${Math.trunc(modifiedAt)}`).replace(/[^a-zA-Z0-9_-]/g, "_");
                        const stalePath = `${this.lockPath}.stale-${staleId}`;
                        try {
                            await rename(this.lockPath, stalePath);
                            // Tombstone only frees the live path; delete it immediately.
                            await removeCoordinatorArtifact(stalePath, "remove stale coordinator lock failed");
                            continue;
                        } catch (renameError) {
                            if (!isErrno(renameError, "ENOENT") && !await isLockContentionError(renameError, stalePath)) {
                                throw renameError;
                            }
                        }
                    }
                    if (timedOut()) {
                        throw new Error("Timed out waiting for Telegram instance coordinator lock");
                    }
                    await sleep(LOCK_RETRY_MS);
                }
            }
            return await run();
        } finally {
            if (acquired) {
                const currentOwner = await this.readJson<CoordinatorLockOwner>(ownerPath);
                if (currentOwner?.id === owner.id) {
                    await rm(this.lockPath, { recursive: true, force: true }).catch(coordinatorLog.swallow("warn", "release coordinator lock failed", { lockPath: this.lockPath }));
                }
                await cleanupCoordinatorLockArtifacts(this.lockPath);
            } else {
                await rm(candidatePath, { recursive: true, force: true }).catch(coordinatorLog.swallow("debug", "remove coordinator lock candidate failed", { candidatePath }));
            }
        }
    }

    private async readJson<T>(path: string): Promise<T | undefined> {
        try {
            return JSON.parse(await readFile(path, "utf8")) as T;
        } catch (error) {
            if (!isErrno(error, "ENOENT")) {
                coordinatorLog.debug("read coordinator json failed", { path, error });
            }
            return undefined;
        }
    }

    private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
        await this.ensureDirectories();
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        try {
            await rename(temporaryPath, path);
        } finally {
            await rm(temporaryPath, { force: true }).catch(coordinatorLog.swallow("debug", "remove coordinator temp file failed", { temporaryPath }));
        }
    }
}
