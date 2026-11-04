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

// Deterministic pairing codes for the regenerate/unpair assertions.
const pairingMocks = vi.hoisted(() => ({ createTelegramPairingCode: vi.fn() }));
vi.mock("../pairing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof pairingModule>();
  return { ...actual, createTelegramPairingCode: pairingMocks.createTelegramPairingCode };
});

import { buildConfigMenuOptions, formatInstanceChoices, registerTgMenuCommand, type SwitchInstanceDeps } from "../commands/tg-menu.ts";
import { configModeFlow, configToolFlow } from "../commands/tg-config.ts";
import type { TelegramCommandDeps, TelegramConnectionState } from "../commands/telegram-commands.ts";
import type { TgConfigDeps } from "../commands/register.ts";
import { readBotRegistry, readProjectBinding, addBot, writeProjectBinding, clearDefaultBot } from "../config.ts";
import type { CapturedAgentSession } from "../types.ts";
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

/** Choice label for bot-list / picker menus (matches formatBotLabel in tg-menu.ts). */
function botChoiceFull(bot: BotRecord, isDefault: boolean): string {
  const marker = isDefault ? " ⭐ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  const paired = bot.allowedUserId !== undefined ? "paired" : "not paired";
  return `${bot.name}${marker} · ${username} · ${paired}`;
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

/** Telegram-style UI: menu() pages are scripted; every page's title, options and body are recorded. */
function makeMenuUi(menu: string[]) {
  let menuIdx = 0;
  const pages: { title: string; options: string[]; body?: string }[] = [];
  const notify = vi.fn((_message: string, _level?: string) => undefined);
  const ui = {
    notify,
    select: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    menu: vi.fn(async (title: string, options: string[], body?: string) => {
      pages.push({ title, options, body });
      return menu[menuIdx++] ?? undefined;
    }),
    closeMenu: vi.fn(async () => undefined),
  };
  return { ui, notify, pages };
}

describe("/tg multi-level menu", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;
  let connectionStateValue: TelegramConnectionState;
  let awaitReconcileCalls: number;
  let menuSession: CapturedAgentSession | undefined;
  let commandCatalog: { name: string; description?: string }[];
  let menuEvents: string[];

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
    // No username by default, so existing labels stay "no username"; tests that need one set it.
    mocks.getTelegramBotUsername.mockResolvedValue(undefined);
    pairingMocks.createTelegramPairingCode.mockReset().mockReturnValue("654321");

    connectionStateValue = "disconnected";
    awaitReconcileCalls = 0;
    menuSession = undefined;
    commandCatalog = [];
    menuEvents = [];

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
      connectionState: () => connectionStateValue,
      awaitReconcile: async () => { awaitReconcileCalls += 1; },
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
      {
        getCommands: async () => commandCatalog,
        runCommand: async (name) => { menuEvents.push(`run:${name}`); },
      },
      { getSession: () => menuSession },
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

  it("cancelling the main menu exits immediately", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("select=undefined exits the menu", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot list → shows bots as selectable options", async () => {
    const bot = makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    const botListCall = ui.select.mock.calls[2]; // 3rd select = Bot list (after main + Bots submenu)
    expect(botListCall[1]).toContain(botChoiceFull(bot, true));
  });

  it("Bots → Bot list stores the getMe username of a bot that has none, once", async () => {
    const bot = makeBot({ name: "legacy", token: "legacy-token" });
    await addBot(bot);
    mocks.getTelegramBotUsername.mockResolvedValue("testbot");
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots[0].botUsername).toBe("testbot");
    expect(mocks.getTelegramBotUsername).toHaveBeenCalledTimes(1);
    expect(mocks.getTelegramBotUsername).toHaveBeenCalledWith("legacy-token", undefined);
    // The label the list shows now carries the stored username.
    expect(ui.select.mock.calls[2][1]).toContain(botChoiceFull({ ...bot, botUsername: "testbot" }, true));
  });

  it("Bots → Bot list → bot → Update picks the field from four buttons, then asks for its value", async () => {
    const bot = makeBot({ name: "upd", token: "t-upd" });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Update", "name", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      input: ["upd-renamed"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const fieldCall = ui.select.mock.calls.find((call) => call[0] === "Field to update");
    expect(fieldCall?.[1]).toEqual(["token", "name", "allowedUserId", "apiBase"]);
    expect(ui.input).toHaveBeenCalledTimes(1);
    expect(ui.input).toHaveBeenCalledWith("New value for name", undefined);
    expect((await readBotRegistry()).bots[0].name).toBe("upd-renamed");
    expect(notifyCalls.some((c) => c.message.includes("Bot updated: upd-renamed"))).toBe(true);
  });

  it("Bots → Add bot → adds bot to registry", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "➕ Add bot", "⬅️ Back"],
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

  it("Bots → Default bot → pick bot sets the global default", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);
    // bot1 is the default (first added). bot2 is not default.
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ Default bot: a", botChoiceFull(bot2, false), "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
    expect(notifyCalls.some((c) => c.message.includes("Default bot set to"))).toBe(true);
  });

  it("Clear default on an unbound project clears globally, warns, refreshes routing and closes the menu", async () => {
    const bot = makeBot({ name: "solo" });
    await addBot(bot); // becomes default
    config = { botToken: bot.token };
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ Default bot: solo", "Clear default"],
    });
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, closeMenu }));
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBeUndefined();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledTimes(3); // menu exited right after clearing
    expect(closeMenu).toHaveBeenCalled();
    expect(notifyCalls.some((c) => c.message.includes("Default bot cleared"))).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("/tg → Project → Bot"))).toBe(true);
    expect(config.botToken).toBeUndefined(); // runtime re-resolved immediately
  });

  it("Clear default on a bound project clears globally and stays in the menu", async () => {
    const bot = makeBot({ name: "solo" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    config = { botToken: bot.token };
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ Default bot: solo", "Clear default", "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect((await readBotRegistry()).defaultBotId).toBeUndefined();
    expect(ui.confirm).not.toHaveBeenCalled();
    // picker re-rendered without Clear default (no default any more)
    expect(ui.select.mock.calls[3][1]).toEqual([botChoiceFull(bot, false), "⬅️ Back"]);
    expect(config.botToken).toBe(bot.token); // binding still routes this project
  });

  it("setting another default on an unbound project switches bots → notifies and closes the menu", async () => {
    const bot1 = makeBot({ name: "a", token: "tok-a" });
    const bot2 = makeBot({ name: "b", token: "tok-b", botUsername: "b_bot" });
    await addBot(bot1);
    await addBot(bot2);
    config = { botToken: bot1.token };
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ Default bot: a", botChoiceFull(bot2, false)],
    });
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, closeMenu }));
    expect((await readBotRegistry()).defaultBotId).toBe(bot2.id);
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(closeMenu).toHaveBeenCalled();
    expect(notifyCalls.some((c) => c.message.includes("switches to @b_bot"))).toBe(true);
    expect(config.botToken).toBe("tok-b"); // runtime switched immediately
  });

  it("running a command from the Commands list closes the /tg menu before running it", async () => {
    commandCatalog = [{ name: "fast", description: "Toggle fast mode" }];
    const { ui } = makeScriptedUi({ select: ["⌨️ Commands", "/fast — Toggle fast mode"] });
    const closeMenu = vi.fn(async () => { menuEvents.push("closeMenu"); });
    await commands.get("tg")!("", makeCtx({ ...ui, closeMenu }));
    expect(menuEvents.filter((e) => e === "run:fast")).toHaveLength(1);
    expect(menuEvents.indexOf("closeMenu")).toBeGreaterThanOrEqual(0);
    expect(menuEvents.indexOf("closeMenu")).toBeLessThan(menuEvents.indexOf("run:fast"));
    expect(ui.select).toHaveBeenCalledTimes(2); // main menu + Commands list; no return to main menu
    expect(closeMenu).toHaveBeenCalled();
  });

  it("Back from the Commands list returns to the main menu without running anything", async () => {
    commandCatalog = [{ name: "fast", description: "Toggle fast mode" }];
    const { ui } = makeScriptedUi({ select: ["⌨️ Commands", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(menuEvents).toEqual([]);
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(ui.select.mock.calls[2][0]).toBe("Telegram Management");
  });

  it("navigates with ui.menu when available and closes the menu on exit", async () => {
    const { ui } = makeScriptedUi({});
    const picks = ["🤖 Bots", "⬅️ Back", "⚙️ Config", "⬅️ Back"];
    let i = 0;
    const menu = vi.fn(async (_title: string, _options: string[]) => picks[i++]);
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, menu, closeMenu }));
    expect(menu.mock.calls.map((c) => c[0])).toEqual([
      "Telegram Management", "🤖 Bots", "Telegram Management", "⚙️ Telegram Config", "Telegram Management",
    ]);
    expect(ui.select).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot list → bot → Remove → confirms and removes", async () => {
    const bot = makeBot({ name: "toremove" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Remove", "⬅️ Back"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(notifyCalls.some((c) => c.message.includes("Bot removed"))).toBe(true);
  });

  it("Bots → Bot list → bot → Remove → cancel confirm does not remove and stays on the bot", async () => {
    const bot = makeBot({ name: "keep" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Remove", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(ui.select.mock.calls[4][0]).toBe("🤖 keep"); // re-rendered bot detail (no default marker), not the list
  });

  it("Bots → Bot list → bot → Update → updates allowedUserId", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Update", "allowedUserId", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      input: ["99999"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(99999);
  });

  it("Bots → Bot list → bot detail offers Update/Pairing/Remove only (no default toggle)", async () => {
    const bot = makeBot({ name: "zeta", token: "t-z" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "⬅️ Back", "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const detailCall = ui.select.mock.calls[3]; // 4th select = bot detail (main + Bots + Bot list + detail)
    expect(detailCall[1]).toEqual(["Update", "Pairing", "Remove", "⬅️ Back"]);
  });

  it("Bots submenu shows Add/list/Default in order with the default bot named", async () => {
    const bot = makeBot({ name: "alpha", token: "t-a" });
    await addBot(bot); // becomes default
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[1][1]).toEqual(["➕ Add bot", "Bot list", "⭐ Default bot: alpha", "⬅️ Back"]);
  });

  it("Bots submenu default line shows not set when no default is set", async () => {
    await addBot(makeBot({ name: "alpha", token: "t-a" }));
    await clearDefaultBot();
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "⭐ Default bot: not set", "⬅️ Back", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[2][0]).toBe("⭐ Default bot");
    expect(ui.select.mock.calls[2][1]).not.toContain("Clear default");
  });

  it("Project → shows the effective bot in the Bot label", async () => {
    const bot = makeBot({ name: "proj-bot", token: "t-p" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    const projectCall = ui.select.mock.calls[1]; // 2nd select = Project submenu (after main)
    expect(projectCall[1]).toContain("Bot: proj-bot (default)");
  });

  it("Project → second item reflects connectionState", async () => {
    const bot = makeBot({ name: "state-bot", token: "t-s" });
    await addBot(bot);
    const expected: Record<TelegramConnectionState, string> = {
      "connected": "🟢 Connected → Disconnect",
      "connecting": "🔄 Connecting → Disconnect",
      "other-instance": "🟡 In use by another instance",
      "disconnected": "⚪ Disconnected → Connect",
    };
    for (const state of Object.keys(expected) as TelegramConnectionState[]) {
      connectionStateValue = state;
      const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back"] });
      await commands.get("tg")!("", makeCtx(ui));
      const options = ui.select.mock.calls[1][1] as string[];
      expect(options).toContain(expected[state]);
    }
  });

  it("Project → In use by another instance → click only notifies", async () => {
    const bot = makeBot({ name: "other-bot", token: "t-o" });
    await addBot(bot);
    connectionStateValue = "other-instance";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "🟡 In use by another instance", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("Another pi instance is serving this bot"))).toBe(true);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(awaitReconcileCalls).toBe(0);
  });

  it("Project → no usable bot → only the Bot item (no connection row)", async () => {
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[1][1] as string[];
    expect(options).toEqual(["Bot: not set", "⬅️ Back"]);
  });

  it("Project → a { enabled: false } disconnect record follows the default bot and offers no Unbind", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { enabled: false });
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "Bot: default-bot (default)", "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const bindCall = ui.select.mock.calls[2]; // bot picker after clicking the binding row
    expect(bindCall[0]).toBe("Bind project to bot");
    expect(bindCall[1]).not.toContain("Unbind");
  });

  it("Project → Bot → pick bot → writes .pi/telegram.json", async () => {
    const bot = makeBot({ name: "bind-bot", token: "t-b" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Bot: bind-bot (default)", botChoice, "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("Project bound to bot"))).toBe(true);
  });

  it("Project → ⚪ Disconnected → Connect re-enables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: false });
    connectionStateValue = "disconnected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "⚪ Disconnected → Connect", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("Telegram connected for this folder"))).toBe(true);
  });

  it("Project → 🟢 Connected → Disconnect confirms, disables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "🟢 Connected → Disconnect", "⬅️ Back"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.confirm).toHaveBeenCalledWith(
      "Disconnect Telegram for this folder?",
      "Telegram will stop responding. Reconnect only from the terminal with /tg.",
    );
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("Telegram disconnected for this folder"))).toBe(true);
  });

  it("Project → Disconnect → Yes ends the menu: no Project page is drawn after it", async () => {
    const bot = makeBot({ name: "dc", token: "t-dc" });
    await addBot(bot);
    connectionStateValue = "connected";
    const { ui, pages } = makeMenuUi(["📁 Project", "🟢 Connected → Disconnect"]);
    ui.confirm.mockResolvedValue(true);
    await commands.get("tg")!("", makeCtx(ui));

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(pages.map((page) => page.title)).toEqual(["Telegram Management", "📁 Project"]);
    expect(ui.closeMenu).toHaveBeenCalled();
  });

  it("Project → Disconnect confirm cancel does not disable", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "🟢 Connected → Disconnect", "⬅️ Back"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true); // unchanged
    expect(awaitReconcileCalls).toBe(0);
  });

  it("Project → Bot → Unbind → confirms and removes binding", async () => {
    const bot = makeBot({ name: "unbind-bot", token: "t-u" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "Bot: unbind-bot", "Unbind", "⬅️ Back"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding).toBeUndefined();
    expect(notifyCalls.some((c) => c.message.includes("Removed Telegram project binding"))).toBe(true);
  });

  it("Config → Message mode → switches to queue", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "📨 Message mode: steer", "  queue", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.messageMode).toBe("queue");
    expect(notifyCalls.some((c) => c.message === "📨 Message mode set to queue")).toBe(true);
  });

  it("Config → Tool → sets tool level", async () => {
    // Config menu → select "🔧 Tool: brief" → pickRenderLevel shows ["  hidden", "● brief", "  full"]
    // We pick "  full" (non-current = two-space prefix)
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔧 Tool: brief", "  full", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.tool).toBe("full");
    expect(notifyCalls.some((c) => c.message.includes("Tool") && c.message.includes("full"))).toBe(true);
  });

  it("Config → Thinking → sets thinking level", async () => {
    // pickRenderLevel shows ["  hidden", "● brief", "  full"] — we pick "  hidden"
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "💭 Thinking: brief", "  hidden", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.thinking).toBe("hidden");
    expect(notifyCalls.some((c) => c.message.includes("Thinking") && c.message.includes("hidden"))).toBe(true);
  });

  it("Config → Retry with an invalid value keeps the prompt open, explains why, then accepts a valid value", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔄 Retry: 3", "⬅️ Back"],
      input: ["abc", "7"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(ui.input.mock.calls[1][0]).toBe("Retry count (0-10)");
    // The reason is on the re-opened prompt itself: host prompts draw over the menu message,
    // so a notice before them would not stay visible.
    expect(ui.input.mock.calls[1][1]).toContain("Must be a number 0-10");
    expect(ui.input.mock.calls[1][1]).toContain("abc");
    expect(config.retryCount).toBe(7);
    expect(notifyCalls.filter((c) => c.message.startsWith("🔄 Retry count set to"))).toHaveLength(1);
  });

  it("Config → Retry → sets retry count", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔄 Retry: 3", "⬅️ Back"],
      input: ["7"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.retryCount).toBe(7);
    expect(notifyCalls.some((c) => c.message.includes("Retry") && c.message.includes("7"))).toBe(true);
  });

  it("Back navigation: Bots → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Project → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Config → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["⚙️ Config", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Bots → Bot list with no bots shows info message", async () => {
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Bots → Bot list → no bots → info", async () => {
    // With no bots, Bot list shows the info message instead of a picker.
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(4);
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Switch instance with no coordinator shows error", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🔄 Switch instance"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("not the active Telegram instance"))).toBe(true);
  });

  it("Pairing page (unpaired): shows pairing instructions, New pairing code swaps the code", async () => {
    const bot = makeBot({ name: "pairbot", pairingCode: "123456" });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "New pairing code", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4]; // 5th select = pairing page
    expect(pairingCall[0]).toBe("🔑 Pairing · pairbot");
    expect(pairingCall[1]).toEqual(["New pairing code", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("/pair 123456"))).toBe(true);
    const after = (await readBotRegistry()).bots[0];
    expect(after.pairingCode).toBe("654321");
    expect(notifyCalls.some((c) => c.message.includes("/pair 654321"))).toBe(true);
  });

  it("Pairing page: the paired state is the page body, not a separate notice (one menu edit)", async () => {
    const bot = makeBot({ name: "pairbot", allowedUserId: 42 });
    await addBot(bot);
    const { ui, notify, pages } = makeMenuUi(["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back"]);
    await commands.get("tg")!("", makeCtx(ui));
    const page = pages.find((p) => p.title === "🔑 Pairing · pairbot");
    expect(page?.options).toEqual(["Unpair", "⬅️ Back"]);
    expect(page?.body).toBe("Paired user: 42");
    expect(notify.mock.calls.some((c) => String(c[0]).includes("Paired user"))).toBe(false);
  });

  it("bot detail page: body lists name, username, API base, pairing and default, never the token", async () => {
    const bot = makeBot({ name: "detailbot", token: "123456:SECRET-TOKEN-XYZ", botUsername: "detail_bot" });
    await addBot(bot);
    const { ui, notify, pages } = makeMenuUi(["🤖 Bots", "Bot list", botChoiceFull(bot, true), "⬅️ Back", "⬅️ Back", "⬅️ Back"]);
    await commands.get("tg")!("", makeCtx(ui));
    const page = pages.find((p) => p.title === "🤖 detailbot");
    expect(page?.body).toBe([
      "Name: detailbot",
      "Username: @detail_bot",
      "API base: default",
      "Pairing: not paired",
      "Default bot: yes",
    ].join("\n"));
    expect(page?.body).not.toContain("SECRET-TOKEN-XYZ");
    expect(notify.mock.calls.some((c) => String(c[0]).includes("SECRET-TOKEN-XYZ"))).toBe(false);
  });

  it("Pairing page (paired): shows Paired user, Unpair confirms then clears allowedUserId with a new code", async () => {
    const bot = makeBot({ name: "pairbot", allowedUserId: 777 });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "Unpair", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4];
    expect(pairingCall[0]).toBe("🔑 Pairing · pairbot");
    expect(pairingCall[1]).toEqual(["Unpair", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("Paired user: 777"))).toBe(true);
    expect(ui.confirm).toHaveBeenCalledWith("Unpair?", expect.stringContaining("This chat will stop working"));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBeUndefined();
    expect(after.pairingCode).toBe("654321");
  });

  it("Pairing page: Unpair cancel keeps allowedUserId and the pairing code untouched", async () => {
    const bot = makeBot({ name: "keeppair", allowedUserId: 777, pairingCode: "111111" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "Unpair", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBe(777);
    expect(after.pairingCode).toBe("111111");
  });

  it("Default bot submenu lists bots with the ⭐ marker and Clear default last", async () => {
    const bot1 = makeBot({ name: "a", botUsername: "a_bot" });
    const bot2 = makeBot({ name: "b", allowedUserId: 42 });
    await addBot(bot1);
    await addBot(bot2);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ Default bot: a", "⬅️ Back", "⬅️ Back"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[2][0]).toBe("⭐ Default bot");
    expect(ui.select.mock.calls[2][1]).toEqual([
      botChoiceFull(bot1, true), botChoiceFull(bot2, false), "Clear default", "⬅️ Back",
    ]);
  });

  it("main menu ends with 🛠 Debug info and has no Close option", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options).toContain("🛠 Debug info");
    expect(options[options.length - 1]).toBe("🛠 Debug info");
  });

  it("Debug info reports the live session and returns to the main menu", async () => {
    menuSession = {
      sessionManager: { getEntries: () => [{}, {}, {}] },
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
    } as unknown as CapturedAgentSession;
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🛠 Debug info"] });
    await commands.get("tg")!("", makeCtx(ui, "/work/proj"));
    const report = notifyCalls.find((c) => c.message.startsWith("Plugin debug info"));
    expect(report).toBeDefined();
    expect(report?.message).toContain("model: anthropic/claude-x");
    expect(report?.message).toContain("entries: 3");
    // After the report the menu returns to the main list, then a cancel exits.
    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  it("Debug info with no active session notifies an error and stays in the menu", async () => {
    menuSession = undefined;
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🛠 Debug info"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message === "No active session" && c.level === "error")).toBe(true);
    expect(notifyCalls.some((c) => c.message.startsWith("Plugin debug info"))).toBe(false);
    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  it("cancelling the Config submenu closes the whole menu", async () => {
    // main → Config → cancel (undefined): the main menu is not shown again.
    const { ui } = makeScriptedUi({ select: ["⚙️ Config"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(2);
    expect(ui.select.mock.calls[0][0]).toBe("Telegram Management");
    expect(ui.select.mock.calls[1][0]).toBe("⚙️ Telegram Config");
  });

  it("cancelling a nested submenu closes the whole menu", async () => {
    // main → Bots → Bot list → cancel: neither Bots nor main re-renders.
    await addBot(makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" }));
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "Bot list"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(ui.select.mock.calls[2][0]).toBe("Bot list");
  });

  it("Back in the Config submenu returns to the main menu", async () => {
    const { ui } = makeScriptedUi({ select: ["⚙️ Config", "⬅️ Back"] });
    await commands.get("tg")!("", makeCtx(ui));
    // main, Config, main again (then the script ends and cancels the main menu).
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(ui.select.mock.calls[2][0]).toBe("Telegram Management");
  });

  it("cancelling the Tool value picker closes the whole menu", async () => {
    // main → Config → Tool → picker cancelled: Config does not re-render.
    const { ui } = makeScriptedUi({ select: ["⚙️ Config", "🔧 Tool: brief"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(ui.select.mock.calls[2][0]).toBe("🔧 Tool rendering");
  });

  it("cancelling an input inside Add bot closes the whole menu", async () => {
    // main → Bots → Add bot → name input cancelled: Bots does not re-render.
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "➕ Add bot"], input: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  it("answering No in the Remove confirm returns to the bot detail, not the menu root", async () => {
    const bot = makeBot({ name: "keep", token: "t-k" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Remove", "⬅️ Back", "⬅️ Back", "⬅️ Back"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[4][0]).toBe("🤖 keep");
  });
});

describe("configModeFlow", () => {
  function makeDeps(initial: TelegramConfig) {
    let current = initial;
    const setConfig = vi.fn((c: TelegramConfig) => { current = c; });
    const persistConfig = vi.fn(async (c: TelegramConfig) => { current = c; });
    const deps = { getConfig: () => current, setConfig, persistConfig } as unknown as TgConfigDeps;
    return { deps, setConfig, persistConfig, get current() { return current; } };
  }

  it("persists the selected mode and reports it", async () => {
    const d = makeDeps({});
    const ui = { notify: vi.fn(), select: vi.fn(async () => "  queue"), input: vi.fn(), confirm: vi.fn() };
    await configModeFlow(ui, d.deps);
    expect(d.setConfig).toHaveBeenCalledWith(expect.objectContaining({ messageMode: "queue" }));
    expect(d.persistConfig).toHaveBeenCalledWith(expect.objectContaining({ messageMode: "queue" }));
    expect(ui.notify).toHaveBeenCalledWith("📨 Message mode set to queue", "info");
  });

  it("accepts a direct value and rejects an invalid one", async () => {
    const d = makeDeps({});
    const ui = { notify: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn() };
    await configModeFlow(ui, d.deps, "main");
    expect(d.persistConfig).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Invalid. Use: steer or queue", "error");
    await configModeFlow(ui, d.deps, "steer");
    expect(d.persistConfig).toHaveBeenCalledWith(expect.objectContaining({ messageMode: "steer" }));
  });
});

describe("buildConfigMenuOptions", () => {
  const thinkingSession = {
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    thinkingLevel: "low",
  } as unknown as CapturedAgentSession;

  it("hides the 🧠 thinking-level entry on pi (native /thinking already covers it)", () => {
    const options = buildConfigMenuOptions({}, thinkingSession, "pi");
    expect(options.some((o) => o.startsWith("🧠 Thinking level:"))).toBe(false);
    // The rest of the Config menu is unchanged on pi.
    expect(options).toContain("💭 Thinking: brief");
    expect(options.at(-1)).toBe("⬅️ Back");
  });

  it("shows the message mode (default steer) before shell confirm", () => {
    const options = buildConfigMenuOptions({}, undefined, "omp");
    const modeIndex = options.indexOf("📨 Message mode: steer");
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeLessThan(options.indexOf("🐚 Shell confirm: dangerous"));
    expect(buildConfigMenuOptions({ messageMode: "queue" }, undefined, "omp")).toContain("📨 Message mode: queue");
  });

  it("keeps the 🧠 thinking-level entry on omp", () => {
    const options = buildConfigMenuOptions({}, thinkingSession, "omp");
    expect(options).toContain("🧠 Thinking level: low");
  });
});

describe("leaf flows called outside /tg", () => {
  it("a cancelled tool picker returns without throwing and changes nothing", async () => {
    const persistConfig = vi.fn(async () => undefined);
    const deps = { getConfig: () => ({}) as TelegramConfig, setConfig: vi.fn(), persistConfig } as unknown as TgConfigDeps;
    const ui = { notify: vi.fn(), select: vi.fn(async () => undefined), input: vi.fn(), confirm: vi.fn() };
    await expect(configToolFlow(ui, deps)).resolves.toBeUndefined();
    expect(persistConfig).not.toHaveBeenCalled();
  });
});

describe("Switch instance choice labels", () => {
  const STAMP = "2026-11-03T00:00:00.000Z";
  const inst = (id: string, cwd: string, sessionId: string, model = "mock/mock-model") => ({
    id, pid: 1, startedAt: STAMP, heartbeatAt: STAMP, cwd, sessionId, model,
  });

  it("names each instance by project and model, marking the active one", () => {
    const labels = formatInstanceChoices([
      inst("01a19d1c-0000-4000-8000-000000000001", "/tmp/pitg-human/project", "4d10a8a9-0000-4000-8000-000000000001"),
      inst("01a19d1c-0000-4000-8000-000000000002", "/tmp/pitg-human/project2", "9e2f0b7c-0000-4000-8000-000000000002"),
    ], "01a19d1c-0000-4000-8000-000000000001");
    expect(labels).toEqual(["✓ project · mock/mock-model", "  project2 · mock/mock-model"]);
    for (const label of labels) expect(label).not.toMatch(/[0-9a-f]{8}.*[0-9a-f]{8}/);
  });

  it("adds the session id prefix only when two instances share a project name", () => {
    const labels = formatInstanceChoices([
      inst("01a19d1c-0000-4000-8000-000000000001", "/tmp/a/app", "4d10a8a9-0000-4000-8000-000000000001"),
      inst("01a19d1c-0000-4000-8000-000000000002", "/tmp/b/app", "9e2f0b7c-0000-4000-8000-000000000002"),
    ], "01a19d1c-0000-4000-8000-000000000002");
    expect(labels).toEqual([
      "  app · mock/mock-model · 4d10a8a9",
      "✓ app · mock/mock-model · 9e2f0b7c",
    ]);
  });
});

describe("Switch instance hands the menu message to the new active instance", () => {
  const STAMP = "2026-11-03T00:00:00.000Z";

  it("passes the live menu message id with the switch and ends the menu without another page", async () => {
    const instances = [
      { id: "inst-a", pid: 1, startedAt: STAMP, heartbeatAt: STAMP, cwd: "/tmp/p/project", model: "mock/mock-model" },
      { id: "inst-b", pid: 2, startedAt: STAMP, heartbeatAt: STAMP, cwd: "/tmp/p/project2", model: "mock/mock-model" },
    ];
    const switchTo = vi.fn(async () => ({}));
    const coordinator = {
      isActive: () => true,
      listInstances: async () => instances,
      getActive: () => ({ instanceId: "inst-a", generation: 1 }),
      switchTo,
    };
    const switchDeps = {
      getCoordinator: () => coordinator,
      getCurrentChatId: () => 42,
      stopPolling: async () => undefined,
      startPolling: () => undefined,
      requestReconcile: () => undefined,
      getCurrentTurn: () => undefined,
      pendingHandoffs: new Set<string>(),
    } as unknown as SwitchInstanceDeps;
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    registerTgMenuCommand(
      { registerCommand: (name, options) => { commands.set(name, options.handler); } },
      {} as any,
      {} as any,
      switchDeps,
    );

    const choices = formatInstanceChoices(instances, "inst-a");
    const { ui, pages } = makeMenuUi(["🔄 Switch instance", choices[1]]);
    (ui as unknown as { menuMessageId: () => number }).menuMessageId = () => 555;
    await commands.get("tg")!("", { cwd: "/tmp", ui });

    expect(switchTo).toHaveBeenCalledWith(
      "inst-b",
      expect.objectContaining({ chatId: 42, menuMessageId: 555 }),
      { instanceId: "inst-a", generation: 1 },
    );
    // Main menu, then the instance picker; the switch result is the menu message, so no page follows.
    expect(pages.map((page) => page.title)).toEqual(["Telegram Management", expect.stringContaining("Switch Telegram")]);
    expect(ui.closeMenu).toHaveBeenCalled();
  });
});
