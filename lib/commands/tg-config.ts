import type { CommandRegistry, TgConfigDeps } from "./register.ts";
import type { TelegramConfig, TelegramRenderLevel } from "../types.ts";
import { RENDER_LEVELS } from "../types.ts";
import type { MenuUi } from "./telegram-commands.ts";

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  thinking: "💭 Thinking rendering",
  retry: "🔄 Retry count",
};

// ── Reusable config flow functions (shared by /tg-config and /tg menu) ─────

export async function configToolFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const current = config.tool ?? "brief";
  let selectedValue: TelegramRenderLevel | undefined;
  if (value && (RENDER_LEVELS as readonly string[]).includes(value)) {
    selectedValue = value as TelegramRenderLevel;
  } else if (!value) {
    selectedValue = await pickRenderLevel(ui, KEY_LABELS.tool, current);
  } else {
    ui.notify("Invalid. Use: hidden, brief, or full", "error");
    return;
  }
  if (!selectedValue) return;
  const next: TelegramConfig = { ...config, tool: selectedValue };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.tool} set to ${selectedValue}`, "info");
}

export async function configThinkingFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const current = config.thinking ?? "brief";
  let selectedValue: TelegramRenderLevel | undefined;
  if (value && (RENDER_LEVELS as readonly string[]).includes(value)) {
    selectedValue = value as TelegramRenderLevel;
  } else if (!value) {
    selectedValue = await pickRenderLevel(ui, KEY_LABELS.thinking, current);
  } else {
    ui.notify("Invalid. Use: hidden, brief, or full", "error");
    return;
  }
  if (!selectedValue) return;
  const next: TelegramConfig = { ...config, thinking: selectedValue };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.thinking} set to ${selectedValue}`, "info");
}

export async function configRetryFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const currentRetry = config.retryCount ?? 3;
  const inputValue = value ?? await ui.input("Retry count (0-10)", `Current: ${currentRetry}`);
  if (!inputValue) return;
  const n = parseInt(inputValue, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    ui.notify("Must be a number 0-10", "error");
    return;
  }
  const next = { ...config, retryCount: n };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.retry} set to ${n}`, "info");
}

async function pickRenderLevel(ui: MenuUi, title: string, current: TelegramRenderLevel): Promise<TelegramRenderLevel | undefined> {
  const labels = [...RENDER_LEVELS].map((v) => (v === current ? `● ${v}` : `  ${v}`));
  const choice = await ui.select(title, labels);
  if (!choice) return undefined;
  const idx = labels.indexOf(choice);
  if (idx < 0 || idx >= RENDER_LEVELS.length) return undefined;
  return RENDER_LEVELS[idx];
}

// ── /tg-config command (direct-set + interactive) ─────────────────────────

export function registerTgConfigCommands(
  registry: CommandRegistry,
  deps: TgConfigDeps,
): void {
  registry.registerCommand("tg-config", {
    description: "Configure Telegram message rendering and mode",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const parts = args.trim().split(/\s+/);

      // Direct-set mode: /tg-config <key> <value>
      if (parts.length >= 2 && parts[0]) {
        const key = parts[0];
        const value = parts[1];
        const config = deps.getConfig();

        if (key === "tool" || key === "thinking") {
          if (!(RENDER_LEVELS as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /tg-config <tool|thinking> <hidden|brief|full>", "error");
            return;
          }
          const next = key === "tool"
            ? { ...config, tool: value as TelegramRenderLevel }
            : { ...config, thinking: value as TelegramRenderLevel };
          deps.setConfig(next);
          await deps.persistConfig(next);
          ui.notify(`${key} set to ${value}`, "info");
          return;
        } else if (key === "retry") {
          const n = parseInt(value, 10);
          if (!Number.isInteger(n) || n < 0 || n > 10) {
            ui.notify("Invalid. Use: /tg-config retry <0-10>", "error");
            return;
          }
          const next = { ...config, retryCount: n };
          deps.setConfig(next);
          await deps.persistConfig(next);
          ui.notify(`retryCount set to ${n}`, "info");
          return;
        } else {
          ui.notify("Invalid key. Use: tool, thinking, or retry", "error");
          return;
        }
      }

      // Interactive mode
      const config = deps.getConfig();
      const currentTool = config.tool ?? "brief";
      const currentThinking = config.thinking ?? "brief";
      const currentRetry = config.retryCount ?? 3;

      const choice = await ui.select("⚙️ Telegram Config", [
        `${KEY_LABELS.tool}: ${currentTool}`,
        `${KEY_LABELS.thinking}: ${currentThinking}`,
        `${KEY_LABELS.retry}: ${currentRetry}`,
      ]);
      if (!choice) return;

      if (choice.startsWith(KEY_LABELS.tool)) {
        await configToolFlow(ui, deps);
      } else if (choice.startsWith(KEY_LABELS.thinking)) {
        await configThinkingFlow(ui, deps);
      } else if (choice.startsWith(KEY_LABELS.retry)) {
        await configRetryFlow(ui, deps);
      }
    },
  });
}