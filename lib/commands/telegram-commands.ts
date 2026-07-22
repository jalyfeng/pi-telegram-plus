import { resolve } from "node:path";
import { bindWorkspaceTelegramConfig, readTelegramConfigStore, unbindWorkspaceTelegramConfig, writeGlobalTelegramConfig } from "../config.ts";
import { escapeHtml } from "../html.ts";
import { getTelegramBotUsername } from "../telegram-api.ts";
import { ensureTelegramPairingCode, formatPairingInstructions } from "../pairing.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTransport } from "../types.ts";
import type { TelegramPollingRuntime } from "../polling.ts";
import { log } from "../logger.ts";

const tgCmdLog = log.child("tg-commands");

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

/** Shared "connect and start" sequence for the global bot. */
async function globalConnectAndStart(
  deps: TelegramCommandDeps,
  token: string,
  botUsername: string | undefined,
): Promise<void> {
  const config = ensureTelegramPairingCode({ ...deps.getConfig(), botToken: token, botUsername, telegramEnabled: true });
  deps.setConfig(config);
  await writeGlobalTelegramConfig(config);
  deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.refreshStatus();
}

async function configureGlobalTelegramToken(
  ui: { input: (title: string, placeholder?: string) => Promise<string | undefined>; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> },
  deps: TelegramCommandDeps,
): Promise<boolean> {
  const token = await (ui.inputSecret?.("Telegram bot token") ?? ui.input("Telegram bot token"));
  if (!token) return false;
  const botUsername = await getTelegramBotUsername(token).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during global token setup"));
  if (!deps.getResolvedConfig()) {
    deps.switchResolvedConfig({ store: { version: 2, global: {}, workspaces: [] }, scope: "global", config: {} });
  }
  await globalConnectAndStart(deps, token, botUsername);
  return true;
}

// ── Handler implementations for reuse by aliases ──────────────────────────

async function handleTgGlobalSetup(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  if (!(await configureGlobalTelegramToken(ui, deps))) return;
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  ui.notify(`Telegram global bot token saved and connected.\n${formatPairingInstructions(deps.getConfig())}`, "info");
}

async function handleTgGlobalConnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  const ui = ctx.ui as typeof ctx.ui & { inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  try {
    if (!deps.getConfig().botToken) {
      if (!(await configureGlobalTelegramToken(ui, deps))) return;
    } else {
      const botUsername = deps.getConfig().botUsername ?? await getTelegramBotUsername(deps.getConfig().botToken!).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during global connect"));
      await globalConnectAndStart(deps, deps.getConfig().botToken!, botUsername);
    }
  } catch (err) { tgCmdLog.debug("global connect swallowed error (reported via polling onError)", { err }); }
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  ui.notify(`Telegram global bot connected.\n${formatPairingInstructions(deps.getConfig())}`, "info");
}

async function handleTgGlobalDisconnect(
  _args: string,
  ctx: any,
  deps: TelegramCommandDeps,
): Promise<void> {
  await deps.getPolling().stop();
  const config = deps.getConfig();
  deps.setConfig({ ...config, telegramEnabled: false });
  await writeGlobalTelegramConfig({ telegramEnabled: false });
  deps.clearStatusError();
  deps.refreshStatus();
  ctx.ui.notify("Telegram global bot disconnected. Token is kept; use /tg-global-connect to reconnect.", "info");
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerTelegramCommands(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
): void {
  // ── /tg-global-setup ──────────────────────────────────────────────────
  registry.registerCommand("tg-global-setup", {
    description: "Configure global Telegram bot token and connect",
    handler: (args, ctx) => handleTgGlobalSetup(args, ctx, deps),
  });

  // ── /tg-global-connect ────────────────────────────────────────────────
  registry.registerCommand("tg-global-connect", {
    description: "Enable/start the global Telegram bot connection",
    handler: (args, ctx) => handleTgGlobalConnect(args, ctx, deps),
  });

  // ── /tg-global-disconnect ─────────────────────────────────────────────
  registry.registerCommand("tg-global-disconnect", {
    description: "Disable/stop the global Telegram bot without deleting the token",
    handler: (args, ctx) => handleTgGlobalDisconnect(args, ctx, deps),
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
      const botUsername = await getTelegramBotUsername(token).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during workspace token setup", { workspacePath }));
      await deps.getPolling().stop();
      deps.switchResolvedConfig(await bindWorkspaceTelegramConfig(workspacePath, ensureTelegramPairingCode({
        botToken: token,
        botUsername,
        telegramEnabled: true,
        tool: config.tool,
        thinking: config.thinking,
        messageMode: config.messageMode,
      })));
      deps.getPolling().start();
      await deps.syncTelegramCommands();
      deps.startStatusHeartbeat();
      deps.refreshStatus();
      ui.notify(`Telegram workspace bot bound:\n${escapeHtml(workspacePath)}\n${botUsername ? `@${botUsername}` : "bot username unknown"}\n${formatPairingInstructions(deps.getConfig())}`, "info");
    },
  });

  // ── /tg-cwd-connect ───────────────────────────────────────────────────
  registry.registerCommand("tg-cwd-connect", {
    description: "Enable the Telegram bot for the current directory",
    handler: async (_args, ctx) => {
      const previousScope = deps.getResolvedConfig()?.scope;
      const config = deps.getConfig();
      // If no bot token is configured at all, prompt user to bind or set up global first
      if (!config.botToken && !deps.getResolvedConfig()?.store.global?.botToken) {
        ctx.ui.notify("No Telegram bot configured. Use /tg-global-setup or /tg-bind-cwd first.", "error");
        return;
      }
      // If no token in current scope, try falling back to global
      if (!config.botToken) {
        const global = deps.getResolvedConfig()?.store.global;
        if (global?.botToken) {
          deps.setConfig({ ...config, botToken: global.botToken, botUsername: global.botUsername });
        }
      }
      deps.setConfig({ ...deps.getConfig(), telegramEnabled: true });
      await deps.persistConfig(deps.getConfig());
      await deps.getPolling().stop();
      if (deps.isTelegramEnabled()) deps.getPolling().start();
      deps.clearStatusError();
      deps.startStatusHeartbeat();
      ctx.ui.notify(`Telegram bot enabled for current scope (${previousScope}).`, "info");
    },
  });

  // ── /tg-cwd-disconnect ────────────────────────────────────────────────
  registry.registerCommand("tg-cwd-disconnect", {
    description: "Disable the Telegram bot for the current directory",
    handler: async (_args, ctx) => {
      const previousScope = deps.getResolvedConfig()?.scope;
      await deps.getPolling().stop();
      deps.setConfig({ ...deps.getConfig(), telegramEnabled: false });
      await deps.persistConfig(deps.getConfig());
      // If there's a global bot token, switch to it when disabling workspace bot
      if (previousScope === "workspace") {
        const global = deps.getResolvedConfig()?.store.global;
        if (global?.botToken && global?.telegramEnabled !== false) {
          deps.setConfig({ ...deps.getConfig(), botToken: global.botToken, botUsername: global.botUsername, telegramEnabled: true });
          await deps.persistConfig(deps.getConfig());
          deps.getPolling().start();
        }
      }
      deps.clearStatusError();
      deps.refreshStatus();
      ctx.ui.notify(`Telegram bot disabled for current scope (${previousScope}).`, "info");
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
      const global = previous.store.global;
      deps.switchResolvedConfig(await unbindWorkspaceTelegramConfig(ctx.cwd || process.cwd()));
      // Fall back to global bot if it exists and is enabled
      if (global?.botToken && global?.telegramEnabled !== false) {
        const newConfig = deps.getConfig();
        deps.setConfig({ ...newConfig, botToken: global.botToken, botUsername: global.botUsername });
        await deps.persistConfig(deps.getConfig());
      }
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
        `global: ${store.global?.botUsername ? `@${store.global.botUsername}` : store.global?.botToken ? "configured" : "not configured"}${store.global?.telegramEnabled === false ? " (disabled)" : store.global?.telegramEnabled ? "" : ""}`,
        "",
        "workspaces:",
        ...((store.workspaces ?? []).length
          ? (store.workspaces ?? []).map((workspace) => {
            const status = workspace.config.telegramEnabled === false ? " (disabled)" : "";
            return `- ${escapeHtml(workspace.path)}\n  ${workspace.config.botUsername ? `@${workspace.config.botUsername}${status}` : workspace.config.botToken ? `configured${status}` : "not configured"}`;
          })
          : ["none"]),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}