import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramInstanceCoordinator, formatFailoverNotice, isGenuineFailover, isLockContentionError, telegramTokenHash, type TelegramActiveInstance } from "../instance-coordinator.ts";

const TOKEN = "123456:very-secret-token";
const STARTED_AT = "2026-01-01T00:00:00.000Z";

describe("TelegramInstanceCoordinator", () => {
    let rootDir: string;
    let now: number;

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), "pi-tg-coordinator-"));
        now = Date.parse(STARTED_AT);
    });

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });

    const create = (instanceId: string) => new TelegramInstanceCoordinator({
        token: TOKEN,
        instanceId,
        startedAt: STARTED_AT,
        rootDir,
        now: () => now,
        isPidAlive: () => true,
    });

    const heartbeat = (cwd: string) => ({
        cwd,
        sessionId: `${cwd}-session`,
        model: "provider/model",
        busy: false,
    });

    it("elects the first live instance and switches explicitly", async () => {
        const first = create("instance-a");
        const second = create("instance-b");

        const firstSnapshot = await first.reconcile(heartbeat("/workspace/a"));
        const secondSnapshot = await second.reconcile(heartbeat("/workspace/b"));

        expect(firstSnapshot.active).toMatchObject({ instanceId: "instance-a", generation: 1, reason: "initial" });
        expect(secondSnapshot.active.instanceId).toBe("instance-a");
        expect(first.isActive()).toBe(true);
        expect(second.isActive()).toBe(false);

        const switched = await first.switchTo(
            "instance-b",
            { chatId: 42, messageThreadId: 7 },
            { instanceId: "instance-a", generation: 1 },
        );
        expect(switched).toMatchObject({
            instanceId: "instance-b",
            generation: 2,
            reason: "explicit",
            replay: { chatId: 42, messageThreadId: 7 },
        });
        expect(first.isActive()).toBe(false);

        const refreshed = await second.reconcile(heartbeat("/workspace/b"));
        expect(refreshed.active.instanceId).toBe("instance-b");
        expect(second.isActive()).toBe(true);

        await second.completeReplay(switched.generation);
        expect(second.getActive()?.replay).toBeUndefined();
    });

    it("rejects a stale concurrent switch request", async () => {
        const first = create("instance-a");
        const second = create("instance-b");
        const third = create("instance-c");
        await first.reconcile(heartbeat("/workspace/a"));
        await second.reconcile(heartbeat("/workspace/b"));
        await third.reconcile(heartbeat("/workspace/c"));

        await first.switchTo(
            "instance-b",
            { chatId: 42 },
            { instanceId: "instance-a", generation: 1 },
        );
        await expect(first.switchTo(
            "instance-c",
            { chatId: 42 },
            { instanceId: "instance-a", generation: 1 },
        )).rejects.toThrow(/changed while the switch was pending/);
        expect(first.getActive()?.instanceId).toBe("instance-b");
    });

    it("fails over after the active heartbeat becomes stale", async () => {
        const first = create("instance-a");
        const second = create("instance-b");
        await first.reconcile(heartbeat("/workspace/a"));
        await second.reconcile(heartbeat("/workspace/b"));

        now += 13_000;
        expect(first.isActive()).toBe(false);
        const snapshot = await second.reconcile(heartbeat("/workspace/b"));

        expect(snapshot.active).toMatchObject({
            instanceId: "instance-b",
            generation: 2,
            reason: "failover",
            previousInstanceId: "instance-a",
            previousCwd: "/workspace/a",
            previousLabel: "a",
            cwd: "/workspace/b",
            label: "b",
        });
        expect(snapshot.instances.map((instance) => instance.id)).toEqual(["instance-b"]);
    });

    it("keeps the token-scoped cursor monotonic", async () => {
        const coordinator = create("instance-a");

        expect(await coordinator.syncCursor()).toBeUndefined();
        expect(await coordinator.syncCursor(10)).toBe(10);
        expect(await coordinator.persistCursor(8)).toBe(10);
        expect(await coordinator.persistCursor(15)).toBe(15);
        expect(await coordinator.syncCursor(12)).toBe(15);
    });

    it("rewinds the cursor only when resetCursor asks for it explicitly", async () => {
        const coordinator = create("instance-a");
        await coordinator.persistCursor(500);

        // The monotonic paths must keep refusing to lower it...
        expect(await coordinator.persistCursor(10)).toBe(500);
        expect(await coordinator.syncCursor(10)).toBe(500);

        // ...and the explicit rewind is the only way down, so a cursor that is
        // ahead of the bot's stream can be corrected.
        expect(await coordinator.resetCursor(9)).toBe(9);
        expect(await coordinator.syncCursor()).toBe(9);
        expect(await coordinator.persistCursor(10)).toBe(10);
    });

    it("quarantines a stale dead-owner lock before taking over", async () => {
        const currentNow = Date.now();
        const coordinator = new TelegramInstanceCoordinator({
            token: TOKEN,
            instanceId: "instance-a",
            startedAt: new Date(currentNow).toISOString(),
            rootDir,
            now: () => currentNow,
            isPidAlive: (pid) => pid === process.pid,
        });
        const namespace = join(rootDir, "tg-runtime", telegramTokenHash(TOKEN));
        const lockPath = join(namespace, "state.lock");
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
            id: "dead-owner",
            pid: 999_999,
            createdAt: new Date(currentNow - 20_000).toISOString(),
        }));
        const staleTime = new Date(currentNow - 20_000);
        await utimes(lockPath, staleTime, staleTime);

        const snapshot = await coordinator.reconcile(heartbeat("/workspace/a"));

        expect(snapshot.active.instanceId).toBe("instance-a");
        const names = await readdir(namespace);
        expect(names).not.toContain("state.lock");
        expect(names.some((name) => name.startsWith("state.lock.stale-") || name.startsWith("state.lock.candidate-"))).toBe(false);
    });

    it("uses only the token hash in runtime paths and files", async () => {
        const coordinator = create("instance-a");
        await coordinator.reconcile(heartbeat("/workspace/a"));
        await coordinator.persistCursor(10);

        const runtimeRoot = join(rootDir, "tg-runtime");
        expect(await readdir(runtimeRoot)).toEqual([telegramTokenHash(TOKEN)]);
        const namespace = join(runtimeRoot, telegramTokenHash(TOKEN));
        const active = await readFile(join(namespace, "active.json"), "utf8");
        const instance = await readFile(join(namespace, "instances", "instance-a.json"), "utf8");
        const cursor = await readFile(join(namespace, "cursor.json"), "utf8");
        expect(`${active}${instance}${cursor}`).not.toContain(TOKEN);
    });

    it("survives concurrent multi-instance reconcile without lock ENOENT", async () => {
        const workers = Array.from({ length: 8 }, (_, index) => create(`instance-${index}`));
        const rounds = 12;

        // Burst concurrent lock acquisition the same way multi-instance heartbeat does.
        for (let round = 0; round < rounds; round += 1) {
            const snapshots = await Promise.all(
                workers.map((worker, index) => worker.reconcile(heartbeat(`/workspace/${index}`))),
            );
            const activeIds = new Set(snapshots.map((snapshot) => snapshot.active.instanceId));
            expect(activeIds.size).toBe(1);
            expect(snapshots[0]?.active.instanceId).toMatch(/^instance-/);
        }

        const namespace = join(rootDir, "tg-runtime", telegramTokenHash(TOKEN));
        const names = await readdir(namespace);
        expect(names).not.toContain("state.lock");
        expect(names.some((name) => name.startsWith("state.lock.candidate-") || name.startsWith("state.lock.stale-"))).toBe(false);
    });

    it("does not sweep a fresh candidate directory during lock cleanup races", async () => {
        const namespace = join(rootDir, "tg-runtime", telegramTokenHash(TOKEN));
        await mkdir(namespace, { recursive: true, mode: 0o700 });
        const freshCandidate = join(namespace, `state.lock.candidate-${randomUUID()}`);
        const oldCandidate = join(namespace, `state.lock.candidate-${randomUUID()}`);
        await mkdir(freshCandidate, { mode: 0o700 });
        await writeFile(join(freshCandidate, "owner.json"), "{\"id\":\"fresh\"}\n", { mode: 0o600 });
        await mkdir(oldCandidate, { mode: 0o700 });
        await writeFile(join(oldCandidate, "owner.json"), "{\"id\":\"old\"}\n", { mode: 0o600 });
        const oldTime = new Date(Date.now() - 60_000);
        await utimes(oldCandidate, oldTime, oldTime);

        // A reconcile forces cleanupCoordinatorLockArtifacts on the way in/out.
        const coordinator = create("instance-a");
        await coordinator.reconcile(heartbeat("/workspace/a"));

        const names = await readdir(namespace);
        expect(names).toContain(basename(freshCandidate));
        expect(names).not.toContain(basename(oldCandidate));

        await rm(freshCandidate, { recursive: true, force: true });
    });

    describe("clearActiveIfAloneSync (shutdown cleanup)", () => {
        const activePath = () => join(rootDir, "tg-runtime", telegramTokenHash(TOKEN), "active.json");
        const instancePath = (id: string) => join(rootDir, "tg-runtime", telegramTokenHash(TOKEN), "instances", `${id}.json`);

        it("clears active.json and its own heartbeat when the active instance is alone", async () => {
            const coordinator = create("instance-a");
            await coordinator.reconcile(heartbeat("/workspace/a"));
            expect(coordinator.isActive()).toBe(true);
            expect(await readFile(activePath(), "utf8")).toContain("instance-a");

            coordinator.clearActiveIfAloneSync();

            await expect(readFile(activePath(), "utf8")).rejects.toThrow(/ENOENT/);
            await expect(readFile(instancePath("instance-a"), "utf8")).rejects.toThrow(/ENOENT/);
            expect(coordinator.isActive()).toBe(false);
        });

        it("keeps active.json when another live instance is registered", async () => {
            const first = create("instance-a");
            const second = create("instance-b");
            await first.reconcile(heartbeat("/workspace/a"));
            await second.reconcile(heartbeat("/workspace/b"));
            expect(first.isActive()).toBe(true);

            first.clearActiveIfAloneSync();

            const active = JSON.parse(await readFile(activePath(), "utf8"));
            expect(active.instanceId).toBe("instance-a");
            expect(await readFile(instancePath("instance-a"), "utf8")).toContain("instance-a");
        });

        it("does not touch active.json when the shutting-down instance is not active", async () => {
            const first = create("instance-a");
            const second = create("instance-b");
            await first.reconcile(heartbeat("/workspace/a"));
            await second.reconcile(heartbeat("/workspace/b"));

            second.clearActiveIfAloneSync();

            const active = JSON.parse(await readFile(activePath(), "utf8"));
            expect(active.instanceId).toBe("instance-a");
        });

        it("is a no-op when no active record exists", async () => {
            const coordinator = create("instance-a");
            expect(() => coordinator.clearActiveIfAloneSync()).not.toThrow();
            await expect(readFile(activePath(), "utf8")).rejects.toThrow(/ENOENT/);
        });
    });

    describe("releaseActive (disconnect handoff)", () => {
        const activePath = () => join(rootDir, "tg-runtime", telegramTokenHash(TOKEN), "active.json");
        const instancePath = (id: string) => join(rootDir, "tg-runtime", telegramTokenHash(TOKEN), "instances", `${id}.json`);

        it("lets another instance take over without waiting for heartbeat expiry", async () => {
            const first = create("instance-a");
            const second = create("instance-b");
            await first.reconcile(heartbeat("/workspace/a"));
            await second.reconcile(heartbeat("/workspace/b"));
            expect(first.isActive()).toBe(true);
            expect(second.isActive()).toBe(false);

            await first.releaseActive();

            expect(first.isActive()).toBe(false);
            await expect(readFile(activePath(), "utf8")).rejects.toThrow(/ENOENT/);
            await expect(readFile(instancePath("instance-a"), "utf8")).rejects.toThrow(/ENOENT/);
            // B takes over on its very next reconcile - no stale-heartbeat wait.
            const snapshot = await second.reconcile(heartbeat("/workspace/b"));
            expect(snapshot.active.instanceId).toBe("instance-b");
            expect(second.isActive()).toBe(true);
        });

        it("does not touch the active record or heartbeats when this instance is not active", async () => {
            const first = create("instance-a");
            const second = create("instance-b");
            await first.reconcile(heartbeat("/workspace/a"));
            await second.reconcile(heartbeat("/workspace/b"));

            await second.releaseActive();

            const active = JSON.parse(await readFile(activePath(), "utf8"));
            expect(active.instanceId).toBe("instance-a");
            expect(await readFile(instancePath("instance-b"), "utf8")).toContain("instance-b");
            expect(second.isActive()).toBe(false);
        });
    });

    describe("isGenuineFailover", () => {
        const activeOf = (overrides: Partial<TelegramActiveInstance>): TelegramActiveInstance => ({
            instanceId: "instance-b", generation: 2, updatedAt: STARTED_AT, reason: "failover",
            cwd: "/workspace/b", label: "b",
            previousInstanceId: "instance-a", previousCwd: "/workspace/a", previousLabel: "a",
            ...overrides,
        });

        it("is true when the replaced active instance was another project", () => {
            expect(isGenuineFailover(activeOf({}), "instance-b")).toBe(true);
        });

        it("is false when the replaced active instance was self (single-instance restart)", () => {
            expect(isGenuineFailover(activeOf({ previousInstanceId: "instance-b" }), "instance-b")).toBe(false);
        });

        it("is false when the previous active instance had the same working directory (same project restarted)", () => {
            expect(isGenuineFailover(activeOf({ previousCwd: "/workspace/b" }), "instance-b")).toBe(false);
        });

        it("is false when the record has no previous cwd (written by an older version)", () => {
            expect(isGenuineFailover(activeOf({ previousCwd: undefined, previousLabel: undefined }), "instance-b")).toBe(false);
        });

        it("is false when there was no previous active instance", () => {
            expect(isGenuineFailover(activeOf({ reason: "initial", previousInstanceId: undefined }), "instance-b")).toBe(false);
        });

        it("is false for an explicit switch, even when a previous instance is recorded", () => {
            expect(isGenuineFailover(activeOf({ reason: "explicit" }), "instance-b")).toBe(false);
        });
    });

    describe("formatFailoverNotice", () => {
        const active: TelegramActiveInstance = {
            instanceId: "instance-b", generation: 2, updatedAt: STARTED_AT, reason: "failover",
            cwd: "/workspace/b", label: "project2",
            previousInstanceId: "instance-a", previousCwd: "/workspace/a", previousLabel: "project",
        };

        it("names the replaced and the new project, with the host command name", () => {
            expect(formatFailoverNotice(active, "omp")).toBe(
                "⚠️ <b>Telegram instance failover</b>\nThe previous active omp instance (project) went offline. This instance (project2) is now active.",
            );
        });

        it("omits the bracketed names that were not recorded", () => {
            expect(formatFailoverNotice({ ...active, previousLabel: undefined, label: undefined }, "pi")).toBe(
                "⚠️ <b>Telegram instance failover</b>\nThe previous active pi instance went offline. This instance is now active.",
            );
        });

        it("escapes the project names", () => {
            expect(formatFailoverNotice({ ...active, label: "<b>x</b>" }, "omp")).toContain("(&lt;b&gt;x&lt;/b&gt;)");
        });
    });

    describe("isLockContentionError", () => {
        it("classifies EEXIST and ENOTEMPTY as lock contention across platforms", async () => {
            const nonExistent = join(rootDir, "missing-lock");
            expect(await isLockContentionError({ code: "EEXIST" }, nonExistent, "linux")).toBe(true);
            expect(await isLockContentionError({ code: "ENOTEMPTY" }, nonExistent, "linux")).toBe(true);
            expect(await isLockContentionError({ code: "EEXIST" }, nonExistent, "win32")).toBe(true);
            expect(await isLockContentionError({ code: "ENOTEMPTY" }, nonExistent, "win32")).toBe(true);
        });

        it("treats Windows EPERM as contention when destination lock path exists", async () => {
            const existingLock = join(rootDir, "existing-lock");
            await mkdir(existingLock);
            expect(await isLockContentionError({ code: "EPERM" }, existingLock, "win32")).toBe(true);
        });

        it("does not treat EPERM as contention when destination does not exist", async () => {
            const missingLock = join(rootDir, "missing-lock");
            expect(await isLockContentionError({ code: "EPERM" }, missingLock, "win32")).toBe(false);
            expect(await isLockContentionError({ code: "EPERM" }, missingLock, "linux")).toBe(false);
        });

        it("does not treat unexpected permission or filesystem errors as contention", async () => {
            const existingLock = join(rootDir, "existing-lock-for-perm");
            await mkdir(existingLock);
            expect(await isLockContentionError({ code: "EACCES" }, existingLock, "win32")).toBe(false);
            expect(await isLockContentionError({ code: "EACCES" }, existingLock, "linux")).toBe(false);
            expect(await isLockContentionError(new Error("Generic failure"), existingLock, "win32")).toBe(false);
        });
    });
});
