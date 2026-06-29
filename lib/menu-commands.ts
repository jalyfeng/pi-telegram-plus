import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTelegramMyCommands } from "./telegram-api.ts";
import { log } from "./logger.ts";

const menuLog = log.child("menu-commands");

const TELEGRAM_MENU_COMMANDS: Array<{ command: string; description: string }> = [
  // Keep the built-in pi commands in the same order as the TUI slash menu.
  { command: "login", description: "Configure provider authentication" },
  { command: "logout", description: "Remove stored credentials" },
  { command: "model", description: "Show or change the current model" },
  { command: "scoped-models", description: "Enable/disable models for cycling" },
  { command: "settings", description: "Open settings menu" },
  { command: "resume", description: "Resume a previous session" },
  { command: "new", description: "Start a new session" },
  { command: "name", description: "Set or show session name" },
  { command: "session", description: "Show session statistics" },
  { command: "tree", description: "Navigate session tree" },
  { command: "fork", description: "Fork from a previous message" },
  { command: "clone", description: "Clone at a previous message" },
  { command: "compact", description: "Compact session context" },
  { command: "copy", description: "Copy last assistant message" },
  { command: "export", description: "Export session" },
  { command: "share", description: "Share session as gist" },
  { command: "reload", description: "Reload pi resources" },
  { command: "hotkeys", description: "Show keyboard shortcuts" },
  { command: "changelog", description: "Show changelog" },
  { command: "quit", description: "Shut down pi" },

  // Additional pi-telegram-plus commands.
  { command: "cwd", description: "Show current working directory" },
  { command: "cd", description: "Switch pi working directory" },
  { command: "import", description: "Import a session" },
  { command: "thinking", description: "Show or change thinking level" },
  { command: "stop", description: "Stop the current agent turn" },
  { command: "debug", description: "Show debug information" },
  { command: "status", description: "Show runtime snapshot (workspace, model, context, messages)" },
  // tg-* commands visible in the Telegram bot menu.
  // tg-bind-cwd / tg-unbind-cwd are workspace-management commands that
  // require local cwd context and do not belong in the bot command list.
  { command: "tg_global_setup", description: "Configure global Telegram bot token" },
  { command: "tg_global_connect", description: "Enable/start global Telegram bot" },
  { command: "tg_global_disconnect", description: "Disable/stop global Telegram bot" },
  { command: "tg_config", description: "Configure Telegram message rendering" },
  { command: "tg_list", description: "List Telegram bot bindings" },
];

const toTelegramCommandName = (name: string): string | undefined => {
  // Telegram bot menu commands allow only [A-Za-z0-9_] and max 32 chars.
  const telegramName = name.replace(/-/g, "_").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(telegramName)) return undefined;
  return telegramName;
};

export function buildTelegramMenuCommands(pi: ExtensionAPI): Array<{ command: string; description: string }> {
  const commands = new Map<string, string>();
  const addCommand = (name: string, description?: string) => {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName || commands.has(telegramName)) return;
    commands.set(telegramName, (description?.trim() || `Run /${telegramName}`).slice(0, 256));
  };

  for (const command of TELEGRAM_MENU_COMMANDS) addCommand(command.command, command.description);
  for (const command of pi.getCommands()) addCommand(command.name, command.description);

  // Telegram accepts at most 100 bot commands. Keep the curated built-in-style
  // commands first, then fill the rest with extension/prompt/skill commands.
  return Array.from(commands, ([command, description]) => ({ command, description })).slice(0, 100);
}

export async function syncTelegramCommands(botToken: string | undefined, pi: ExtensionAPI): Promise<void> {
  if (!botToken) return;
  try {
    await setTelegramMyCommands(botToken, buildTelegramMenuCommands(pi));
  } catch (err) { menuLog.warn("syncTelegramCommands failed", { err }); }
}