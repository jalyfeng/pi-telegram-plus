import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock telegram-api to avoid real network calls.
const mocks = vi.hoisted(() => ({
  getTelegramBotUsername: vi.fn(),
}));

vi.mock("../telegram-api.ts", () => ({
  getTelegramBotUsername: mocks.getTelegramBotUsername,
}));

import { registerTelegramCommands, type TelegramCommandDeps } from "../commands/telegram-commands.ts";
import { readBotRegistry, readProjectBinding, addBot, writeBotRegistry } from "../config.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig } from "../types.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
  };
}

describe("Telegram commands (bot registry + project binding)", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;
  const pollingCalls: string[] = [];

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-cmd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-cmd-proj-"));

    commands = new Map();
    config = {};
    resolvedConfig = undefined;
    pollingActive = false;
    pollingCalls.length = 0;
    mocks.getTelegramBotUsername.mockReset();
    mocks.getTelegramBotUsername.mockResolvedValue("testbot");

    const deps: TelegramCommandDeps = {
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
      getResolvedConfig: () => resolvedConfig,
      switchResolvedConfig: (next) => {
        resolvedConfig = next;
        config = next.config;
      },
      isTelegramEnabled: () => config.telegramEnabled === true,
      transport: {} as any,
      getPolling: () => ({
        start: () => { pollingActive = true; pollingCalls.push("start"); },
        stop: async () => { pollingActive = false; pollingCalls.push("stop"); },
        isActive: () => pollingActive,
      }),
      refreshStatus: () => undefined,
      syncTelegramCommands: async () => undefined,
      startStatusHeartbeat: () => undefined,
      clearStatusError: () => undefined,
    };

    registerTelegramCommands(
      {
        registerCommand: (name, options) => {
          commands.set(name, options.handler);
        },
      },
      deps,
    );
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  const makeCtx = (cwd?: string) => ({
    cwd: cwd ?? projectDir,
    ui: {
      notify: vi.fn(),
      input: vi.fn(),
      inputSecret: vi.fn(),
      select: vi.fn(),
    },
  });

  it("registers all expected commands", () => {
    expect([...commands.keys()]).toContain("tg-bot-add");
    expect([...commands.keys()]).toContain("tg-bot-list");
    expect([...commands.keys()]).toContain("tg-bot-update");
    expect([...commands.keys()]).toContain("tg-bot-remove");
    expect([...commands.keys()]).toContain("tg-bot-default");
    expect([...commands.keys()]).toContain("tg-bind-cwd");
    expect([...commands.keys()]).toContain("tg-cwd-connect");
    expect([...commands.keys()]).toContain("tg-cwd-disconnect");
    expect([...commands.keys()]).toContain("tg-unbind-cwd");
    expect([...commands.keys()]).toContain("tg-list");
  });

  it("does NOT register old global commands", () => {
    expect([...commands.keys()]).not.toContain("tg-global-setup");
    expect([...commands.keys()]).not.toContain("tg-global-connect");
    expect([...commands.keys()]).not.toContain("tg-global-disconnect");
  });

  it("/tg-bot-add adds a bot and sets it as default (first bot)", async () => {
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("my-bot");
    ctx.ui.inputSecret.mockResolvedValueOnce("token-123");

    await commands.get("tg-bot-add")!("", ctx);

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].name).toBe("my-bot");
    expect(registry.bots[0].token).toBe("token-123");
    expect(registry.bots[0].botUsername).toBe("testbot");
    expect(registry.defaultBotId).toBe(registry.bots[0].id);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Bot added: my-bot"),
      "info",
    );
  });

  it("/tg-bot-add rejects duplicate name", async () => {
    await addBot(makeBot({ name: "existing", token: "t1" }));
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("existing");
    ctx.ui.inputSecret.mockResolvedValueOnce("t2");

    await commands.get("tg-bot-add")!("", ctx);

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1); // still only the original
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "error",
    );
  });

  it("/tg-bot-list shows registered bots", async () => {
    await addBot(makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" }));
    const ctx = makeCtx();

    await commands.get("tg-bot-list")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("alpha"),
      "info",
    );
  });

  it("/tg-bot-list shows 'no bots' when registry is empty", async () => {
    const ctx = makeCtx();

    await commands.get("tg-bot-list")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No bots registered"),
      "info",
    );
  });

  it("/tg-bot-default sets the default bot", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);

    const ctx = makeCtx();
    await commands.get("tg-bot-default")!(bot2.name, ctx);

    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
  });

  it("/tg-bot-remove removes a bot and warns about default", async () => {
    const bot = makeBot({ name: "only" });
    await addBot(bot);

    const ctx = makeCtx();
    await commands.get("tg-bot-remove")!(bot.name, ctx);

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Warning"),
      "warning",
    );
  });

  it("/tg-bot-update updates allowedUserId with a valid integer", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("allowedUserId");
    ctx.ui.input.mockResolvedValueOnce("12345");

    await commands.get("tg-bot-update")!(bot.name, ctx);

    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(12345);
  });

  it("/tg-bot-update rejects a non-integer allowedUserId", async () => {
    const bot: BotRecord = { id: crypto.randomUUID(), name: "mybot", token: "tok-x", allowedUserId: 1 };
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("allowedUserId");
    ctx.ui.input.mockResolvedValueOnce("not-a-number");

    await commands.get("tg-bot-update")!(bot.name, ctx);

    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(1); // unchanged
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid allowedUserId"),
      "error",
    );
  });

  it("/tg-bind-cwd with no bots guides to /tg-bot-add", async () => {
    const ctx = makeCtx();

    await commands.get("tg-bind-cwd")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No bots registered"),
      "error",
    );
  });

  it("/tg-bind-cwd with bot name creates project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const ctx = makeCtx();
    await commands.get("tg-bind-cwd")!("mybot", ctx);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Project bound to bot: mybot"),
      "info",
    );
  });

  it("/tg-unbind-cwd removes the project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    // First bind.
    const ctx = makeCtx();
    await commands.get("tg-bind-cwd")!("mybot", ctx);

    // Then unbind.
    await commands.get("tg-unbind-cwd")!("", ctx);

    const binding = await readProjectBinding(projectDir);
    expect(binding).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Removed Telegram project binding"),
      "info",
    );
  });

  it("/tg-unbind-cwd with no binding shows info message", async () => {
    const ctx = makeCtx();

    await commands.get("tg-unbind-cwd")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no Telegram binding"),
      "info",
    );
  });

  it("/tg-list shows project binding and default bot", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x", botUsername: "mybot" });
    await addBot(bot);

    const ctx = makeCtx();
    await commands.get("tg-bind-cwd")!("mybot", ctx);
    ctx.ui.notify.mockClear();

    await commands.get("tg-list")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Project:"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Default bot: mybot"),
      "info",
    );
  });

  it("/tg-cwd-connect creates minimal binding with default bot when none exists", async () => {
    const bot = makeBot({ name: "default", token: "tok-d" });
    await addBot(bot);

    const ctx = makeCtx();
    await commands.get("tg-cwd-connect")!("", ctx);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
  });

  it("/tg-cwd-disconnect disables the bot in the project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const ctx = makeCtx();
    await commands.get("tg-bind-cwd")!("mybot", ctx);

    await commands.get("tg-cwd-disconnect")!("", ctx);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
  });
});