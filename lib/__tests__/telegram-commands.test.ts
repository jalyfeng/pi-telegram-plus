import { mkdtemp, mkdir, readFile } from "node:fs/promises";
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

// Deterministic pairing codes for the regenerate/unpair assertions.
const pairingMocks = vi.hoisted(() => ({ createTelegramPairingCode: vi.fn() }));
vi.mock("../pairing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof pairingModule>();
  return { ...actual, createTelegramPairingCode: pairingMocks.createTelegramPairingCode };
});

import {
  addBotFlow,
  bindProjectFlow,
  clearBotDefaultFlow,
  disableProjectFlow,
  enableProjectFlow,
  listBotsFlow,
  regeneratePairingCodeFlow,
  removeBotFlow,
  setBotDefaultFlow,
  unbindProjectFlow,
  unpairBotFlow,
  updateBotFlow,
  type TelegramCommandDeps,
} from "../commands/telegram-commands.ts";
import { readBotRegistry, readProjectBinding, addBot, clearDefaultBot, readResolvedTelegramConfig, enableConfiguredTelegramOnStartup } from "../config.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig } from "../types.ts";
import type * as pairingModule from "../pairing.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
    ...(overrides.allowedUserId === undefined ? {} : { allowedUserId: overrides.allowedUserId }),
    ...(overrides.pairingCode === undefined ? {} : { pairingCode: overrides.pairingCode }),
  };
}

describe("Telegram management flows (bot registry + project binding)", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let deps: TelegramCommandDeps;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;
  const pollingCalls: string[] = [];

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-cmd-"));
    await mkdir(join(agentDir, "projects"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-cmd-proj-"));

    config = {};
    resolvedConfig = undefined;
    pollingActive = false;
    pollingCalls.length = 0;
    mocks.getTelegramBotUsername.mockReset();
    mocks.getTelegramBotUsername.mockResolvedValue("testbot");
    pairingMocks.createTelegramPairingCode.mockReset().mockReturnValue("654321");

    deps = {
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
      getResolvedConfig: () => resolvedConfig,
      switchResolvedConfig: (next) => {
        resolvedConfig = next;
        config = next.config;
      },
      isTelegramEnabled: () => config.telegramEnabled === true,
      transport: {} as unknown as TelegramCommandDeps["transport"], // flows never send in these tests
      getPolling: () => ({
        start: () => { pollingActive = true; pollingCalls.push("start"); },
        stop: async () => { pollingActive = false; pollingCalls.push("stop"); },
        isActive: () => pollingActive,
      }),
      refreshStatus: () => undefined,
      syncTelegramCommands: async () => undefined,
      startStatusHeartbeat: () => undefined,
      clearStatusError: () => undefined,
      connectionState: () => "disconnected" as const,
      awaitReconcile: async () => undefined,
    };
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
      confirm: vi.fn(),
    },
  });

  it("addBotFlow adds a bot and sets it as default (first bot)", async () => {
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("my-bot");
    ctx.ui.inputSecret.mockResolvedValueOnce("token-123");

    await addBotFlow(ctx.ui, deps);

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

  it("addBotFlow rejects duplicate name", async () => {
    await addBot(makeBot({ name: "existing", token: "t1" }));
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("existing");
    ctx.ui.inputSecret.mockResolvedValueOnce("t2");

    await addBotFlow(ctx.ui, deps);

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1); // still only the original
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "error",
    );
  });

  it("listBotsFlow shows registered bots", async () => {
    await addBot(makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" }));
    const ctx = makeCtx();

    await listBotsFlow(ctx.ui);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("alpha"),
      "info",
    );
  });

  it("listBotsFlow shows 'no bots' with the /tg menu path when registry is empty", async () => {
    const ctx = makeCtx();

    await listBotsFlow(ctx.ui);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No bots registered. Add one in /tg → Bots → ➕ Add bot."),
      "info",
    );
  });

  it("listBotsFlow marks only the default bot with ⭐ default", async () => {
    const alpha = makeBot({ name: "alpha", token: "t1" });
    await addBot(alpha);
    await addBot(makeBot({ name: "beta", token: "t2" }));
    const ctx = makeCtx();

    await listBotsFlow(ctx.ui);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [body] = vi.mocked(ctx.ui.notify).mock.calls[0];
    const lines = String(body).split("\n");
    expect(lines.find((line) => line.includes("alpha"))).toContain("⭐ default");
    expect(lines.find((line) => line.includes("beta"))).not.toContain("⭐ default");
    expect(body).not.toContain("★ default");
  });

  it("setBotDefaultFlow sets the default bot", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);

    const ctx = makeCtx();
    await setBotDefaultFlow(ctx.ui, bot2.id, deps, projectDir);

    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
  });

  it("clearBotDefaultFlow unsets the global default without touching the project binding", async () => {
    const bot = makeBot({ name: "only", token: "tok-only" });
    await addBot(bot); // becomes default
    config = { botToken: bot.token };

    const ctx = makeCtx();
    await clearBotDefaultFlow(ctx.ui, deps, projectDir);

    expect((await readBotRegistry()).defaultBotId).toBeUndefined();
    expect(await readProjectBinding(projectDir)).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Default bot cleared"),
      "warning",
    );
    expect(config.botToken).toBeUndefined(); // unbound project re-resolved immediately
  });

  it("removeBotFlow removes a bot and warns about default", async () => {
    const bot = makeBot({ name: "only" });
    await addBot(bot);

    const ctx = makeCtx();
    await removeBotFlow(ctx.ui, deps, projectDir, bot.id, true);

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Warning"),
      "warning",
    );
  });

  it("updateBotFlow updates allowedUserId with a valid integer", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("allowedUserId");
    ctx.ui.input.mockResolvedValueOnce("12345");

    await updateBotFlow(ctx.ui, deps, projectDir, bot.id);

    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(12345);
  });

  it("updateBotFlow reports a renamed bot under its new name", async () => {
    const bot = makeBot({ name: "omp", token: "tok-rename" });
    await addBot(bot);
    const ctx = makeCtx();

    await updateBotFlow(ctx.ui, deps, projectDir, bot.id, "name", "omp-renamed");

    expect(ctx.ui.notify).toHaveBeenCalledWith(`Bot updated: omp-renamed (${bot.id.slice(0, 8)})`, "info");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Bot updated: omp "), expect.anything());
  });

  it("updateBotFlow rejects a non-integer allowedUserId", async () => {
    const bot: BotRecord = { id: crypto.randomUUID(), name: "mybot", token: "tok-x", allowedUserId: 1 };
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.input.mockResolvedValueOnce("allowedUserId");
    ctx.ui.input.mockResolvedValueOnce("not-a-number");

    await updateBotFlow(ctx.ui, deps, projectDir, bot.id);

    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(1); // unchanged
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid allowedUserId"),
      "error",
    );
  });

  it("bindProjectFlow with no bots guides to the /tg menu", async () => {
    const ctx = makeCtx();

    await bindProjectFlow(ctx.ui, deps, projectDir);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No bots registered. Use /tg → Bots → Add bot first."),
      "error",
    );
  });

  it("bindProjectFlow with bot name creates project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Project bound to bot: mybot"),
      "info",
    );
  });

  it("bindProjectFlow to a different bot notifies 'Switching bot' before the switch", async () => {
    const bot1 = makeBot({ name: "b1", token: "t1" });
    const bot2 = makeBot({ name: "b2", token: "t2" });
    await addBot(bot1);
    await addBot(bot2);
    config = { botToken: "t1", telegramEnabled: true }; // currently on bot1

    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "b2");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switching bot to b2"), "info");
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot2.id);
  });

  it("bindProjectFlow initial bind (no prior bot) does not notify 'Switching bot'", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    // config = {} from beforeEach (no prior botToken)
    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Switching bot"), "info");
  });

  it("unbindProjectFlow removes the project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const ctx = makeCtx();
    // First bind.
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");
    // Then unbind.
    await unbindProjectFlow(ctx.ui, deps, projectDir, true);

    const binding = await readProjectBinding(projectDir);
    expect(binding).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Removed Telegram project binding"),
      "info",
    );
  });

  it("unbindProjectFlow with no binding shows info message", async () => {
    const ctx = makeCtx();

    await unbindProjectFlow(ctx.ui, deps, projectDir, true);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no Telegram binding"),
      "info",
    );
  });

  it("enableProjectFlow creates minimal binding with default bot when none exists", async () => {
    const bot = makeBot({ name: "default", token: "tok-d" });
    await addBot(bot);

    const ctx = makeCtx();
    await enableProjectFlow(ctx.ui, deps, projectDir);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
  });

  it("enableProjectFlow without a default bot points at the ⭐ Default bot menu row", async () => {
    await addBot(makeBot({ name: "orphan", token: "tok-o" }));
    await clearDefaultBot();

    const ctx = makeCtx();
    await enableProjectFlow(ctx.ui, deps, projectDir);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No default bot. Set one in /tg → Bots → ⭐ Default bot.",
      "error",
    );
    expect(await readProjectBinding(projectDir)).toBeUndefined();
  });

  it("disableProjectFlow disables the bot in the project binding", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");

    await disableProjectFlow(ctx.ui, deps, projectDir);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
  });

  // ── T4.8a: disconnect must persist across config re-reads and restarts ──

  it("disableProjectFlow on an unbound project writes {enabled:false} and survives re-read + startup", async () => {
    const bot = makeBot({ name: "default", token: "tok-d" });
    await addBot(bot); // first bot becomes the default

    const ctx = makeCtx();
    await disableProjectFlow(ctx.ui, deps, projectDir);

    // Durable disconnect record: no botId (still means "default bot").
    const raw = await readFile(join(projectDir, ".pi", "telegram.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ enabled: false });

    // Re-reading the resolved config keeps disabled + default bot.
    const resolved = await readResolvedTelegramConfig(projectDir);
    expect(resolved.config.telegramEnabled).toBe(false);
    expect(resolved.bot?.id).toBe(bot.id);

    // Startup enable-on-configured must not flip the explicit false.
    expect(enableConfiguredTelegramOnStartup(resolved.config).telegramEnabled).toBe(false);
  });

  it("disableProjectFlow on a bound project keeps disabled across re-read + startup, botId unchanged", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");

    await disableProjectFlow(ctx.ui, deps, projectDir);

    const raw = await readFile(join(projectDir, ".pi", "telegram.json"), "utf8");
    const binding = JSON.parse(raw);
    expect(binding.enabled).toBe(false);
    expect(binding.botId).toBe(bot.id);

    const resolved = await readResolvedTelegramConfig(projectDir);
    expect(resolved.config.telegramEnabled).toBe(false);
    expect(resolved.bot?.id).toBe(bot.id);

    expect(enableConfiguredTelegramOnStartup(resolved.config).telegramEnabled).toBe(false);
  });

  it("enableProjectFlow after a default-bot disconnect removes the binding", async () => {
    const bot = makeBot({ name: "default", token: "tok-d" });
    await addBot(bot);

    const ctx = makeCtx();
    await disableProjectFlow(ctx.ui, deps, projectDir);
    await enableProjectFlow(ctx.ui, deps, projectDir);

    expect(await readProjectBinding(projectDir)).toBeUndefined();
    const resolved = await readResolvedTelegramConfig(projectDir);
    expect(resolved.config.telegramEnabled).toBe(true);
    expect(resolved.bot?.id).toBe(bot.id);
  });

  it("enableProjectFlow after a bound-project disconnect re-enables, keeping botId", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const ctx = makeCtx();
    await bindProjectFlow(ctx.ui, deps, projectDir, "mybot");

    await disableProjectFlow(ctx.ui, deps, projectDir);
    await enableProjectFlow(ctx.ui, deps, projectDir);

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true);
    expect(binding?.binding.botId).toBe(bot.id);
  });

  it("regeneratePairingCodeFlow replaces the pairing code and notifies the new instructions", async () => {
    const bot = makeBot({ name: "pairbot", token: "tok-p", pairingCode: "123456" });
    await addBot(bot);
    const ctx = makeCtx();

    await regeneratePairingCodeFlow(ctx.ui, deps, bot.id);

    const after = (await readBotRegistry()).bots[0];
    expect(after.pairingCode).toBe("654321");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pair 654321"), "info");
  });

  it("regeneratePairingCodeFlow mirrors the new code into the live config when this pi runs that bot", async () => {
    const bot = makeBot({ name: "live", token: "tok-live", pairingCode: "123456" });
    await addBot(bot);
    config = { botToken: bot.token, pairingCode: "123456" };
    const ctx = makeCtx();

    await regeneratePairingCodeFlow(ctx.ui, deps, bot.id);

    expect(config.pairingCode).toBe("654321");
  });

  it("unpairBotFlow confirms, clears allowedUserId and issues a fresh pairing code", async () => {
    const bot = makeBot({ name: "pairbot", token: "tok-p", allowedUserId: 777 });
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(true);

    await unpairBotFlow(ctx.ui, deps, bot.id);

    expect(ctx.ui.confirm).toHaveBeenCalledWith("Unpair?", expect.stringContaining("This chat will stop working"));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBeUndefined();
    expect(after.pairingCode).toBe("654321");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pair 654321"), "info");
  });

  it("unpairBotFlow cancel leaves allowedUserId and pairing code untouched", async () => {
    const bot = makeBot({ name: "keeppair", token: "tok-k", allowedUserId: 777, pairingCode: "111111" });
    await addBot(bot);
    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(false);

    await unpairBotFlow(ctx.ui, deps, bot.id);

    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBe(777);
    expect(after.pairingCode).toBe("111111");
  });

  it("unpairBotFlow on the bot this pi runs clears allowedUserId from the live config", async () => {
    const bot = makeBot({ name: "live", token: "tok-live", allowedUserId: 777 });
    await addBot(bot);
    config = { botToken: bot.token, allowedUserId: 777 };
    const ctx = makeCtx();
    ctx.ui.confirm.mockResolvedValueOnce(true);

    await unpairBotFlow(ctx.ui, deps, bot.id);

    expect(config.allowedUserId).toBeUndefined();
    expect(config.pairingCode).toBe("654321");
  });
});
