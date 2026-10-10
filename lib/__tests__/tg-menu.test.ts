import { mkdtemp } from "node:fs/promises";
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

import { registerTgMenuCommand, type SwitchInstanceDeps } from "../commands/tg-menu.ts";
import type { TelegramCommandDeps } from "../commands/telegram-commands.ts";
import type { TgConfigDeps } from "../commands/register.ts";
import { readBotRegistry, readProjectBinding, addBot } from "../config.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig } from "../types.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
  };
}

/** Choice label for "Set default" / "Bind to bot" menus (includes username). */
function botChoiceFull(bot: BotRecord, isDefault: boolean): string {
  const marker = isDefault ? " ★ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  return `${bot.name}${marker} · ${username} · ${bot.id.slice(0, 8)}`;
}

/** Choice label for "Bind to bot" via bindProjectFlow (marker is " ★" not " ★ default"). */
function botChoiceBind(bot: BotRecord, isDefault: boolean): string {
  const marker = isDefault ? " ★" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  return `${bot.name}${marker} · ${username} · ${bot.id.slice(0, 8)}`;
}

/** Choice label for "Update bot" / "Remove bot" menus (name + id only). */
function botChoiceSimple(bot: BotRecord): string {
  return `${bot.name} · ${bot.id.slice(0, 8)}`;
}

/** Scripted mock UI: returns values from the script in order, one per call. */
function makeScriptedUi(script: {
  select?: string[];
  input?: string[];
  inputSecret?: string[];
  confirm?: boolean[];
}) {
  let selectIdx = 0;
  let inputIdx = 0;
  let inputSecretIdx = 0;
  let confirmIdx = 0;
  const notifyCalls: { message: string; level: string }[] = [];

  const ui = {
    notify: vi.fn((message: string, level = "info") => { notifyCalls.push({ message, level }); }),
    select: vi.fn(async (_title: string, _options: string[]) => {
      return script.select?.[selectIdx++] ?? undefined;
    }),
    input: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.input?.[inputIdx++] ?? undefined;
    }),
    inputSecret: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.inputSecret?.[inputSecretIdx++] ?? undefined;
    }),
    confirm: vi.fn(async (_title: string, _message?: string) => {
      return script.confirm?.[confirmIdx++] ?? false;
    }),
  };
  return { ui, notifyCalls };
}

describe("/tg multi-level menu", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-menu-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-menu-proj-"));

    commands = new Map();
    config = {};
    resolvedConfig = undefined;
    pollingActive = false;
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
        start: () => { pollingActive = true; },
        stop: async () => { pollingActive = false; },
        isActive: () => pollingActive,
      }),
      refreshStatus: () => undefined,
      syncTelegramCommands: async () => undefined,
      startStatusHeartbeat: () => undefined,
      clearStatusError: () => undefined,
    };

    const configDeps: TgConfigDeps = {
      getSession: () => undefined,
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
    };

    const switchDeps: SwitchInstanceDeps = {
      getCoordinator: () => undefined,
      getCurrentChatId: () => undefined,
      stopPolling: async () => { pollingActive = false; },
      startPolling: () => { pollingActive = true; },
      requestReconcile: () => undefined,
      getCurrentTurn: () => undefined,
      pendingHandoffs: new Set<string>(),
    };

    registerTgMenuCommand(
      {
        registerCommand: (name, options) => {
          commands.set(name, options.handler);
        },
      },
      deps,
      configDeps,
      switchDeps,
    );
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  const makeCtx = (ui: any, cwd?: string) => ({
    cwd: cwd ?? projectDir,
    ui,
  });

  it("registers /tg command", () => {
    expect([...commands.keys()]).toContain("tg");
  });

  it("Close exits the menu immediately", async () => {
    const { ui } = makeScriptedUi({ select: ["❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("select=undefined exits the menu", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("Bots → List bots → shows bots then returns to Bots menu", async () => {
    await addBot(makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" }));
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "List bots", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(4);
    expect(notifyCalls.some((c) => c.message.includes("alpha"))).toBe(true);
  });

  it("Bots → Add bot → adds bot to registry", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "➕ Add bot", "⬅️ Back", "❌ Close"],
      input: ["my-menu-bot"],
      inputSecret: ["token-from-menu"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].name).toBe("my-menu-bot");
    expect(registry.bots[0].token).toBe("token-from-menu");
    expect(notifyCalls.some((c) => c.message.includes("Bot added"))).toBe(true);
  });

  it("Bots → Set default → sets default bot", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);

    // bot1 is the default (first added). bot2 is not default.
    const bot2Choice = botChoiceFull(bot2, false);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Set default", bot2Choice, "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
    expect(notifyCalls.some((c) => c.message.includes("Default bot set to"))).toBe(true);
  });

  it("Bots → Remove bot → confirms and removes", async () => {
    const bot = makeBot({ name: "toremove" });
    await addBot(bot);

    const botChoice = botChoiceSimple(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Remove bot", botChoice, "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(notifyCalls.some((c) => c.message.includes("Bot removed"))).toBe(true);
  });

  it("Bots → Remove bot → cancel confirm does not remove", async () => {
    const bot = makeBot({ name: "keep" });
    await addBot(bot);

    const botChoice = botChoiceSimple(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Remove bot", botChoice, "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
  });

  it("Bots → Update bot → updates allowedUserId", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);

    const botChoice = botChoiceSimple(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Update bot", botChoice, "⬅️ Back", "❌ Close"],
      input: ["allowedUserId", "99999"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(99999);
  });

  it("Project → Show binding → shows project info", async () => {
    const bot = makeBot({ name: "proj-bot", token: "t-p" });
    await addBot(bot);

    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Show binding", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("Project:"))).toBe(true);
  });

  it("Project → Bind to bot → writes .pi/telegram.json", async () => {
    const bot = makeBot({ name: "bind-bot", token: "t-b" });
    await addBot(bot);

    // bot is default (first added). bindProjectFlow uses " ★" marker.
    const botChoice = botChoiceBind(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Bind to bot", botChoice, "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("Project bound to bot"))).toBe(true);
  });

  it("Project → Enable → creates minimal binding with default bot", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);

    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Enable", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("enabled for current project"))).toBe(true);
  });

  it("Project → Disable → disables binding", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);

    // First enable via bind
    const botChoice = botChoiceBind(bot, true);
    const { ui: ui1 } = makeScriptedUi({
      select: ["📁 Project", "Bind to bot", botChoice, "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui1));

    // Now disable
    const { ui: ui2, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Disable", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui2));

    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
    expect(notifyCalls.some((c) => c.message.includes("disabled for current project"))).toBe(true);
  });

  it("Project → Unbind → confirms and removes binding", async () => {
    const bot = makeBot({ name: "unbind-bot", token: "t-u" });
    await addBot(bot);

    // First bind
    const botChoice = botChoiceBind(bot, true);
    const { ui: ui1 } = makeScriptedUi({
      select: ["📁 Project", "Bind to bot", botChoice, "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui1));

    // Now unbind
    const { ui: ui2, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Unbind", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui2));

    const binding = await readProjectBinding(projectDir);
    expect(binding).toBeUndefined();
    expect(notifyCalls.some((c) => c.message.includes("Removed Telegram project binding"))).toBe(true);
  });

  it("Config → Tool → sets tool level", async () => {
    // Config menu → select "🔧 Tool: brief" → pickRenderLevel shows ["  hidden", "● brief", "  full"]
    // We pick "  full" (non-current = two-space prefix)
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔧 Tool: brief", "  full", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.tool).toBe("full");
    expect(notifyCalls.some((c) => c.message.includes("Tool") && c.message.includes("full"))).toBe(true);
  });

  it("Config → Thinking → sets thinking level", async () => {
    // pickRenderLevel shows ["  hidden", "● brief", "  full"] — we pick "  hidden"
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "💭 Thinking: brief", "  hidden", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.thinking).toBe("hidden");
    expect(notifyCalls.some((c) => c.message.includes("Thinking") && c.message.includes("hidden"))).toBe(true);
  });

  it("Config → Retry → sets retry count", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔄 Retry: 3", "⬅️ Back", "❌ Close"],
      input: ["7"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.retryCount).toBe(7);
    expect(notifyCalls.some((c) => c.message.includes("Retry") && c.message.includes("7"))).toBe(true);
  });

  it("Back navigation: Bots → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Project → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Config → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["⚙️ Config", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Bots submenu with no bots shows info message", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "List bots", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Bots → Set default with no bots shows info message", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Set default", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Switch instance with no coordinator shows error", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🔄 Switch instance", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("not the active Telegram instance"))).toBe(true);
  });
});