import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import {
  buildTelegramMenuCommands,
  buildTelegramMenuCommandsFull,
  getTelegramMenuOverflow,
  scheduleTelegramCommandRefresh,
  syncTelegramCommands,
} from "../menu-commands.ts";
import type * as tuiBridgeModule from "../tui-bridge.ts";
import { registerAllCommands } from "../commands/register.ts";
import { getTelegramCommandDescriptions } from "../telegram-command-descriptions.ts";

// v6: the host bridge is the only path for host commands - run these with the bridge up.
vi.mock("../tui-bridge.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof tuiBridgeModule>();
  return { ...mod, tuiBridge: { ...mod.tuiBridge, isAvailable: () => true, getHost: () => "pi" as const } };
});

const hostCommand = (name: string, description: string): SlashCommandInfo => ({
  name,
  description,
  source: "extension",
  sourceInfo: { path: `/test/${name}.ts`, source: "test", scope: "user", origin: "top-level" },
});

describe("Telegram command menu", () => {
    it("exposes /tg as the consolidated management menu command", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [],
        } as any, { pluginDescriptions: new Map([["tg", "Open the Telegram management menu"]]) });

        expect(commands).toContainEqual({
            command: "tg",
            description: "Open the Telegram management menu",
        });
    });

    it("answers removed flat tg-* commands with the /tg hint instead of forwarding", async () => {
        const sent: Array<{ chatId: number; text: string }> = [];
        const transport = {
            sendText: async (chatId: number, text: string) => { sent.push({ chatId, text }); return 1; },
        } as unknown as TelegramTransport;
        let currentUi: unknown;
        const session = {
            extensionRunner: {
                getUIContext: () => currentUi,
                setUIContext: (ui: unknown) => { currentUi = ui; },
                getCommand: () => undefined,
                createCommandContext: () => ({}),
            },
        } as unknown as CapturedAgentSession;
        const controller = createTelegramController({
            getSession: () => session,
            transport,
            ui: {
                create: () => ({}) as never,
                resolveInput: () => ({ handled: false }),
                isSensitiveInput: () => false,
                hasPendingInput: () => false,
                dispose: () => undefined,
            },
            authorizeUser: async () => true,
            setActiveChatId: async () => undefined,
            getBotUsername: () => "test_bot",
            telegramCommands: new Map(),
            getActiveTurn: () => undefined,
            beginTelegramTurn: () => undefined,
            endTelegramTurn: () => undefined,
        });

        await controller.handleMessage({
            message_id: 1,
            chat: { id: 42 },
            from: { id: 7 },
            text: "/tg-bot-add",
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]?.chatId).toBe(42);
        expect(sent[0]?.text).toContain("Unknown command. Use /tg");
    });
});

describe("dynamic TUI catalog in BotMenu", () => {
  it("merges host builtins that are absent from the static list", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [
          { name: "tools", description: "Manage tools", source: "builtin" },
          { name: "theme", description: "Change theme", source: "builtin" },
        ],
      },
    );
    expect(commands).toContainEqual({ command: "tools", description: "Manage tools" });
    expect(commands).toContainEqual({ command: "theme", description: "Change theme" });
  });

  it("reserves the last menu slot for /more when the catalog exceeds 100", () => {
    const tuiCommands = Array.from({ length: 140 }, (_, index) => ({
      name: `cmd_${index}`,
      description: `Command ${index}`,
      source: "builtin" as const,
    }));
    const { commands, overflow } = buildTelegramMenuCommandsFull({ getCommands: () => [] }, { tuiCommands });
    expect(commands).toHaveLength(100);
    expect(commands[99]).toEqual({ command: "more", description: "Show more commands" });
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow.some((c) => c.command === "more")).toBe(false);
  });

  it("has no /more entry or overflow when the catalog fits", () => {
    const { commands, overflow } = buildTelegramMenuCommandsFull({ getCommands: () => [] }, {});
    expect(commands.some((c) => c.command === "more")).toBe(false);
    expect(overflow).toHaveLength(0);
  });

  it("omits the thinking entry when the host has no native thinking command", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [hostCommand("model", "Change model")] },
      { tuiCommands: [{ name: "tools", description: "Manage tools", source: "builtin" }] },
    );
    expect(commands.some((c) => c.command === "thinking")).toBe(false);
    expect(commands.some((c) => c.command === "tg_thinking")).toBe(false);
  });

  it("keeps native thinking in the menu when the host provides it", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [hostCommand("thinking", "Change thinking level")] },
    );
    expect(commands.some((c) => c.command === "thinking")).toBe(true);
    expect(commands.some((c) => c.command === "tg_thinking")).toBe(false);
  });

  it("drops static entries the captured host catalog does not serve", () => {
    const ompCommand = (name: string) => ({ name, description: `omp ${name}`, source: "builtin" as const });
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [
          ompCommand("settings"), ompCommand("model"), ompCommand("session"),
          ompCommand("fork"), ompCommand("compact"), ompCommand("export"),
        ],
      },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("clone")).toBe(false);
    expect(names.has("import")).toBe(false);
    expect(names.has("name")).toBe(false);
    expect(names.has("reload")).toBe(false);
    expect(names.has("settings")).toBe(true);
    expect(names.has("model")).toBe(true);
    // scoped-models has no TUI on OMP: it is not menu-visible there either.
    expect(names.has("scoped_models")).toBe(false);
  });

  it("prefers the live host description over the static copy", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [
          { name: "model", description: "Select model (opens selector UI)", source: "builtin" as const },
          { name: "quit", description: "Quit pi", source: "builtin" as const },
        ],
        pluginDescriptions: new Map([["tg", "Open the Telegram management menu"]]),
      },
    );
    expect(commands.find((c) => c.command === "model")?.description).toBe("Select model (opens selector UI)");
    expect(commands.find((c) => c.command === "quit")?.description).toBe("Quit pi");
    // A plugin-served entry the catalog does not describe keeps the plugin's own wording.
    expect(commands.find((c) => c.command === "tg")?.description).toBe("Open the Telegram management menu");
  });

  it("offers every command the plugin serves, as the /tg Commands list does (#54)", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [{ name: "settings", description: "Open settings", source: "builtin" }],
        pluginDescriptions: new Map([
          ["import", "Import a session JSONL file (path on server)"],
          ["reload", "Reload extensions, skills, prompts, and themes"],
        ]),
      },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("import")).toBe(true);
    expect(names.has("reload")).toBe(true);
  });

  it("keeps plugin-served commands even when the host catalog lacks them", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      { tuiCommands: [{ name: "settings", description: "Open settings", source: "builtin" }] },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("tg")).toBe(true);
    expect(names.has("cwd")).toBe(true);
    expect(names.has("status")).toBe(true);
    // /debug was given back to the host: it is no longer a plugin-served
    // command, so it drops out unless the captured host catalog serves it.
    expect(names.has("debug")).toBe(false);
  });

  it("keeps the curated static list when no host catalog was captured", () => {
    const commands = buildTelegramMenuCommands({ getCommands: () => [] }, {});
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("clone")).toBe(true);
    expect(names.has("reload")).toBe(true);
    expect(names.has("trust")).toBe(true);
    // thinking has no owner without a host that provides it: never static.
    expect(names.has("thinking")).toBe(false);
  });
});

describe("dynamic command ordering", () => {
  it("boosts recently used non-core commands ahead of other dynamic commands", () => {
    const commands = buildTelegramMenuCommands(
      {
        getCommands: () => [
          { name: "alpha", description: "Alpha" },
          { name: "middle", description: "Middle" },
          { name: "zulu", description: "Zulu" },
        ],
      } as any,
      { recent: ["middle"] },
    );
    const names = commands.map((command) => command.command);
    expect(names.indexOf("middle")).toBeLessThan(names.indexOf("alpha"));
  });
});

describe("recent commands in BotMenu", () => {
  it("leaves a recent command the host catalog does not have out of the menu", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        recent: ["scoped-models"],
        tuiCommands: [{ name: "settings", description: "Open settings", source: "builtin" }],
      },
    );
    expect(commands.some((c) => c.command === "scoped_models")).toBe(false);
  });

  it("keeps a recent command the host catalog has, ordered by recent use", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        recent: ["zulu", "middle"],
        tuiCommands: [
          { name: "alpha", description: "Alpha", source: "builtin" },
          { name: "middle", description: "Middle", source: "builtin" },
          { name: "zulu", description: "Zulu", source: "builtin" },
        ],
      },
    );
    const names = commands.map((c) => c.command);
    expect(names).toContain("zulu");
    expect(names).toContain("middle");
    expect(names.indexOf("zulu")).toBeLessThan(names.indexOf("middle"));
    expect(names.indexOf("middle")).toBeLessThan(names.indexOf("alpha"));
  });

  it("keeps a recent plugin-served command even when the host catalog lacks it", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        recent: ["stop"],
        tuiCommands: [{ name: "settings", description: "Open settings", source: "builtin" }],
      },
    );
    expect(commands.some((c) => c.command === "stop")).toBe(true);
  });
});

describe("Telegram menu refresh scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("isolates in-flight sync by token and API base", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pi = { getCommands: () => [] } as any;

    await Promise.all([
      syncTelegramCommands("token-a", pi, "https://api-a.example"),
      syncTelegramCommands("token-b", pi, "https://api-b.example"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("api-a.example"),
      expect.stringContaining("api-b.example"),
    ]));
  });

  it("keeps the 300ms and 1000ms refreshes independently scheduled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pi = { getCommands: () => [] } as any;

    scheduleTelegramCommandRefresh("token-dual-delay", pi, "https://api.example", 300);
    scheduleTelegramCommandRefresh("token-dual-delay", pi, "https://api.example", 1000);
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("/more overflow keyboard", () => {
  const overflowPi = {
    getCommands: () => Array.from({ length: 140 }, (_, index) => ({
      name: `cmd_${index}`,
      description: `Command ${index}`,
      source: "extension" as const,
    })),
  } as any;

  it("sends the overflow keyboard on /more and dispatches run callbacks", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await syncTelegramCommands("token-more-flow", overflowPi, "https://api.example");
    } finally {
      vi.unstubAllGlobals();
    }
    const overflow = getTelegramMenuOverflow("token-more-flow", "https://api.example");
    expect(overflow.length).toBeGreaterThan(0);

    const handler = vi.fn(async () => undefined);
    let extensionCommandName = "";
    const telegramCommands = new Map<string, any>();
    const transport = {
      sendButtons: vi.fn(async () => ({ message_id: 5 })),
      editButtons: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [{ message_id: 6 }]),
      answerCallbackQuery: vi.fn(async () => undefined),
    };
    let currentUi: unknown = {};
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown) => { currentUi = ui; },
        getCommand: (name: string) => (name === extensionCommandName ? { handler } : undefined),
        createCommandContext: () => ({}),
      },
    } as any;
    const controller = createTelegramController({
      getSession: () => session,
      transport: transport as any,
      ui: {
        create: () => ({}) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test_bot",
      telegramCommands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: () => undefined,
      endTelegramTurn: () => undefined,
      getConfig: () => ({ botToken: "token-more-flow", apiBase: "https://api.example" }) as any,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 42 }, from: { id: 7 }, text: "/more" });
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    const rows = (transport.sendButtons.mock.calls[0] as unknown as unknown[])[2] as Array<Array<{ text: string; value: string }>>;
    const commandButtons = rows.flat().filter((button) => button.value.startsWith("tgplus:run:"));
    expect(commandButtons.length).toBe(Math.min(30, overflow.length));
    const target = commandButtons[0]!;
    const runName = target.value.slice("tgplus:run:".length);
    expect(target.text).toBe(`/${runName}`);

    extensionCommandName = runName;
    await controller.handleCallbackQuery({
      id: "q1",
      from: { id: 7 },
      message: { chat: { id: 42 }, message_id: 5 },
      data: target.value,
    } as any);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });
});

describe("terminal-only commands in BotMenu", () => {
  const terminalOnly = ["local", "dump", "open", "stats", "trace", "record", "live", "git", "tree", "copy", "mcp", "context"];
  const hostCatalog = (names: string[]) => names.map((name) => ({ name, description: `host ${name}`, source: "builtin" as const }));

  it("does not list /tree or /copy in the curated menu when no host catalog is captured", () => {
    const { commands, overflow } = buildTelegramMenuCommandsFull({ getCommands: () => [] }, { host: "pi" });
    const names = new Set([...commands, ...overflow].map((c) => c.command));
    expect(names.has("tree")).toBe(false);
    expect(names.has("copy")).toBe(false);
  });

  it("keeps terminal-only commands and OMP /cd out of the menu on OMP, but keeps /move", () => {
    const { commands, overflow } = buildTelegramMenuCommandsFull(
      { getCommands: () => [] },
      { host: "omp", tuiCommands: hostCatalog([...terminalOnly, "move", "cd", "tools"]) },
    );
    const names = new Set([...commands, ...overflow].map((c) => c.command));
    for (const name of [...terminalOnly, "cd"]) expect(names.has(name)).toBe(false);
    expect(names.has("move")).toBe(true);
    expect(names.has("tools")).toBe(true);
  });

  it("keeps /cd in the menu on pi, but still hides terminal-only commands", () => {
    const { commands } = buildTelegramMenuCommandsFull(
      { getCommands: () => [] },
      { host: "pi", tuiCommands: hostCatalog([...terminalOnly, "tools"]) },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("cd")).toBe(true);
    for (const name of terminalOnly) expect(names.has(name)).toBe(false);
  });

  it("hides terminal-only entries from recent usage too", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      { host: "pi", recent: ["open", "tools"] },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("open")).toBe(false);
    expect(names.has("tools")).toBe(true);
  });
});

describe("menu descriptions come from the source that owns them", () => {
  it("never shows a host source tag for an extension command", () => {
    const { commands } = buildTelegramMenuCommandsFull(
      { getCommands: () => [hostCommand("foo", "Do foo")] as any },
      {
        host: "pi",
        tuiCommands: [{ name: "foo", description: "[t] Do foo", source: "autocomplete" }],
      },
    );
    expect(commands.find((c) => c.command === "foo")?.description).toBe("Do foo");
  });

  it("keeps the plugin's own command description free of the tag", () => {
    const { commands } = buildTelegramMenuCommandsFull(
      { getCommands: () => [hostCommand("cwd", "Show current working directory")] as any },
      {
        host: "pi",
        tuiCommands: [{ name: "cwd", description: "[t] Show current working directory", source: "autocomplete" }],
      },
    );
    expect(commands.find((c) => c.command === "cwd")?.description).toBe("Show current working directory");
  });

  it("uses the plugin's registered description for a command it serves on Telegram", () => {
    const { commands } = buildTelegramMenuCommandsFull(
      { getCommands: () => [] },
      {
        host: "pi",
        tuiCommands: [{ name: "hotkeys", description: "Show keyboard shortcuts", source: "autocomplete" }],
        pluginDescriptions: new Map([["hotkeys", "How to use pi from Telegram"]]),
      },
    );
    expect(commands.find((c) => c.command === "hotkeys")?.description).toBe("How to use pi from Telegram");
  });

  it("records the descriptions registered by the command modules and the menu uses them", () => {
    const registered = new Map<string, { description?: string }>();
    registerAllCommands(
      { registerCommand: (name, options) => { registered.set(name, options); } },
      { getSession: () => undefined },
    );
    const { commands } = buildTelegramMenuCommandsFull(
      { getCommands: () => [] },
      {
        host: "pi",
        tuiCommands: [{ name: "hotkeys", description: "Show keyboard shortcuts", source: "autocomplete" }],
        pluginDescriptions: getTelegramCommandDescriptions(),
      },
    );
    expect(registered.get("hotkeys")?.description).toBe("How to use pi from Telegram");
    expect(commands.find((c) => c.command === "hotkeys")?.description).toBe("How to use pi from Telegram");
  });
});
