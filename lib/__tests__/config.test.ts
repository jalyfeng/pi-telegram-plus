import { describe, expect, it } from "vitest";
import { resolveTelegramConfigStore } from "../config.ts";
import type { TelegramConfigStore } from "../types.ts";

describe("resolveTelegramConfigStore", () => {
  const emptyStore: TelegramConfigStore = { version: 2, global: {}, workspaces: [] };

  it("returns global scope when no workspaces", () => {
    const result = resolveTelegramConfigStore(emptyStore, "/any/path");
    expect(result.scope).toBe("global");
    expect(result.config).toEqual({});
  });

  it("returns global config from store", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "tok", botUsername: "bot" },
      workspaces: [],
    };
    const result = resolveTelegramConfigStore(store, "/any/path");
    expect(result.scope).toBe("global");
    expect(result.config.botToken).toBe("tok");
    expect(result.config.botUsername).toBe("bot");
  });

  it("returns workspace scope when cwd matches", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: "/Users/test/project", config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, "/Users/test/project");
    expect(result.scope).toBe("workspace");
    expect(result.workspacePath).toBe("/Users/test/project");
    expect(result.config.botToken).toBe("ws-tok");
  });

  it("matches workspace when cwd is inside workspace path", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: "/Users/test/project", config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, "/Users/test/project/subdir");
    expect(result.scope).toBe("workspace");
    expect(result.config.botToken).toBe("ws-tok");
  });

  it("does not match workspace when cwd is outside", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: { botToken: "global-tok" },
      workspaces: [
        { path: "/Users/test/project", config: { botToken: "ws-tok" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, "/Users/other/project");
    expect(result.scope).toBe("global");
    expect(result.config.botToken).toBe("global-tok");
  });

  it("prefers longest matching workspace", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: "/Users/test", config: { botToken: "short" } },
        { path: "/Users/test/project", config: { botToken: "long" } },
      ],
    };
    const result = resolveTelegramConfigStore(store, "/Users/test/project");
    expect(result.scope).toBe("workspace");
    expect(result.config.botToken).toBe("long");
  });

  it("normalizes paths", () => {
    const store: TelegramConfigStore = {
      version: 2,
      global: {},
      workspaces: [
        { path: "/Users/test/project", config: { botToken: "tok" } },
      ],
    };
    // Same path should match
    const result = resolveTelegramConfigStore(store, "/Users/test/project/");
    expect(result.scope).toBe("workspace");
  });
});