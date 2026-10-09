import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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