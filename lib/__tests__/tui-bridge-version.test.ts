import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

// §0.1 version gate: the bridge reads both host versions at install time and
// refuses to patch anything when the running host is not the one supported.
// Host modules are doMock-backed per case (vitest snapshots external-package
// mock namespaces once per file, so versions cannot ride a shared getter);
// the created InteractiveMode classes land in `holders` so the test asserts on
// the very classes the freshly imported bridge saw.

type HostClass = { prototype: Record<string, { __ptpBridgePatched?: boolean }> };

const holders = vi.hoisted(() => ({
  pi: null as HostClass | null,
  omp: null as HostClass | null,
}));

const SHARED_STATE_KEY = "__piTelegramPlusTuiBridgeState";

function mockHosts(opts: { piVersion?: string; ompVersion?: string }): void {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>)[SHARED_STATE_KEY];
  holders.pi = null;
  holders.omp = null;
  vi.doMock("@earendil-works/pi-coding-agent", () => {
    const cls = class InteractiveMode {
      setupEditorSubmitHandler() {}
      init() {}
      run() {}
    };
    holders.pi = cls as unknown as HostClass;
    return { VERSION: opts.piVersion, InteractiveMode: cls };
  });
  vi.doMock("@oh-my-pi/pi-utils", () => ({ VERSION: opts.ompVersion }));
  vi.doMock("@oh-my-pi/pi-coding-agent/modes/interactive-mode", () => {
    const cls = class InteractiveMode {
      initHooksAndCustomTools() {}
      render() {}
    };
    holders.omp = cls as unknown as HostClass;
    return { InteractiveMode: cls };
  });
}

async function installFresh() {
  const mod = await import("../tui-bridge.ts");
  await mod.installTuiBridge();
  return mod;
}

function patched(cls: HostClass | null, method: string): boolean {
  return cls?.prototype[method]?.__ptpBridgePatched === true;
}

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>)[SHARED_STATE_KEY];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SHARED_STATE_KEY];
});

describe("installTuiBridge version gate", () => {
  it("patches the pi entry points on the supported pi version", async () => {
    mockHosts({ piVersion: "1.4.0" });
    const mod = await installFresh();
    expect(mod.tuiBridge.getUnsupportedReason()).toBeUndefined();
    expect(patched(holders.pi, "setupEditorSubmitHandler")).toBe(true);
    expect(patched(holders.pi, "init")).toBe(true);
  });

  it("refuses an unsupported pi version and installs no patches", async () => {
    mockHosts({ piVersion: "1.3.0" });
    const mod = await installFresh();
    const reason = mod.tuiBridge.getUnsupportedReason();
    expect(reason).toContain("1.3.0");
    expect(reason).toContain("1.4.0");
    expect(patched(holders.pi, "setupEditorSubmitHandler")).toBe(false);
    expect(patched(holders.pi, "init")).toBe(false);
    expect(patched(holders.pi, "run")).toBe(false);
  });

  it("patches the OMP entry points on a supported OMP version", async () => {
    mockHosts({ piVersion: "1.4.0", ompVersion: "18.12.5" });
    const mod = await installFresh();
    expect(mod.tuiBridge.getUnsupportedReason()).toBeUndefined();
    expect(patched(holders.omp, "render")).toBe(true);
    expect(patched(holders.omp, "initHooksAndCustomTools")).toBe(true);
  });

  it("refuses an OMP version outside the supported range", async () => {
    mockHosts({ piVersion: "1.4.0", ompVersion: "18.13.0" });
    const mod = await installFresh();
    const reason = mod.tuiBridge.getUnsupportedReason();
    expect(reason).toContain("18.12.x");
    expect(reason).toContain("18.13.0");
    expect(patched(holders.omp, "render")).toBe(false);
    expect(patched(holders.pi, "init")).toBe(false);
  });

  it("refuses when no host version can be read", async () => {
    mockHosts({});
    const mod = await installFresh();
    const reason = mod.tuiBridge.getUnsupportedReason();
    expect(reason).toContain("unknown");
    expect(patched(holders.pi, "init")).toBe(false);
  });
});

describe("controller sends the version refusal instead of the generic outage notice", () => {
  const REASON = "Unsupported pi version 1.3.0; requires 1.4.0";
  const GENERIC_TEXT = "The host bridge is unavailable (pi), so the plugin cannot work. Run pi/OMP interactively in a terminal.";

  function createDownBridge(overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter {
    return {
      ready: async () => undefined,
      isAvailable: () => false,
      getHost: () => "pi" as const,
      getCommands: async () => [],
      submit: () => false,
      key: () => false,
      write: () => false,
      isEditorFocused: () => false,
      isInteractiveFocus: () => false,
      ...overrides,
    } as unknown as TuiBridgeAdapter;
  }

  function createHarness(bridge: TuiBridgeAdapter) {
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
      telegramCommands: new Map(),
      getActiveTurn: () => undefined,
      beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, replaceMessageId, queuedAttachments: [] }),
      endTelegramTurn: () => undefined,
      getConfig: () => ({ bashConfirm: "dangerous", activeChatId: 42 }),
      tuiBridge: bridge,
    });
    return { controller, sent, session };
  }

  it("answers a plain prompt with the version reason when the gate refused", async () => {
    const { controller, sent, session } = createHarness(createDownBridge({ getUnsupportedReason: () => REASON }));

    await controller.handleMessage({
      message_id: 7,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(sent.some((m) => m.text === `${REASON}. The plugin has stopped.`)).toBe(true);
  });

  it("does not double the period when the reason already ends with one", async () => {
    const { controller, sent } = createHarness(createDownBridge({ getUnsupportedReason: () => `${REASON}.` }));

    await controller.handleMessage({
      message_id: 9,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    expect(sent.some((m) => m.text === `${REASON}. The plugin has stopped.`)).toBe(true);
    expect(sent.some((m) => m.text.includes(".."))).toBe(false);
  });

  it("keeps the generic outage notice when no version reason is set", async () => {
    const { controller, sent } = createHarness(createDownBridge());

    await controller.handleMessage({
      message_id: 8,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    expect(sent.some((m) => m.text === GENERIC_TEXT)).toBe(true);
    expect(sent.some((m) => m.text.includes("The plugin has stopped"))).toBe(false);
  });
});
