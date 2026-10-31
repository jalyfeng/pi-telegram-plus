import { getCurrentTelegramTurn } from "../turn-context.ts";
import { queuePendingNotice } from "../pending-notices.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandRegistry } from "./register.ts";
import { checkpointCurrentUpdateCursor } from "../polling.ts";

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerLifecycleCommands(registry: CommandRegistry): void {

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
        queuePendingNotice({
          chatId: turn.chatId,
          messageThreadId: turn.messageThreadId,
          replyTo: turn.sourceMessageId,
          html: "✅ Reloaded.",
          createdAt: Date.now(),
        });
      } else {
        ui.notify("Reloading…", "info");
      }
      // /reload re-activates the plugin in-process; commit this update first so
      // the replacement runtime does not re-fetch and re-run the unconfirmed
      // /reload (which would call ctx.reload() again).
      await checkpointCurrentUpdateCursor();
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
  const shutdownAfterConfirm = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const ui = ctx.ui;
    const confirmed = await ui.confirm("Quit pi?", "pi will exit and Telegram will stop responding.");
    if (confirmed) {
      ctx.shutdown();
      ui.notify("Shutdown requested. If pi keeps running, stop it from the TUI/terminal.", "info");
    }
  };
  registry.registerCommand("quit", {
    description: "Shut down pi",
    handler: shutdownAfterConfirm,
  });
  registry.registerCommand("exit", {
    description: "Shut down pi",
    handler: shutdownAfterConfirm,
  });

}