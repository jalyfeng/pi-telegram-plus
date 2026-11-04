import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCommandName } from "../session-capture.ts";
import { registerLifecycleCommands } from "../commands/lifecycle.ts";
import type { CommandRegistry } from "../commands/register.ts";
import { runWithTelegramTurn } from "../turn-context.ts";
import { takePendingNotices, type PendingNotice } from "../pending-notices.ts";
import { runInCommand } from "../tui/command-context.ts";
import type { CommandScope } from "../tui/origin.ts";

vi.mock("../session-capture.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../session-capture.ts")>();
  return { ...mod, hostCommandName: vi.fn(() => "pi" as const) };
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
      vi.mocked(hostCommandName).mockReturnValueOnce("omp");
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

  it("adds no completion notice on OMP, where the host's result line is in the command's ack", async () => {
    vi.mocked(hostCommandName).mockReturnValueOnce("omp");
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();
    const scope = { telegramMessageId: 55 } as unknown as CommandScope;

    await runWithTelegramTurn(telegramTurn, () => runInCommand(scope, () => handlers.get("reload")!.handler("", ctx)));

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(queuedAtReload[0]).toEqual([]);
  });

  it("edits the completion line into the command's ack on pi, which prints no result line", async () => {
    vi.mocked(hostCommandName).mockReturnValueOnce("pi");
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();
    const scope = { telegramMessageId: 55 } as unknown as CommandScope;

    await runWithTelegramTurn(telegramTurn, () => runInCommand(scope, () => handlers.get("reload")!.handler("", ctx)));

    expect(queuedAtReload[0]).toEqual([expect.objectContaining({
      chatId: 42,
      messageThreadId: 7,
      editMessageId: 55,
      html: "<b>▶️ /reload</b>\n\n✅ Reloaded.",
    })]);
    expect(queuedAtReload[0][0].replyTo).toBeUndefined();
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

describe("registerLifecycleCommands /quit answered from Telegram (#63)", () => {
  const telegramTurn = { chatId: 42, messageThreadId: 7, sourceMessageId: 99, queuedAttachments: [] };

  for (const name of ["quit", "exit"] as const) {
    it(`/${name} writes ✅ Yes and a stopped line, awaited, before the host exits`, async () => {
      const order: string[] = [];
      const editText = vi.fn(async () => {
        order.push("edit-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("edit-done");
      });
      const sendText = vi.fn(async () => [{ message_id: 1 }]);
      const shutdown = vi.fn(() => { order.push("shutdown"); });
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry, { transport: { editText, sendText } as never });
      const confirm = vi.fn(async () => true);
      const notify = vi.fn();
      const scope = { telegramMessageId: 5 } as unknown as CommandScope;

      await runWithTelegramTurn(telegramTurn, () => runInCommand(scope, () =>
        handlers.get(name)!.handler("", { ui: { confirm, notify }, shutdown } as never)));

      expect(order).toEqual(["edit-start", "edit-done", "shutdown"]);
      expect(editText).toHaveBeenCalledTimes(1);
      const [chatId, messageId, html] = editText.mock.calls[0] as unknown as [number, number, string];
      expect(chatId).toBe(42);
      expect(messageId).toBe(5);
      expect(html).toContain("✅ Yes");
      expect(html).toContain("stopped");
      // Nothing is left to send after the exit: the stopped line is the write, not a notify.
      expect(notify).not.toHaveBeenCalled();
    });
  }
});
