import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readBotRegistry } from "../config.ts";
import type { TelegramInstanceMetadata } from "../instance-coordinator.ts";
import type { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import type { MenuUi, TelegramCommandDeps } from "./telegram-commands.ts";
import type { TgConfigDeps } from "./register.ts";
import { configToolFlow, configThinkingFlow, configRetryFlow } from "./tg-config.ts";
import {
  listBotsFlow,
  addBotFlow,
  setBotDefaultFlow,
  updateBotFlow,
  removeBotFlow,
  bindProjectFlow,
  enableProjectFlow,
  disableProjectFlow,
  unbindProjectFlow,
  showProjectBindingFlow,
} from "./telegram-commands.ts";

/** Format a live instance for display in the switch selector. Exported so the
 *  flat /tg-switch handler in index.ts can reuse the same formatting. */
export function formatInstanceChoice(instance: TelegramInstanceMetadata, activeId: string): string {
  const marker = instance.id === activeId ? "✓" : " ";
  const project = (basename(instance.cwd) || instance.cwd).slice(0, 28);
  const session = (instance.sessionName || instance.sessionId?.slice(0, 8) || "session").slice(0, 24);
  const model = (instance.model || "no-model").slice(0, 36);
  return `${marker} ${project} · ${session} · ${model} · ${instance.id.slice(0, 8)}`;
}

// ── Menu option labels ─────────────────────────────────────────────────────

const MAIN_MENU_OPTIONS = [
  "🤖 Bots",
  "📁 Project",
  "⚙️ Config",
  "🔄 Switch instance",
  "❌ Close",
] as const;

const BOTS_MENU_OPTIONS = [
  "List bots",
  "➕ Add bot",
  "Set default",
  "Update bot",
  "Remove bot",
  "⬅️ Back",
] as const;

const PROJECT_MENU_OPTIONS = [
  "Show binding",
  "Bind to bot",
  "Enable",
  "Disable",
  "Unbind",
  "⬅️ Back",
] as const;

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";

// ── Switch instance flow deps ──────────────────────────────────────────────

export type SwitchInstanceDeps = {
  getCoordinator: () => TelegramInstanceCoordinator | undefined;
  getCurrentChatId: () => number | undefined;
  stopPolling: () => Promise<void>;
  startPolling: () => void;
  requestReconcile: () => void;
  getCurrentTurn: () => { chatId: number; messageThreadId?: number; sourceMessageId?: number } | undefined;
};

// ── Menu registration ──────────────────────────────────────────────────────

export function registerTgMenuCommand(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
): void {
  registry.registerCommand("tg", {
    description: "Open the Telegram management menu",
    handler: (_args, ctx) => runTgMenu(ctx.ui, deps, configDeps, switchDeps, ctx.cwd || process.cwd()),
  });
}

// ── Menu driver ─────────────────────────────────────────────────────────────

async function runTgMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  cwd: string,
): Promise<void> {
  while (true) {
    const choice = await ui.select("Telegram Management", [...MAIN_MENU_OPTIONS]);
    if (!choice || choice === "❌ Close") return;

    if (choice === "🤖 Bots") {
      if (await botsMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "📁 Project") {
      if (await projectMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "⚙️ Config") {
      if (await configMenu(ui, configDeps)) continue;
      return;
    } else if (choice === "🔄 Switch instance") {
      if (await switchInstanceMenu(ui, switchDeps)) continue;
      return;
    }
    // Unknown choice — return to main menu
  }
}

// ── Bots submenu ───────────────────────────────────────────────────────────

async function botsMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    const choice = await ui.select("🤖 Bots", [...BOTS_MENU_OPTIONS]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    switch (choice) {
      case "List bots":
        await listBotsFlow(ui);
        break;
      case "➕ Add bot":
        await addBotFlow(ui, deps);
        break;
      case "Set default": {
        const registry = await readBotRegistry();
        if (registry.bots.length === 0) {
          ui.notify("No bots registered. Add a bot first.", "info");
          break;
        }
        const choices = registry.bots.map((b) => {
          const marker = registry.defaultBotId === b.id ? " ★ default" : "";
          const username = b.botUsername ? `@${b.botUsername}` : "no username";
          return `${b.name}${marker} · ${username} · ${b.id.slice(0, 8)}`;
        });
        const selected = await ui.select("Select a bot to set as default", [...choices, BACK_LABEL]);
        if (!selected || selected === BACK_LABEL) break;
        const bot = registry.bots[choices.indexOf(selected)];
        if (bot) await setBotDefaultFlow(ui, bot.id);
        break;
      }
      case "Update bot": {
        const registry = await readBotRegistry();
        if (registry.bots.length === 0) {
          ui.notify("No bots registered. Add a bot first.", "info");
          break;
        }
        const botChoices = registry.bots.map((b) => `${b.name} · ${b.id.slice(0, 8)}`);
        const selected = await ui.select("Select a bot to update", [...botChoices, BACK_LABEL]);
        if (!selected || selected === BACK_LABEL) break;
        const bot = registry.bots[botChoices.indexOf(selected)];
        if (bot) await updateBotFlow(ui, deps, cwd, bot.id);
        break;
      }
      case "Remove bot": {
        const registry = await readBotRegistry();
        if (registry.bots.length === 0) {
          ui.notify("No bots registered.", "info");
          break;
        }
        const botChoices = registry.bots.map((b) => `${b.name} · ${b.id.slice(0, 8)}`);
        const selected = await ui.select("Select a bot to remove", [...botChoices, BACK_LABEL]);
        if (!selected || selected === BACK_LABEL) break;
        const bot = registry.bots[botChoices.indexOf(selected)];
        if (bot) await removeBotFlow(ui, deps, cwd, bot.id);
        break;
      }
    }
  }
}

// ── Project submenu ────────────────────────────────────────────────────────

async function projectMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    const choice = await ui.select("📁 Project", [...PROJECT_MENU_OPTIONS]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    switch (choice) {
      case "Show binding":
        await showProjectBindingFlow(ui, cwd);
        break;
      case "Bind to bot":
        await bindProjectFlow(ui, deps, cwd);
        break;
      case "Enable":
        await enableProjectFlow(ui, deps, cwd);
        break;
      case "Disable":
        await disableProjectFlow(ui, deps, cwd);
        break;
      case "Unbind":
        await unbindProjectFlow(ui, deps, cwd);
        break;
    }
  }
}

// ── Config submenu ─────────────────────────────────────────────────────────

async function configMenu(ui: MenuUi, configDeps: TgConfigDeps): Promise<boolean> {
  while (true) {
    const config = configDeps.getConfig();
    const currentTool = config.tool ?? "brief";
    const currentThinking = config.thinking ?? "brief";
    const currentRetry = config.retryCount ?? 3;

    const choice = await ui.select(CONFIG_MENU_PREFIX, [
      `🔧 Tool: ${currentTool}`,
      `💭 Thinking: ${currentThinking}`,
      `🔄 Retry: ${currentRetry}`,
      BACK_LABEL,
    ]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice.startsWith("🔧 Tool:")) {
      await configToolFlow(ui, configDeps);
    } else if (choice.startsWith("💭 Thinking:")) {
      await configThinkingFlow(ui, configDeps);
    } else if (choice.startsWith("🔄 Retry:")) {
      await configRetryFlow(ui, configDeps);
    }
  }
}

// ── Switch instance submenu ────────────────────────────────────────────────

async function switchInstanceMenu(ui: MenuUi, switchDeps: SwitchInstanceDeps): Promise<boolean> {
  const coordinator = switchDeps.getCoordinator();
  if (!coordinator || !coordinator.isActive()) {
    ui.notify("This pi instance is not the active Telegram instance.", "error");
    return true; // back to main
  }
  const instances = await coordinator.listInstances();
  const active = coordinator.getActive();
  if (!active || instances.length === 0) {
    ui.notify("No live Telegram instances are available.", "error");
    return true; // back to main
  }

  const choices = instances.map((instance) => formatInstanceChoice(instance, active.instanceId));
  const selected = await ui.select("Switch Telegram pi instance", [...choices, BACK_LABEL]);
  if (!selected || selected === BACK_LABEL) return true; // back to main

  const target = instances[choices.indexOf(selected)];
  if (!target) return true;

  const turn = switchDeps.getCurrentTurn();
  const chatId = turn?.chatId ?? switchDeps.getCurrentChatId();
  if (chatId === undefined) {
    ui.notify("No active Telegram chat is available for history replay.", "error");
    return true;
  }

  const handoffId = randomUUID();
  const pendingHandoffs = new Set<string>();
  pendingHandoffs.add(handoffId);
  try {
    await switchDeps.stopPolling();
    await coordinator.switchTo(
      target.id,
      {
        chatId,
        messageThreadId: turn?.messageThreadId,
        sourceMessageId: turn?.sourceMessageId,
      },
      { instanceId: active.instanceId, generation: active.generation },
    );
  } finally {
    pendingHandoffs.delete(handoffId);
    switchDeps.requestReconcile();
    if (pendingHandoffs.size === 0 && coordinator.isActive() && !coordinator.getActive()?.replay) {
      switchDeps.startPolling();
    }
  }
  return true; // back to main
}