import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getTelegramUpdates: vi.fn(),
    getPendingTelegramUpdates: vi.fn(),
}));

vi.mock("../telegram-api.ts", () => ({
    getTelegramUpdates: mocks.getTelegramUpdates,
    getPendingTelegramUpdates: mocks.getPendingTelegramUpdates,
}));

import { createTelegramPollingRuntime } from "../polling.ts";
import { currentCommandScope, runInCommand } from "../tui/command-context.ts";
import type { CommandScope } from "../tui/origin.ts";
import type { TelegramConfig, TelegramUpdate } from "../types.ts";

const update: TelegramUpdate = {
    update_id: 10,
    message: { message_id: 10, chat: { id: 42 }, from: { id: 7 }, text: "switch" },
};

describe("TelegramPollingRuntime", () => {
    let agentDir: string;
    let previousAgentDir: string | undefined;

    beforeEach(async () => {
        previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        agentDir = await mkdtemp(join(tmpdir(), "pi-tg-polling-"));
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mocks.getTelegramUpdates.mockReset();
        mocks.getPendingTelegramUpdates.mockReset();
        mocks.getPendingTelegramUpdates.mockResolvedValue([]);
    });

    afterEach(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(agentDir, { recursive: true, force: true });
    });

    it("waits for the current update to persist before stop releases the loop", async () => {
        let config: TelegramConfig = { botToken: `token-${Date.now()}`, lastUpdateId: 9 };
        let releaseHandler: () => void = () => undefined;
        const handlerGate = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        const events: string[] = [];
        mocks.getTelegramUpdates.mockResolvedValueOnce([update]);

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => {
                config = next;
                events.push(`set:${next.lastUpdateId}`);
            },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => {
                events.push(`persist:${next.lastUpdateId}`);
            },
            handleUpdate: async () => {
                events.push("handle:start");
                await handlerGate;
                events.push("handle:end");
            },
            onError: (error) => {
                throw error;
            },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(events).toContain("handle:start"));

        let stopped = false;
        const stopPromise = runtime.stop().then(() => {
            stopped = true;
            events.push("stopped");
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stopped).toBe(false);

        releaseHandler();
        await stopPromise;

        // The cursor is committed before the handler; stop still waits for the handler to end.
        expect(events).toEqual([
            "persist:10",
            "set:10",
            "handle:start",
            "handle:end",
            "stopped",
        ]);
        expect(runtime.isActive()).toBe(false);
    });

    it("rewinds a cursor that is ahead of the delivered updates and still handles the batch", async () => {
        const token = `rewind-token-${Date.now()}`;
        let config: TelegramConfig = { botToken: token, lastUpdateId: 500 };
        const handled: number[] = [];
        const resets: number[] = [];
        const errors: unknown[] = [];
        mocks.getTelegramUpdates.mockImplementationOnce(async () => [update]);
        mocks.getTelegramUpdates.mockImplementation(async (_config, signal: AbortSignal) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => { config = next; },
            resetCursor: async (updateId) => { resets.push(updateId); },
            handleUpdate: async (batchUpdate) => { handled.push(batchUpdate.update_id); },
            onError: (error) => { errors.push(error); },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(handled).toEqual([10]));
        await runtime.stop();

        // update_id 10 arrived while the stored cursor claimed 500 was already
        // handled: rewind to 9 (one below the delivered update), then advance to it.
        expect(resets).toEqual([9]);
        expect(config.lastUpdateId).toBe(10);
        expect(errors).toEqual([]);
    });

    it("does not rewind a cursor that the delivered updates continue from", async () => {
        const token = `norwind-token-${Date.now()}`;
        let config: TelegramConfig = { botToken: token, lastUpdateId: 9 };
        const handled: number[] = [];
        const resets: number[] = [];
        mocks.getTelegramUpdates.mockImplementationOnce(async () => [update]);
        mocks.getTelegramUpdates.mockImplementation(async (_config, signal: AbortSignal) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => { config = next; },
            resetCursor: async (updateId) => { resets.push(updateId); },
            handleUpdate: async (batchUpdate) => { handled.push(batchUpdate.update_id); },
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(handled).toEqual([10]));
        await runtime.stop();

        // update_id 10 is exactly cursor + 1: the normal long-poll result.
        expect(resets).toEqual([]);
        expect(config.lastUpdateId).toBe(10);
    });

    it("does not rewind or re-handle when the backlog probe re-serves the last processed update", async () => {
        const token = `equal-token-${Date.now()}`;
        let config: TelegramConfig = { botToken: token, lastUpdateId: 10 };
        const handled: number[] = [];
        const resets: number[] = [];
        // The offset-0 startup probe returns the whole backlog, including the
        // update the cursor already processed. That is ordinary re-delivery,
        // not a foreign cursor: neither rewind nor re-handle it.
        mocks.getPendingTelegramUpdates.mockResolvedValue([update]);
        mocks.getTelegramUpdates.mockImplementation(async (_config, signal: AbortSignal) => {
            const { promise, resolve } = Promise.withResolvers<void>();
            signal.addEventListener("abort", () => resolve(), { once: true });
            await promise;
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => { config = next; },
            resetCursor: async (updateId) => { resets.push(updateId); },
            handleUpdate: async (batchUpdate) => { handled.push(batchUpdate.update_id); },
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(mocks.getTelegramUpdates).toHaveBeenCalled());
        await runtime.stop();

        expect(resets).toEqual([]);
        expect(handled).toEqual([]);
        expect(config.lastUpdateId).toBe(10);
    });

    it("probes the backlog once on start and rewinds a cursor the server keeps hiding", async () => {
        const token = `probe-token-${Date.now()}`;
        let config: TelegramConfig = { botToken: token, lastUpdateId: 500 };
        const resets: number[] = [];
        // update_id 10 is still unconfirmed: a server that drops out-of-range
        // requests would never hand it back for the planted cursor of 500.
        mocks.getPendingTelegramUpdates.mockResolvedValue([update]);
        mocks.getTelegramUpdates.mockResolvedValue([]);

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            persistConfig: async () => undefined,
            resetCursor: async (updateId) => { resets.push(updateId); },
            handleUpdate: async () => undefined,
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(resets).toEqual([9]));
        // Let several poll iterations run: the probe must stay one-shot.
        await vi.waitFor(() => expect(mocks.getTelegramUpdates.mock.calls.length).toBeGreaterThan(2));
        await runtime.stop();

        expect(mocks.getPendingTelegramUpdates).toHaveBeenCalledTimes(1);
        expect(config.lastUpdateId).toBe(9);
    });

    it("does not probe the backlog when no cursor is stored yet", async () => {
        const token = `probe-skip-${Date.now()}`;
        mocks.getTelegramUpdates.mockResolvedValue([]);

        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: token }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            resetCursor: async () => undefined,
            handleUpdate: async () => undefined,
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(mocks.getTelegramUpdates.mock.calls.length).toBeGreaterThan(1));
        await runtime.stop();

        expect(mocks.getPendingTelegramUpdates).not.toHaveBeenCalled();
    });

    it("quarantines a stale polling lock instead of deleting a new owner", async () => {
        const token = `stale-token-${Date.now()}`;
        const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
        const lockPath = join(agentDir, `tg-poll-${hash}.lock`);
        const ownerPath = join(lockPath, "owner.json");
        await mkdir(lockPath, { recursive: true });
        await writeFile(ownerPath, JSON.stringify({
            id: "old-owner",
            pid: 999_999,
            at: new Date(0).toISOString(),
            touchedAt: new Date(0).toISOString(),
        }));
        const staleTime = new Date(Date.now() - 60_000);
        await utimes(ownerPath, staleTime, staleTime);
        mocks.getTelegramUpdates.mockImplementationOnce(async (_config, signal: AbortSignal) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: token }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            handleUpdate: async () => undefined,
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });
        runtime.start();
        await vi.waitFor(() => expect(mocks.getTelegramUpdates).toHaveBeenCalledTimes(1));

        const namesWhileActive = await readdir(agentDir);
        expect(namesWhileActive).toContain(`tg-poll-${hash}.lock`);
        expect(namesWhileActive.some((name) => name.includes(".retired-") || name.includes(".candidate-"))).toBe(false);

        await runtime.stop();

        const namesAfterStop = await readdir(agentDir);
        expect(namesAfterStop.some((name) => name.startsWith(`tg-poll-${hash}`))).toBe(false);
    });

    it("breaks a poll lock held by a superseded runtime in the same process", async () => {
        const token = `same-pid-token-${Date.now()}`;
        const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
        const lockPath = join(agentDir, `tg-poll-${hash}.lock`);
        const ownerPath = join(lockPath, "owner.json");
        // A live lock owned by THIS process with a fresh heartbeat. The old rule
        // (pid alive + age < stale window) refused to break it, so a session
        // replacement that re-activates the plugin in-process could not take the
        // token back and stalled ~30s on the poll backoff. The newest runtime
        // must seize the lock immediately.
        await mkdir(lockPath, { recursive: true });
        await writeFile(ownerPath, JSON.stringify({
            id: "superseded-runtime",
            pid: process.pid,
            at: new Date().toISOString(),
            touchedAt: new Date().toISOString(),
        }));
        const errors: string[] = [];
        mocks.getTelegramUpdates.mockResolvedValue([]);

        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: token }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            handleUpdate: async () => undefined,
            onError: (error) => { errors.push(String((error as Error)?.message ?? error)); },
            shouldPoll: () => true,
        });
        runtime.start();
        await vi.waitFor(() => expect(mocks.getTelegramUpdates).toHaveBeenCalled());

        expect(errors.some((message) => /already polling/i.test(message))).toBe(false);
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        expect(owner.id).not.toBe("superseded-runtime");

        await runtime.stop();
    });

    it("does not start a polling loop while the instance is not selected", () => {
        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: "token" }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            handleUpdate: async () => undefined,
            onError: () => undefined,
            shouldPoll: () => false,
        });

        runtime.start();

        expect(runtime.isActive()).toBe(false);
        expect(mocks.getTelegramUpdates).not.toHaveBeenCalled();
    });

    it("runs the polling loop outside the command that started it", async () => {
        let config: TelegramConfig = { botToken: `scope-token-${Date.now()}`, lastUpdateId: 9 };
        const resumeScope = { id: "resume", label: "resume" } as unknown as CommandScope;
        const seenScopes: Array<CommandScope | undefined> = [];
        mocks.getTelegramUpdates.mockResolvedValueOnce([update]);
        mocks.getTelegramUpdates.mockImplementation(async (_config, signal: AbortSignal) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => { config = next; },
            handleUpdate: async () => { seenScopes.push(currentCommandScope()); },
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });

        runInCommand(resumeScope, () => runtime.start());
        await vi.waitFor(() => expect(seenScopes).toEqual([undefined]));
        await runtime.stop();
    });
});
