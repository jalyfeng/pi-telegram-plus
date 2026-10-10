import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBot,
  writeProjectBinding,
  resolveTelegramConfig,
  readProjectBinding,
  persistProjectRuntimeState,
} from "../config.ts";
import { TelegramInstanceCoordinator, telegramTokenHash } from "../instance-coordinator.ts";
import type { BotRecord } from "../types.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
  };
}

describe("Polling cursor: coordinator authoritative, project lastUpdateId seed/backup", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-cursor-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-cursor-proj-"));
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("uses project lastUpdateId as cold-start seed when no coordinator cursor exists", async () => {
    const bot = makeBot({ token: "shared-tok" });
    await addBot(bot);
    // Seed project binding with lastUpdateId = 50.
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true, lastUpdateId: 50 });

    // No coordinator cursor exists yet → seed from project lastUpdateId.
    const coordinator = new TelegramInstanceCoordinator({
      token: bot.token,
      instanceId: "inst-a",
      startedAt: new Date().toISOString(),
    });

    // syncCursor with fallback from project binding = 50
    const resolved = await resolveTelegramConfig(projectDir);
    const projectSeed = resolved.config.lastUpdateId;
    expect(projectSeed).toBe(50);

    const cursor = await coordinator.syncCursor(projectSeed);
    expect(cursor).toBe(50);
  });

  it("coordinator cursor wins over project lastUpdateId after polling advances", async () => {
    const bot = makeBot({ token: "shared-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true, lastUpdateId: 50 });

    const coordinator = new TelegramInstanceCoordinator({
      token: bot.token,
      instanceId: "inst-a",
      startedAt: new Date().toISOString(),
    });

    // Seed the coordinator cursor to 50.
    await coordinator.syncCursor(50);
    // Polling advances to 75.
    await coordinator.persistCursor(75);

    // Now a new project (or /tg-switch owner) reads the coordinator cursor.
    // It should get 75, NOT the project's stale lastUpdateId of 50.
    const coordinatorCursor = await coordinator.syncCursor();
    expect(coordinatorCursor).toBe(75);

    // The project binding's lastUpdateId is only a best-effort backup.
    const project = await readProjectBinding(projectDir);
    expect(project?.binding.lastUpdateId).toBe(50); // not yet advanced
  });

  it("persistProjectRuntimeState advances project lastUpdateId as best-effort backup", async () => {
    const bot = makeBot({ token: "shared-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true, lastUpdateId: 50 });

    const resolved = await resolveTelegramConfig(projectDir);
    // Simulate polling advancing the offset to 80.
    const updated = await persistProjectRuntimeState(resolved, {
      ...resolved.config,
      lastUpdateId: 80,
    });
    expect(updated.config.lastUpdateId).toBe(80);

    // Project binding was updated as best-effort backup.
    const project = await readProjectBinding(projectDir);
    expect(project?.binding.lastUpdateId).toBe(80);
  });

  it("multi-project shared bot does not regress: /tg-switch uses coordinator cursor", async () => {
    const bot = makeBot({ token: "shared-tok" });
    await addBot(bot);

    const projectA = await mkdtemp(join(tmpdir(), "ptp-cursor-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "ptp-cursor-b-"));
    await writeProjectBinding(projectA, { botId: bot.id, enabled: true, lastUpdateId: 30 });
    await writeProjectBinding(projectB, { botId: bot.id, enabled: true, lastUpdateId: 10 });

    // Project A polls and advances cursor to 60.
    const coordinator = new TelegramInstanceCoordinator({
      token: bot.token,
      instanceId: "inst-a",
      startedAt: new Date().toISOString(),
    });
    await coordinator.syncCursor(30);
    await coordinator.persistCursor(60);

    // Project B becomes the active owner via /tg-switch.
    // It should use the coordinator cursor (60), NOT its own project lastUpdateId (10).
    const coordinatorCursor = await coordinator.syncCursor();
    expect(coordinatorCursor).toBe(60);

    // If project B tried to seed from its own lastUpdateId (10), that would
    // re-deliver updates 31-59. The coordinator prevents this.
    const projectBResolved = await resolveTelegramConfig(projectB);
    expect(projectBResolved.config.lastUpdateId).toBe(10); // project's stale seed
    // But the coordinator cursor (60) is authoritative.
    expect(coordinatorCursor).toBeGreaterThan(projectBResolved.config.lastUpdateId!);
  });

  it("coordinator tokenHash matches for same token across projects", () => {
    const hash1 = telegramTokenHash("shared-tok");
    const hash2 = telegramTokenHash("shared-tok");
    expect(hash1).toBe(hash2);

    const hash3 = telegramTokenHash("other-tok");
    expect(hash1).not.toBe(hash3);
  });
});