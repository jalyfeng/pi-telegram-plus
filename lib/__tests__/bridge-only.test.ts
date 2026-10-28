import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBot, resolveTelegramConfig } from "../config.ts";
import type { BotRecord } from "../types.ts";
import { createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

// v6 (decision 48): the host bridge is the only path. These tests pin the two
// behaviors that replace the removed `tuiBridge` config item.

describe("legacy tuiBridge key is ignored", () => {
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

  it("drops tuiBridge from an old project binding without failing the read", async () => {
    const bot: BotRecord = { id: "b1", name: "test-bot", token: "tok-1" };
    await addBot(bot);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "telegram.json"),
      JSON.stringify({ botId: bot.id, tuiBridge: "commands", tool: "brief" }),
      "utf8",
    );

    const result = await resolveTelegramConfig(projectDir);
    expect(result.hasProjectBinding).toBe(true);
    expect(result.config.tool).toBe("brief");
    expect("tuiBridge" in result.config).toBe(false);
  });
});

describe("bridge unavailable answers host traffic with the fixed notice", () => {
  const OUTAGE_TEXT = "The host bridge is unavailable (pi), so the plugin cannot work. Run pi/OMP interactively in a terminal.";

  function createHarness(options: {
    bridge: TuiBridgeAdapter;
    telegramCommands?: Map<string, any>;
  }) {
    const sent: Array<{ chatId: number; text: string }> = [];
    const transport = {
      sendText: vi.fn(async (chatId: number, text: string) => {
        sent.push({ chatId, text });
        return [{ message_id: sent.length }];
      }),
      editText: vi.fn(async () => [{ message_id: 1 }]),
      editButtons: vi.fn(async () => [{ message_id: 1 }]),
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    } as unknown as TelegramTransport;
    const session = {
      extensionRunner: {
        getUIContext: () => ({}),
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({}),
      },
      prompt: vi.fn(async () => undefined),
    } as unknown as CapturedAgentSession;
    const tgHandler = vi.fn(async () => undefined);
    const controller = createTelegramController({
      getSession: () => session,
      transport,
      ui: {
        create: () => ({ notify: async () => undefined, confirm: vi.fn(async () => true) }) as never,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test-bot",
      telegramCommands: options.telegramCommands ?? new Map([["tg", tgHandler]]),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, replaceMessageId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
      getConfig: () => ({ bashConfirm: "dangerous", activeChatId: 42 }),
      tuiBridge: options.bridge,
    });
    return { controller, sent, session, tgHandler };
  }

  function createDownBridge(overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter {
    return {
      ready: async () => undefined,
      isAvailable: () => false,
      getHost: () => "pi" as const,
      getCommands: async () => [],
      submit: vi.fn(() => false),
      key: () => false,
      write: () => false,
      isEditorFocused: () => false,
      isInteractiveFocus: () => false,
      ...overrides,
    } as unknown as TuiBridgeAdapter;
  }

  it("answers a host command with the outage notice instead of running it", async () => {
    const submit = vi.fn(() => true);
    const harness = createHarness({
      bridge: createDownBridge({
        submit,
        // Even a host catalog that serves the command must not be reached.
        getCommands: async () => [{ name: "model", description: "Pick a model", source: "builtin" as const }],
      }),
    });

    await harness.controller.runCommand("model", "", 42);

    expect(submit).not.toHaveBeenCalled();
    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.sent.some((m) => m.text === OUTAGE_TEXT)).toBe(true);
  });

  it("answers a plain prompt with the outage notice and does not submit it", async () => {
    const harness = createHarness({ bridge: createDownBridge() });

    await harness.controller.handleMessage({
      message_id: 7,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.sent.some((m) => m.text === OUTAGE_TEXT)).toBe(true);
  });

  it("keeps plugin-owned commands available while the bridge is down", async () => {
    const harness = createHarness({ bridge: createDownBridge() });

    await harness.controller.handleMessage({
      message_id: 8,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/tg",
    });

    await vi.waitFor(() => expect(harness.tgHandler).toHaveBeenCalled());
    expect(harness.sent.some((m) => m.text === OUTAGE_TEXT)).toBe(false);
  });
});
