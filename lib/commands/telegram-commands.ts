import { resolve } from "node:path";
import { bindWorkspaceTelegramConfig, readTelegramConfigStore, unbindWorkspaceTelegramConfig } from "../config.ts";
import { escapeHtml } from "../html.ts";
import { getTelegramBotUsername } from "../telegram-api.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTransport } from "../types.ts";
import type { TelegramPollingRuntime } from "../polling.ts";

export type TelegramCommandDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (c: TelegramConfig) => void;
  persistConfig: (c: TelegramConfig) => Promise<void>;
  getResolvedConfig: () => ResolvedTelegramConfig | undefined;
  switchResolvedConfig: (next: ResolvedTelegramConfig) => void;
  isTelegramEnabled: () => boolean;
  transport: TelegramTransport;
  getPolling: () => TelegramPollingRuntime;
  refreshStatus: () => void;
  syncTelegramCommands: () => Promise<void>;
  startStatusHeartbeat: () => void;
  clearStatusError: () => void;
};

/** Shared "connect and start" sequence used by both /tg-setup and /tg-connect. */
async function connectAndStart(
  deps: TelegramCommandDeps,
  token: string,
  botUsername: string | undefined,
): Promise<void> {
  const config = deps.getConfig();
  deps.setConfig({ ...config, botToken: token, botUsername, telegramEnabled: true });
  await deps.persistConfig(deps.getConfig());
  deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.refreshStatus();
}

export function configureTelegramToken(
  ui: { input: (title: string, placeholder?: string) => Promise<string | undefined>; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> },
  deps: TelegramCommandDeps,
): Promise<boolean> {
  return (async () => {
    const token = await (ui.inputSecret?.("Telegram bot token") ?? ui.input("Telegram bot token"));
    if (!token) return false;
    const botUsername = await getTelegramBotUsername(token).catch(() => undefined);
    if (!deps.getResolvedConfig()) {
      deps.switchResolvedConfig({ store: { version: 2, global: {}, workspaces: [] }, scope: "global", config: {} });
    }
    await connectAndStart(deps, token, botUsername);
    return true;
  })();
}

export function registerTelegramCommands(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
): void {
  // ── /tg-setup ─────────────────────────────────────────────────────────
  registry.registerCommand("tg-setup", {
    description: "Configure Telegram bot token",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
      if (!(await configureTelegramToken(ui, deps))) return;
      deps.clearStatusError();
      deps.startStatusHeartbeat();
      ui.notify("Telegram bot token saved and connected.", "info");
    },
  });

  // ── /tg-connect ───────────────────────────────────────────────────────
  registry.registerCommand("tg-connect", {
    description: "Enable/start Telegram connection",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
      try {
        if (!deps.getConfig().botToken) {
          if (!(await configureTelegramToken(ui, deps))) return;
        } else {
          const botUsername = deps.getConfig().botUsername ?? await getTelegramBotUsername(deps.getConfig().botToken!).catch(() => undefined);
          await connectAndStart(deps, deps.getConfig().botToken!, botUsername);
        }
      } catch { /* connection errors reported via polling onError */ }
      deps.clearStatusError();
      deps.startStatusHeartbeat();
      ui.notify("Telegram connected.", "info");
    },
  });

  // ── /tg-disconnect ────────────────────────────────────────────────────
  registry.registerCommand("tg-disconnect", {
    description: "Disable/stop Telegram connection without deleting the token",
    handler: async (_args, ctx) => {
      await deps.getPolling().stop();
      deps.setConfig({ ...deps.getConfig(), telegramEnabled: false });
      await deps.persistConfig(deps.getConfig());
      deps.clearStatusError();
      deps.refreshStatus();
      ctx.ui.notify("Telegram disconnected. Token is kept; use /tg-connect to reconnect.", "info");
    },
  });

  // ── /tg-bind-cwd ──────────────────────────────────────────────────────
  registry.registerCommand("tg-bind-cwd", {
    description: "Bind current directory to a Telegram bot",
    handler: async (args, ctx) => {
      const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
      const config = deps.getConfig();
      const workspacePath = resolve(args.trim() || ctx.cwd || process.cwd());
      const token = await (ui.inputSecret?.(`Telegram bot token for ${workspacePath}`) ?? ui.input(`Telegram bot token for ${workspacePath}`));
      if (!token) return;
      const botUsername = await getTelegramBotUsername(token).catch(() => undefined);
      await deps.getPolling().stop();
      deps.switchResolvedConfig(await bindWorkspaceTelegramConfig(workspacePath, {
        botToken: token,
        botUsername,
        telegramEnabled: true,
        tool: config.tool,
        thinking: config.thinking,
        messageMode: config.messageMode,
      }));
      deps.getPolling().start();
      await deps.syncTelegramCommands();
      deps.startStatusHeartbeat();
      deps.refreshStatus();
      ui.notify(`Telegram workspace bot bound:\n${escapeHtml(workspacePath)}\n${botUsername ? `@${botUsername}` : "bot username unknown"}`, "info");
    },
  });

  // ── /tg-unbind-cwd ────────────────────────────────────────────────────
  registry.registerCommand("tg-unbind-cwd", {
    description: "Remove current directory Telegram bot binding",
    handler: async (_args, ctx) => {
      const previous = deps.getResolvedConfig();
      if (previous?.scope !== "workspace") {
        ctx.ui.notify("Current directory is using the global Telegram bot; no workspace binding to remove.", "info");
        return;
      }
      await deps.getPolling().stop();
      deps.switchResolvedConfig(await unbindWorkspaceTelegramConfig(ctx.cwd || process.cwd()));
      if (deps.isTelegramEnabled()) deps.getPolling().start();
      await deps.syncTelegramCommands();
      deps.refreshStatus();
      ctx.ui.notify(`Removed Telegram workspace binding:\n${escapeHtml(previous.workspacePath ?? "")}`, "info");
    },
  });

  // ── /tg-list ───────────────────────────────────────────────────────────
  registry.registerCommand("tg-list", {
    description: "List Telegram bot bindings",
    handler: async (_args, ctx) => {
      const store = await readTelegramConfigStore();
      const lines = [
        `global: ${store.global?.botUsername ? `@${store.global.botUsername}` : store.global?.botToken ? "configured" : "not configured"}`,
        "",
        "workspaces:",
        ...((store.workspaces ?? []).length
          ? (store.workspaces ?? []).map((workspace) => `- ${escapeHtml(workspace.path)}\n  ${workspace.config.botUsername ? `@${workspace.config.botUsername}` : workspace.config.botToken ? "configured" : "not configured"}`)
          : ["none"]),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}