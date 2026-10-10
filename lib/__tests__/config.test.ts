import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  enableConfiguredTelegramOnStartup,
  materializeTelegramConfig,
  readBotRegistry,
  writeBotRegistry,
  writeProjectBinding,
  readProjectBinding,
  removeProjectBinding,
  resolveTelegramConfig,
  bindProjectTelegram,
  unbindProjectTelegram,
  addBot,
  removeBot,
  setDefaultBot,
  updateBot,
  findBotByIdOrName,
  persistProjectRuntimeState,
  preserveInMemoryRuntimeState,
} from "../config.ts";
import type { BotRecord, BotRegistry, ProjectTelegramBinding, TelegramConfig } from "../types.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
    ...(overrides.allowedUserId === undefined ? {} : { allowedUserId: overrides.allowedUserId }),
    ...(overrides.pairingCode === undefined ? {} : { pairingCode: overrides.pairingCode }),
    ...(overrides.apiBase === undefined ? {} : { apiBase: overrides.apiBase }),
  };
}

describe("enableConfiguredTelegramOnStartup", () => {
  it("enables a configured bot", () => {
    expect(enableConfiguredTelegramOnStartup({ botToken: "tok", telegramEnabled: false })).toEqual({
      botToken: "tok",
      telegramEnabled: true,
    });
  });

  it("leaves an unconfigured bot disabled", () => {
    const config = { telegramEnabled: false };
    expect(enableConfiguredTelegramOnStartup(config)).toBe(config);
  });
});

// ── materializeTelegramConfig ─────────────────────────────────────────────

describe("materializeTelegramConfig", () => {
  it("returns empty config when no bot and no binding", () => {
    expect(materializeTelegramConfig(undefined, undefined)).toEqual({});
  });

  it("materializes a bot with defaults when no project binding", () => {
    const bot = makeBot({ botUsername: "mybot", allowedUserId: 42 });
    const config = materializeTelegramConfig(bot, undefined);
    expect(config.botToken).toBe("tok-1");
    expect(config.botUsername).toBe("mybot");
    expect(config.allowedUserId).toBe(42);
    expect(config.telegramEnabled).toBe(true);
  });

  it("applies project binding prefs and runtime state", () => {
    const bot = makeBot({ botUsername: "mybot" });
    const binding: ProjectTelegramBinding = {
      botId: bot.id,
      enabled: false,
      tool: "brief",
      thinking: "full",
      lastUpdateId: 99,
      activeChatId: 123,
    };
    const config = materializeTelegramConfig(bot, binding);
    expect(config.telegramEnabled).toBe(false);
    expect(config.tool).toBe("brief");
    expect(config.thinking).toBe("full");
    expect(config.lastUpdateId).toBe(99);
    expect(config.activeChatId).toBe(123);
  });

  it("defaults enabled=true when binding file exists but enabled is absent", () => {
    const bot = makeBot();
    const binding: ProjectTelegramBinding = { botId: bot.id };
    const config = materializeTelegramConfig(bot, binding);
    expect(config.telegramEnabled).toBe(true);
  });

  it("carries apiBase from bot record and retryCount from project binding", () => {
    const bot = makeBot({ apiBase: "http://localhost:8081" });
    // No binding → retryCount comes from nowhere (bot record no longer holds it).
    const withoutBinding = materializeTelegramConfig(bot, undefined);
    expect(withoutBinding.apiBase).toBe("http://localhost:8081");
    expect(withoutBinding.retryCount).toBeUndefined();
    // retryCount is a per-project pref, materialized from the binding.
    const withBinding = materializeTelegramConfig(bot, { botId: bot.id, retryCount: 5 });
    expect(withBinding.apiBase).toBe("http://localhost:8081");
    expect(withBinding.retryCount).toBe(5);
  });
});

// ── Project binding resolution (walk-up) ──────────────────────────────────

describe("resolveTelegramConfig — project binding walk-up", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-cfg-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-proj-"));
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("falls back to defaultBotId when no project binding exists", async () => {
    const bot = makeBot({ token: "default-tok", botUsername: "defaultbot" });
    await addBot(bot);
    // bot is first → becomes default automatically

    const result = await resolveTelegramConfig(projectDir);
    expect(result.hasProjectBinding).toBe(false);
    expect(result.bot?.id).toBe(bot.id);
    expect(result.config.botToken).toBe("default-tok");
    expect(result.config.telegramEnabled).toBe(true);
  });

  it("returns no bot when registry is empty and no project binding", async () => {
    const result = await resolveTelegramConfig(projectDir);
    expect(result.bot).toBeUndefined();
    expect(result.config).toEqual({});
  });

  it("uses project binding botId over defaultBotId", async () => {
    const defaultBot = makeBot({ name: "default", token: "default-tok" });
    const projectBot = makeBot({ name: "project", token: "project-tok" });
    await addBot(defaultBot);
    await addBot(projectBot);

    await writeProjectBinding(projectDir, { botId: projectBot.id, enabled: true });

    const result = await resolveTelegramConfig(projectDir);
    expect(result.hasProjectBinding).toBe(true);
    expect(result.bot?.id).toBe(projectBot.id);
    expect(result.config.botToken).toBe("project-tok");
  });

  it("walks up to find .pi/telegram.json in a parent directory", async () => {
    const bot = makeBot({ token: "walk-tok" });
    await addBot(bot);

    const parentDir = projectDir;
    const childDir = join(parentDir, "subdir");
    await mkdir(childDir, { recursive: true });

    await writeProjectBinding(parentDir, { botId: bot.id, enabled: true });

    const result = await resolveTelegramConfig(childDir);
    expect(result.hasProjectBinding).toBe(true);
    expect(result.projectPath).toBe(parentDir);
    expect(result.bot?.id).toBe(bot.id);
  });

  it("uses binding.botId absent → defaultBotId when project binding has no botId", async () => {
    const defaultBot = makeBot({ token: "default-tok" });
    await addBot(defaultBot);

    await writeProjectBinding(projectDir, { enabled: true, tool: "brief" });

    const result = await resolveTelegramConfig(projectDir);
    expect(result.hasProjectBinding).toBe(true);
    expect(result.bot?.id).toBe(defaultBot.id);
    expect(result.config.tool).toBe("brief");
  });

  it("falls back to defaultBotId when project binding references a removed bot", async () => {
    const defaultBot = makeBot({ name: "default", token: "default-tok" });
    const projectBot = makeBot({ name: "project", token: "project-tok" });
    await addBot(defaultBot); // becomes default
    await addBot(projectBot);
    await writeProjectBinding(projectDir, { botId: projectBot.id, enabled: true });
    await removeBot(projectBot.id); // project bot removed → binding now dangles

    const result = await resolveTelegramConfig(projectDir);
    expect(result.hasProjectBinding).toBe(true);
    expect(result.bot?.id).toBe(defaultBot.id); // fell back to default
    expect(result.config.botToken).toBe("default-tok");
  });

  it("returns no bot when a dangling ref has no default to fall back to", async () => {
    const bot = makeBot({ token: "temp-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    await removeBot(bot.id); // no default remains

    const result = await resolveTelegramConfig(projectDir);
    expect(result.bot).toBeUndefined();
  });
});

// ── Registry CRUD ─────────────────────────────────────────────────────────

describe("Bot registry CRUD", () => {
  let agentDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-crud-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("writes and reads a v3 registry atomically", async () => {
    const registry: BotRegistry = {
      version: 3,
      bots: [makeBot({ name: "a", token: "ta" })],
      defaultBotId: "x",
    };
    await writeBotRegistry(registry);
    const read = await readBotRegistry();
    expect(read.version).toBe(3);
    expect(read.bots).toHaveLength(1);
    expect(read.bots[0].name).toBe("a");
    expect(read.defaultBotId).toBe("x");
    // No temp file left behind.
    expect(await readdir(agentDir)).not.toContain("tg.json.tmp");
  });

  it("addBot sets first bot as default", async () => {
    const bot = makeBot({ name: "first" });
    const registry = await addBot(bot);
    expect(registry.defaultBotId).toBe(bot.id);
  });

  it("addBot does not override existing default", async () => {
    const bot1 = makeBot({ name: "first" });
    const bot2 = makeBot({ name: "second" });
    await addBot(bot1);
    const registry = await addBot(bot2);
    expect(registry.defaultBotId).toBe(bot1.id);
  });

  it("updateBot modifies fields", async () => {
    const bot = makeBot({ name: "orig" });
    await addBot(bot);
    await updateBot(bot.id, { name: "renamed" });
    const registry = await readBotRegistry();
    expect(registry.bots[0].name).toBe("renamed");
  });

  it("updateBot throws for unknown id", async () => {
    await expect(updateBot("nonexistent", { name: "x" })).rejects.toThrow(/Bot not found/);
  });

  it("removeBot clears defaultBotId when removing the default", async () => {
    const bot = makeBot({ name: "only" });
    await addBot(bot);
    await removeBot(bot.id);
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(registry.defaultBotId).toBeUndefined();
  });

  it("removeBot promotes remaining bot to default when removing the default", async () => {
    const bot1 = makeBot({ name: "first" });
    const bot2 = makeBot({ name: "second" });
    await addBot(bot1);
    await addBot(bot2);
    // bot1 is default
    await removeBot(bot1.id);
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
  });

  it("setDefaultBot changes the default", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);
    await setDefaultBot(bot2.id);
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
  });

  it("setDefaultBot throws for unknown id", async () => {
    await expect(setDefaultBot("nonexistent")).rejects.toThrow(/Bot not found/);
  });

  it("findBotByIdOrName matches by id and by name (case-insensitive)", async () => {
    const bot = makeBot({ id: "abc-123", name: "MyBot" });
    const registry: BotRegistry = { version: 3, bots: [bot] };
    expect(findBotByIdOrName(registry, "abc-123")).toBe(bot);
    expect(findBotByIdOrName(registry, "mybot")).toBe(bot);
    expect(findBotByIdOrName(registry, "MyBot")).toBe(bot);
    expect(findBotByIdOrName(registry, "nonexistent")).toBeUndefined();
  });
});

// ── Project binding read / write ──────────────────────────────────────────

describe("Project binding file read/write", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "ptp-bind-"));
  });

  it("writes and reads a project binding", async () => {
    const binding: ProjectTelegramBinding = {
      botId: "bot-1",
      enabled: true,
      tool: "brief",
    };
    await writeProjectBinding(projectDir, binding);
    const result = await readProjectBinding(projectDir);
    expect(result?.path).toBe(projectDir);
    expect(result?.binding.botId).toBe("bot-1");
    expect(result?.binding.enabled).toBe(true);
    expect(result?.binding.tool).toBe("brief");
  });

  it("returns undefined when no binding file exists", async () => {
    const result = await readProjectBinding(projectDir);
    expect(result).toBeUndefined();
  });

  it("removes the binding file", async () => {
    await writeProjectBinding(projectDir, { botId: "x" });
    await removeProjectBinding(projectDir);
    const result = await readProjectBinding(projectDir);
    expect(result).toBeUndefined();
  });

  it("walks up from a subdirectory to find parent binding", async () => {
    const parentDir = projectDir;
    const childDir = join(parentDir, "a", "b");
    await mkdir(childDir, { recursive: true });
    await writeProjectBinding(parentDir, { botId: "parent-bot" });
    const result = await readProjectBinding(childDir);
    expect(result?.path).toBe(parentDir);
    expect(result?.binding.botId).toBe("parent-bot");
  });
});

// ── bind / unbind project ─────────────────────────────────────────────────

describe("bindProjectTelegram / unbindProjectTelegram", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-bind2-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-proj2-"));
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("binds a project to a bot and resolves", async () => {
    const bot = makeBot({ token: "bind-tok" });
    await addBot(bot);
    const result = await bindProjectTelegram(projectDir, bot.id, { tool: "full" });
    expect(result.hasProjectBinding).toBe(true);
    expect(result.bot?.id).toBe(bot.id);
    expect(result.config.botToken).toBe("bind-tok");
    expect(result.config.tool).toBe("full");
  });

  it("unbind removes the binding and falls back to default", async () => {
    const bot = makeBot({ token: "bind-tok" });
    await addBot(bot);
    await bindProjectTelegram(projectDir, bot.id);
    const result = await unbindProjectTelegram(projectDir);
    expect(result.hasProjectBinding).toBe(false);
    // bot is default, so still resolves
    expect(result.bot?.id).toBe(bot.id);
  });
});

// ── Migration (v2 → v3) ───────────────────────────────────────────────────

describe("Migration v2 → v3", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-mig-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-migproj-"));
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("migrates a legacy flat config to v3 (one bot, set as default)", async () => {
    const legacy = { botToken: "legacy-tok", botUsername: "legacy-bot", allowedUserId: 42 };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(legacy) + "\n");

    const registry = await readBotRegistry();
    expect(registry.version).toBe(3);
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].token).toBe("legacy-tok");
    expect(registry.bots[0].botUsername).toBe("legacy-bot");
    expect(registry.bots[0].allowedUserId).toBe(42);
    expect(registry.defaultBotId).toBe(registry.bots[0].id);

    // v3 is persisted on disk.
    const onDisk = JSON.parse(await readFile(join(agentDir, "tg.json"), "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.bots).toHaveLength(1);
  });

  it("migrates a v2 store with global → default bot", async () => {
    const v2Store = {
      version: 2,
      global: { botToken: "global-tok", botUsername: "globalbot", allowedUserId: 10 },
      workspaces: [],
    };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(v2Store) + "\n");

    const registry = await readBotRegistry();
    expect(registry.version).toBe(3);
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].token).toBe("global-tok");
    expect(registry.defaultBotId).toBe(registry.bots[0].id);
  });

  it("migrates v2 workspaces → project .pi/telegram.json files with token dedup", async () => {
    // Create a real project dir for the workspace.
    const v2Store = {
      version: 2,
      global: { botToken: "shared-tok", botUsername: "sharedbot" },
      workspaces: [
        { path: projectDir, config: { botToken: "shared-tok", botUsername: "sharedbot", telegramEnabled: true, tool: "brief" as const, retryCount: 7, lastUpdateId: 5 } },
      ],
    };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(v2Store) + "\n");

    const registry = await readBotRegistry();
    expect(registry.version).toBe(3);
    // Token dedup: global and workspace share "shared-tok" → one bot.
    expect(registry.bots).toHaveLength(1);
    expect(registry.defaultBotId).toBe(registry.bots[0].id);

    // Project .pi/telegram.json was written.
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(registry.bots[0].id);
    expect(binding?.binding.enabled).toBe(true);
    expect(binding?.binding.tool).toBe("brief");
    expect(binding?.binding.retryCount).toBe(7);
    expect(binding?.binding.lastUpdateId).toBe(5);
    // retryCount is NOT bot identity — it must not land on the bot record.
    expect((registry.bots[0] as Record<string, unknown>).retryCount).toBeUndefined();
  });

  it("migrates v2 workspaces with different tokens → separate bots", async () => {
    const projectDir2 = await mkdtemp(join(tmpdir(), "ptp-migproj2-"));
    const v2Store = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: projectDir, config: { botToken: "ws-tok-1", botUsername: "wsbot1" } },
        { path: projectDir2, config: { botToken: "ws-tok-2", botUsername: "wsbot2" } },
      ],
    };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(v2Store) + "\n");

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(3); // global + 2 workspace bots
    // global is default
    const globalBot = registry.bots.find((b) => b.token === "global-tok");
    expect(registry.defaultBotId).toBe(globalBot?.id);

    // Both project bindings exist.
    const binding1 = await readProjectBinding(projectDir);
    const binding2 = await readProjectBinding(projectDir2);
    expect(binding1?.binding.botId).toBeDefined();
    expect(binding2?.binding.botId).toBeDefined();
    expect(binding1?.binding.botId).not.toBe(binding2?.binding.botId);
  });

  it("skips non-existent workspace paths with a warning (non-throwing)", async () => {
    const v2Store = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: "/nonexistent/path/that/does/not/exist", config: { botToken: "ws-tok" } },
      ],
    };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(v2Store) + "\n");

    // Should not throw.
    const registry = await readBotRegistry();
    expect(registry.version).toBe(3);
    expect(registry.bots).toHaveLength(2); // global + workspace bot (bot is created even if path is skipped)
    // The workspace bot exists but no project binding was written.
  });

  it("passes through v3 registry unchanged", async () => {
    const v3: BotRegistry = {
      version: 3,
      bots: [makeBot({ name: "existing", token: "existing-tok" })],
      defaultBotId: "existing-id",
    };
    await writeFile(join(agentDir, "tg.json"), JSON.stringify(v3) + "\n");

    const registry = await readBotRegistry();
    expect(registry.version).toBe(3);
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].name).toBe("existing");
  });

  it("rejects files with an unsupported version", async () => {
    await writeFile(join(agentDir, "tg.json"), JSON.stringify({ version: 99, bots: [] }) + "\n");
    await expect(readBotRegistry()).rejects.toThrow(/Unsupported Telegram config format/);
  });
});

// ── Atomic write / concurrent access ──────────────────────────────────────

describe("Registry persistence (tg.json)", () => {
  let agentDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-persist-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("writes atomically via rename and leaves no temp file behind", async () => {
    const registry: BotRegistry = {
      version: 3,
      bots: [makeBot({ name: "a", token: "ta" })],
    };
    await writeBotRegistry(registry);

    const onDisk = JSON.parse(await readFile(join(agentDir, "tg.json"), "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.bots).toHaveLength(1);
    expect(await readdir(agentDir)).not.toContain("tg.json.tmp");
  });

  it("never observes a partial or empty registry during concurrent writes and reads", async () => {
    // Seed the file first.
    await writeBotRegistry({ version: 3, bots: [makeBot({ name: "seed", token: "seed-tok" })], defaultBotId: "seed-id" });

    const writer = (async () => {
      for (let i = 0; i < 200; i++) {
        await writeBotRegistry({
          version: 3,
          bots: [makeBot({ name: `bot-${i}`, token: `tok-${i}` })],
        });
      }
    })();

    let failures = 0;
    const reader = (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const registry = await readBotRegistry();
          if (registry.version !== 3 || !Array.isArray(registry.bots)) failures++;
        } catch {
          failures++;
        }
      }
    })();

    await Promise.all([writer, reader]);
    expect(failures).toBe(0);
  });
});

// ── persistProjectRuntimeState ────────────────────────────────────────────
describe("persistProjectRuntimeState", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-prs-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-prsproj-"));
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("persists tool, thinking, retryCount, lastUpdateId, activeChatId to the project binding (P1-1)", async () => {
    const bot = makeBot({ token: "prs-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    const resolved = await resolveTelegramConfig(projectDir);

    await persistProjectRuntimeState(resolved, {
      botToken: bot.token,
      telegramEnabled: true,
      tool: "full",
      thinking: "brief",
      retryCount: 4,
      lastUpdateId: 42,
      activeChatId: 99,
    });

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.tool).toBe("full");
    expect(binding?.binding.thinking).toBe("brief");
    expect(binding?.binding.retryCount).toBe(4);
    expect(binding?.binding.lastUpdateId).toBe(42);
    expect(binding?.binding.activeChatId).toBe(99);
    // botId preserved.
    expect(binding?.binding.botId).toBe(bot.id);
  });

  it("re-resolved config restores prefs persisted to the binding (P1-1 round-trip)", async () => {
    const bot = makeBot({ token: "prs-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    const resolved = await resolveTelegramConfig(projectDir);

    const out = await persistProjectRuntimeState(resolved, {
      botToken: bot.token,
      telegramEnabled: true,
      tool: "full",
      thinking: "hidden",
      retryCount: 2,
      activeChatId: 7,
    });
    // The returned materialized config reflects the just-persisted prefs.
    expect(out.config.tool).toBe("full");
    expect(out.config.thinking).toBe("hidden");
    expect(out.config.retryCount).toBe(2);
    expect(out.config.activeChatId).toBe(7);
  });

  it("preserves in-memory activeChatId / lastUpdateId / prefs for an unbound project (P1-2)", async () => {
    const bot = makeBot({ token: "def-tok" });
    await addBot(bot); // default bot, no project binding
    const resolved = await resolveTelegramConfig(projectDir); // unbound
    expect(resolved.hasProjectBinding).toBe(false);

    const out = await persistProjectRuntimeState(
      resolved,
      {
        botToken: bot.token,
        telegramEnabled: true,
        activeChatId: 555,
        lastUpdateId: 30,
        tool: "full",
        thinking: "brief",
        retryCount: 6,
      },
      projectDir,
    );
    // Nothing was written to disk (no .pi/telegram.json).
    expect(await readProjectBinding(projectDir)).toBeUndefined();
    // But in-memory runtime/pref state is preserved on the returned config.
    expect(out.config.activeChatId).toBe(555);
    expect(out.config.lastUpdateId).toBe(30);
    expect(out.config.tool).toBe("full");
    expect(out.config.thinking).toBe("brief");
    expect(out.config.retryCount).toBe(6);
    expect(out.config.botToken).toBe(bot.token);
  });

  it("does not persist to the registry (registry immutability)", async () => {
    const bot = makeBot({ token: "prs-tok" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    const resolved = await resolveTelegramConfig(projectDir);

    await persistProjectRuntimeState(resolved, {
      botToken: bot.token,
      telegramEnabled: true,
      tool: "full",
      retryCount: 9,
      lastUpdateId: 100,
      activeChatId: 200,
    });

    const registry = await readBotRegistry();
    expect((registry.bots[0] as Record<string, unknown>).retryCount).toBeUndefined();
    // Bot record untouched except via CRUD.
    expect(registry.bots[0].token).toBe("prs-tok");
  });
});

// ── preserveInMemoryRuntimeState (unit) ───────────────────────────────────
describe("preserveInMemoryRuntimeState", () => {
  it("fills gaps in persisted from memory", () => {
    const persisted: TelegramConfig = { botToken: "t", telegramEnabled: true };
    const memory: TelegramConfig = {
      botToken: "t",
      telegramEnabled: true,
      activeChatId: 5,
      lastUpdateId: 9,
      tool: "full",
      thinking: "brief",
      retryCount: 2,
    };
    const out = preserveInMemoryRuntimeState(persisted, memory);
    expect(out).toEqual({ botToken: "t", telegramEnabled: true, activeChatId: 5, lastUpdateId: 9, tool: "full", thinking: "brief", retryCount: 2 });
  });

  it("persisted values win over memory", () => {
    const persisted: TelegramConfig = { botToken: "t", telegramEnabled: true, tool: "brief", lastUpdateId: 50 };
    const memory: TelegramConfig = { botToken: "t", telegramEnabled: true, tool: "full", lastUpdateId: 10 };
    const out = preserveInMemoryRuntimeState(persisted, memory);
    expect(out.tool).toBe("brief"); // persisted wins
    expect(out.lastUpdateId).toBe(50); // persisted wins
  });
});