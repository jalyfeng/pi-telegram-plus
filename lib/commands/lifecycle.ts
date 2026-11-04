import { getCurrentTelegramTurn } from "../turn-context.ts";
import { escapeHtml } from "../html.ts";
import type { TelegramTransport } from "../types.ts";
import { queuePendingNotice } from "../pending-notices.ts";
import { hostCommandName } from "../session-capture.ts";
import { currentCommandScope } from "../tui/command-context.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandRegistry } from "./register.ts";

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
/** Transport for the one write a Telegram-answered shutdown makes before the host exits. */
export type LifecycleDeps = {
  transport?: Pick<TelegramTransport, "editText" | "sendText">;
};

export function registerLifecycleCommands(registry: CommandRegistry, deps: LifecycleDeps = {}): void {

  // ── /reload ────────────────────────────────────────────────────────────
  registry.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      // ctx.reload() re-activates the plugin in-process, so this runtime is no
      // longer the active one by the time the reload lands: its transport drops
      // anything queued after the lease changes. Queue the completion notice for
      // the replacement runtime instead. Only Telegram-originated reloads have a
      // turn scope; a terminal /reload has no chat to answer and only prints its line.
      // A Telegram-started reload answers with one chat message, its result: the
      // "Reloading…" line is only for the terminal, which is where a local reload is.
      const turn = getCurrentTelegramTurn();
      if (turn) {
        // The result line is the command's only message. OMP prints its own "Reloaded ..." line
        // into the ack, so the plugin adds none there. pi prints nothing for a reload started
        // from Telegram (its status line is terminal-only), so the line is written onto the ack
        // message; a command with no ack has no message to write on, so it is sent on its own.
        if (hostCommandName() !== "omp") {
          const ackMessageId = currentCommandScope()?.telegramMessageId;
          queuePendingNotice(ackMessageId !== undefined
            ? {
              chatId: turn.chatId,
              messageThreadId: turn.messageThreadId,
              editMessageId: ackMessageId,
              html: "<b>▶️ /reload</b>\n\n✅ Reloaded.",
              createdAt: Date.now(),
            }
            : {
              chatId: turn.chatId,
              messageThreadId: turn.messageThreadId,
              replyTo: turn.sourceMessageId,
              html: "✅ Reloaded.",
              createdAt: Date.now(),
            });
        }
      } else {
        ui.notify("Reloading…", "info");
      }
      await ctx.reload();
      return;
    },
  });

  // ── /stop ─────────────────────────────────────────────────────────────
  registry.registerCommand("stop", {
    description: "Stop the current agent turn",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ctx.abort();
      ui.notify("⏹ Stopped.", "info");
    },
  });

  // ── /quit, /exit ───────────────────────────────────────────────────────
  // Both confirm before shutting down: on Telegram the TUI may be unreachable,
  // so an accidental tap should not kill the host silently.
  // Answered from Telegram, the confirmation's message is written before the host exits: the
  // answer and one stopped line are awaited, so nothing is sent after the host is gone (#63).
  const shutdownAfterConfirm = (name: "quit" | "exit") => async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const ui = ctx.ui;
    const host = hostCommandName();
    const confirmed = await ui.confirm(`Quit ${host}?`, `${host} will exit and Telegram will stop responding.`);
    if (!confirmed) return;
    const turn = getCurrentTelegramTurn();
    if (turn && deps.transport) {
      const stopped = `<b>▶️ /${name}</b>\n\nQuit ${escapeHtml(host)}?\n✅ Yes\n\n<i>${escapeHtml(host)} stopped. Telegram will stop responding.</i>`;
      const messageId = currentCommandScope()?.telegramMessageId;
      if (messageId !== undefined) {
        await deps.transport.editText(turn.chatId, messageId, stopped).catch(() => undefined);
      } else {
        await deps.transport.sendText(turn.chatId, stopped, turn.messageThreadId, turn.sourceMessageId).catch(() => undefined);
      }
      ctx.shutdown();
      return;
    }
    ctx.shutdown();
    ui.notify(`Shutdown requested. If ${host} keeps running, stop it from the TUI/terminal.`, "info");
  };
  registry.registerCommand("quit", {
    description: "Shut down the host after confirmation",
    handler: shutdownAfterConfirm("quit"),
  });
  registry.registerCommand("exit", {
    description: "Shut down the host after confirmation",
    handler: shutdownAfterConfirm("exit"),
  });

}