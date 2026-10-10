import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readBotRegistry, readProjectBinding } from "../config.ts";
import type { TelegramInstanceMetadata } from "../instance-coordinator.ts";
import type { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import type { MenuUi, TelegramCommandDeps } from "./telegram-commands.ts";
import type { TgConfigDeps } from "./register.ts";
import type { BotRecord, BotRegistry } from "../types.ts";
import { configToolFlow, configThinkingFlow, configRetryFlow } from "./tg-config.ts";
import {
  addBotFlow,
  setBotDefaultFlow,
  updateBotFlow,
  removeBotFlow,
  bindProjectFlow,
  enableProjectFlow,
  disableProjectFlow,
  unbindProjectFlow,
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
  "➕ Add bot",
  "Bot list",
  "⬅️ Back",
] as const;

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";
const UNBIND_LABEL = "Unbind";

/** Format a registered bot for display in bot-list / pickers. */
function formatBotLabel(bot: BotRecord, registry: BotRegistry): string {
  const marker = registry.defaultBotId === bot.id ? " ★ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  return `${bot.name}${marker} · ${username} · ${bot.id.slice(0, 8)}`;
}

// ── Switch instance flow deps ──────────────────────────────────────────────

export type SwitchInstanceDeps = {
  getCoordinator: () => TelegramInstanceCoordinator | undefined;
  getCurrentChatId: () => number | undefined;
  stopPolling: () => Promise<void>;
  startPolling: () => void;
  requestReconcile: () => void;
  getCurrentTurn: () => { chatId: number; messageThreadId?: number; sourceMessageId?: number } | undefined;
  /** Shared handoff gate (same Set used by the flat /tg-switch handler and
   *  isActiveInstance) so a menu-triggered switch blocks outbound sends
   *  during the handoff, just like the flat command. */
  pendingHandoffs: Set<string>;
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

    if (choice === "➕ Add bot") {
      await addBotFlow(ui, deps);
    } else if (choice === "Bot list") {
      await botListMenu(ui, deps, cwd);
    }
    // loop re-renders the Bots submenu
  }
}

// ── Bot list (object-first: pick a bot → per-bot actions) ──────────────────

async function botListMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify("No bots registered. Use ➕ Add bot first.", "info");
      return;
    }
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await ui.select("Bot list", [...choices, BACK_LABEL]);
    if (!selected || selected === BACK_LABEL) return; // back to Bots submenu
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot) await botDetailMenu(ui, deps, cwd, bot, registry);
    // loop re-renders the bot list (reflects default/remove changes)
  }
}

// ── Per-bot actions ──────────────────────────────────────────────────────────

async function botDetailMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  bot: BotRecord,
  registry: BotRegistry,
): Promise<void> {
  const isDefault = registry.defaultBotId === bot.id;
  while (true) {
    const choice = await ui.select(
      `🤖 ${bot.name}${isDefault ? " ★ default" : ""}`,
      ["Set default", "Update", "Remove", BACK_LABEL],
    );
    if (!choice || choice === BACK_LABEL) return; // back to bot list

    if (choice === "Set default") {
      await setBotDefaultFlow(ui, bot.id);
    } else if (choice === "Update") {
      await updateBotFlow(ui, deps, cwd, bot.id);
    } else if (choice === "Remove") {
      await removeBotFlow(ui, deps, cwd, bot.id);
      return; // removed → back to bot list (re-reads without this bot)
    }
    // loop re-renders the per-bot action menu
  }
}

// ── Project submenu (two toggles: binding + enabled) ────────────────────────

async function projectMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    const [registry, project] = await Promise.all([readBotRegistry(), readProjectBinding(cwd)]);
    const boundBotId = project?.binding.botId;
    const effectiveBotId = boundBotId ?? registry.defaultBotId;
    const effectiveBot = effectiveBotId ? registry.bots.find((b) => b.id === effectiveBotId) : undefined;
    const hasBinding = !!project;
    const enabled = project?.binding.enabled !== false; // binding is the source of truth (config may lag a persist cycle)

    const botLabel = effectiveBot
      ? `Bot: ${effectiveBot.name}${!hasBinding ? " (default)" : ""}`
      : "Bot: (none)";

    const choice = await ui.select("📁 Project", [
      botLabel,
      `Enabled: ${enabled ? "● on" : "○ off"}`,
      BACK_LABEL,
    ]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice === botLabel) {
      if (registry.bots.length === 0) {
        ui.notify("No bots registered. Use /tg → Bots → Add bot first.", "info");
        continue;
      }
      const choices = registry.bots.map((b) => formatBotLabel(b, registry));
      const selected = await ui.select("Bind project to bot", [...choices, ...(hasBinding ? [UNBIND_LABEL] : []), BACK_LABEL]);
      if (!selected || selected === BACK_LABEL) continue;
      if (selected === UNBIND_LABEL) {
        await unbindProjectFlow(ui, deps, cwd);
      } else {
        const bot = registry.bots[choices.indexOf(selected)];
        if (bot) await bindProjectFlow(ui, deps, cwd, bot.id);
      }
    } else if (choice.startsWith("Enabled:")) {
      if (enabled) {
        const ok = await ui.confirm(
          "Disable bot for this project?",
          "Disabling will disconnect the bot — the /tg menu will close and you can't re-enable it from Telegram. Re-enable via /tg-cwd-connect in the TUI or restart pi. Continue?",
        );
        if (ok) await disableProjectFlow(ui, deps, cwd);
      } else {
        await enableProjectFlow(ui, deps, cwd);
      }
    }
    // loop re-renders Project (reflects new binding / enabled state)
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
  const pendingHandoffs = switchDeps.pendingHandoffs;
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