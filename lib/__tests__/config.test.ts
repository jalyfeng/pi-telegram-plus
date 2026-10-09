import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { enableConfiguredTelegramOnStartup, resolveTelegramConfigStore } from "../config.ts";
import type { TelegramConfigStore } from "../types.ts";

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

describe("resolveTelegramConfigStore", () => {
  const emptyStore: TelegramConfigStore = { version: 2, global: {}, workspaces: [] };
  const parentPath = resolve("test-fixtures");
  const projectPath = resolve("test-fixtures", "project");
  const subPath = resolve("test-fixtures", "project", "subdir");
  const otherPath = resolve("test-fixtures", "other", "project");

  it("returns global scope when no workspaces", () => {
    const result = resolveTelegramConfigStore(emptyStore, projectPath);
    expect(result.scope).toBe("global");
    expect(result.config).toEqual({});
  });

  it("returns global config from store", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "tok", botUsername: "bot" },
      workspaces: [],
    };
    const result = resolveTelegramConfigStore(store, projectPath);
    expect(result.scope).toBe("global");
    expect(result.config.botToken).toBe("tok");
    expect(result.config.botUsername).toBe("bot");
  });

  it("returns workspace scope when cwd matches", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: projectPath, config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, projectPath);
    expect(result.scope).toBe("workspace");
    expect(result.workspacePath).toBe(projectPath);
    expect(result.config.botToken).toBe("ws-tok");
  });

  it("matches workspace when cwd is inside workspace path", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: projectPath, config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, subPath);
    expect(result.scope).toBe("workspace");
    expect(result.config.botToken).toBe("ws-tok");
  });

  it("does not match workspace when cwd is outside", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: projectPath, config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, otherPath);
    expect(result.scope).toBe("global");
    expect(result.config.botToken).toBe("global-tok");
  });

  it("prefers longest matching workspace", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: parentPath, config: { botToken: "short" } },
        { path: projectPath, config: { botToken: "long" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, projectPath);
    expect(result.scope).toBe("workspace");
    expect(result.config.botToken).toBe("long");
  });

  it("normalizes paths", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: projectPath, config: { botToken: "tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, projectPath + "/");
    expect(result.scope).toBe("workspace");
  });
});
describe("telegram config store persistence (tg.json)", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempDir: string;

  async function tempAgentDir(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return mkdtemp(join(tmpdir(), "ptp-config-test-"));
  }

  beforeEach(async () => {
    tempDir = await tempAgentDir();
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("migrates a legacy flat config file to the v2 store shape", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { readTelegramConfigStore } = await import("../config.ts");
    const legacy = { botToken: "legacy-tok", botUsername: "legacy-bot", allowedUserId: 42 };
    await writeFile(join(tempDir, "tg.json"), JSON.stringify(legacy, null, 2) + "\n");

    const store = await readTelegramConfigStore();

    expect(store.version).toBe(2);
    expect(store.global?.botToken).toBe("legacy-tok");
    expect(store.workspaces).toEqual([]);
    // The legacy file is upgraded on disk for the next read.
    const onDisk = JSON.parse(await readFile(join(tempDir, "tg.json"), "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.global.botToken).toBe("legacy-tok");
  });

  it("rejects files that are neither v2 nor a legacy flat config", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { readTelegramConfigStore } = await import("../config.ts");
    await writeFile(join(tempDir, "tg.json"), JSON.stringify({ version: 99, global: {} }) + "\n");

    await expect(readTelegramConfigStore()).rejects.toThrow(/Unsupported Telegram config format/);
  });

  it("writes atomically via rename and leaves no temp file behind", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { writeTelegramConfigStore } = await import("../config.ts");
    const store: TelegramConfigStore = { version: 2, global: { botToken: "tok" }, workspaces: [] };

    await writeTelegramConfigStore(store);

    const onDisk = JSON.parse(await readFile(join(tempDir, "tg.json"), "utf8"));
    expect(onDisk.global.botToken).toBe("tok");
    expect(await readdir(tempDir)).not.toContain("tg.json.tmp");
  });

  it("never observes a partial or empty store during concurrent writes and reads", async () => {
    const { readTelegramConfigStore, writeTelegramConfigStore } = await import("../config.ts");

    // Seed the file first so every subsequent read must see a complete store.
    await writeTelegramConfigStore({ version: 2, global: { botToken: "tok", lastUpdateId: 0 }, workspaces: [] });

    const writer = (async () => {
      for (let i = 0; i < 300; i++) {
        await writeTelegramConfigStore({
          version: 2,
          global: { botToken: "tok", lastUpdateId: i },
          workspaces: [],
        });
      }
    })();

    let failures = 0;
    const reader = (async () => {
      for (let i = 0; i < 300; i++) {
        try {
          const store = await readTelegramConfigStore();
          if (store.version !== 2 || store.global?.botToken !== "tok") failures++;
        } catch {
          failures++;
        }
      }
    })();

    await Promise.all([writer, reader]);
    expect(failures).toBe(0);
  });
});
