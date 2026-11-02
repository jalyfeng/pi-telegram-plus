import { afterEach, describe, expect, it, vi } from "vitest";
import { isOmpHost } from "../session-capture.ts";
import { registerLifecycleCommands } from "../commands/lifecycle.ts";
import type { CommandRegistry } from "../commands/register.ts";
import { runWithTelegramTurn } from "../turn-context.ts";
import { takePendingNotices, type PendingNotice } from "../pending-notices.ts";

vi.mock("../session-capture.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../session-capture.ts")>();
  return { ...mod, isOmpHost: vi.fn(() => false) };
});

type HandlerEntry = {
  name: string;
  description?: string;
  handler: (args: string, ctx: {
    ui: { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
    shutdown: ReturnType<typeof vi.fn>;
  }) => Promise<void>;
};

function makeRegistry(): { registry: CommandRegistry; handlers: Map<string, HandlerEntry> } {
  const handlers = new Map<string, HandlerEntry>();
  return {
    handlers,
    registry: {
      registerCommand: (name, options) => {
        handlers.set(name, {
          name,
          description: options.description,
          handler: options.handler as HandlerEntry["handler"],
        });
      },
    },
  };
}

function makeCtx(confirmResult: boolean) {
  const confirm = vi.fn(async () => confirmResult);
  const notify = vi.fn();
  const shutdown = vi.fn();
  return { ctx: { ui: { confirm, notify }, shutdown }, confirm, notify, shutdown };
}

describe("registerLifecycleCommands /quit and /exit", () => {
  it("registers both names with the shutdown description", () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);

    expect(handlers.get("quit")?.description).toBe("Shut down the host after confirmation");
    expect(handlers.get("exit")?.description).toBe("Shut down the host after confirmation");
  });

  for (const name of ["quit", "exit"] as const) {
    it(`/${name} shuts down after the confirmation`, async () => {
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry);
      const { ctx, confirm, shutdown } = makeCtx(true);

      await handlers.get(name)!.handler("", ctx);

      expect(confirm).toHaveBeenCalledWith("Quit pi?", "pi will exit and Telegram will stop responding.");
      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it(`/${name} names the host omp in its confirmation on OMP`, async () => {
      vi.mocked(isOmpHost).mockReturnValueOnce(true);
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry);
      const { ctx, confirm } = makeCtx(true);

      await handlers.get(name)!.handler("", ctx);

      expect(confirm).toHaveBeenCalledWith("Quit omp?", "omp will exit and Telegram will stop responding.");
    });

    it(`/${name} does nothing when the confirmation is declined`, async () => {
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry);
      const { ctx, confirm, notify, shutdown } = makeCtx(false);

      await handlers.get(name)!.handler("", ctx);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(shutdown).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  }
});

describe("registerLifecycleCommands /reload", () => {
  const telegramTurn = { chatId: 42, messageThreadId: 7, sourceMessageId: 99, queuedAttachments: [] };

  function makeReloadCtx() {
    const queuedAtReload: PendingNotice[][] = [];
    const ctx = {
      ui: { notify: vi.fn(), confirm: vi.fn() },
      shutdown: vi.fn(),
      reload: vi.fn(async () => {
        // Whatever has to reach the chat must already be queued when the host
        // reloads: after ctx.reload() this runtime can no longer send.
        queuedAtReload.push(takePendingNotices());
      }),
    };
    return { ctx, queuedAtReload };
  }

  afterEach(() => {
    takePendingNotices();
  });

  it("queues the completion notice for the replacement runtime before reloading", async () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();

    await runWithTelegramTurn(telegramTurn, () => handlers.get("reload")!.handler("", ctx));

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(queuedAtReload[0]).toEqual([expect.objectContaining({
      chatId: 42,
      messageThreadId: 7,
      replyTo: 99,
      html: "✅ Reloaded.",
    })]);
  });

  it("queues nothing for a /reload typed in the terminal", async () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();

    await handlers.get("reload")!.handler("", ctx);

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(queuedAtReload[0]).toEqual([]);
  });
});
