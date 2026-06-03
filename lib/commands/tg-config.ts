import type { CommandRegistry, TgConfigDeps } from "./register.ts";
import type { TelegramConfig, TelegramMessageMode, TelegramRenderLevel } from "../types.ts";
import { RENDER_LEVELS, MODE_VALUES } from "../types.ts";

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  thinking: "💭 Thinking rendering",
  mode: "📨 Message mode",
  retry: "🔄 Retry count",
};

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
        } else if (key === "mode") {
          if (!(MODE_VALUES as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /tg-config mode <queue|steer>", "error");
            return;
          }
          const next = { ...config, messageMode: value as TelegramMessageMode };
          deps.setConfig(next);
          await deps.persistConfig(next);
          ui.notify(`mode set to ${value}`, "info");
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
          ui.notify("Invalid key. Use: tool, thinking, mode, or retry", "error");
          return;
        }
      }

      // Interactive mode
      const config = deps.getConfig();
      const currentTool = config.tool ?? "brief";
      const currentThinking = config.thinking ?? "brief";
      const currentMode = config.messageMode ?? "steer";
      const currentRetry = config.retryCount ?? 3;

      const choice = await ui.select("⚙️ Telegram Config", [
        `${KEY_LABELS.tool}: ${currentTool}`,
        `${KEY_LABELS.thinking}: ${currentThinking}`,
        `${KEY_LABELS.mode}: ${currentMode}`,
        `${KEY_LABELS.retry}: ${currentRetry}`,
      ]);
      if (!choice) return;

      let selectedKey: string;
      let current: string;

      if (choice.startsWith(KEY_LABELS.tool)) {
        selectedKey = "tool";
        current = currentTool;
      } else if (choice.startsWith(KEY_LABELS.thinking)) {
        selectedKey = "thinking";
        current = currentThinking;
      } else if (choice.startsWith(KEY_LABELS.mode)) {
        selectedKey = "mode";
        current = currentMode;
      } else if (choice.startsWith(KEY_LABELS.retry)) {
        // Retry count is a number, not a select from list
        const input = await ui.input("Retry count (0-10)", `Current: ${currentRetry}`);
        if (!input) return;
        const n = parseInt(input, 10);
        if (!Number.isInteger(n) || n < 0 || n > 10) {
          ui.notify("Must be a number 0-10", "error");
          return;
        }
        const next = { ...config, retryCount: n };
        deps.setConfig(next);
        await deps.persistConfig(next);
        ui.notify(`${KEY_LABELS.retry} set to ${n}`, "info");
        return;
      } else {
        return;
      }

      const values = selectedKey === "mode" ? [...MODE_VALUES] : [...RENDER_LEVELS];
      const labels = values.map((v) => (v === current ? `● ${v}` : `  ${v}`));

      const valueChoice = await ui.select(KEY_LABELS[selectedKey], labels);
      if (!valueChoice) return;

      const idx = labels.indexOf(valueChoice);
      if (idx < 0 || idx >= values.length) return;
      const selectedValue = values[idx];

      const next = { ...config, [selectedKey === "mode" ? "messageMode" : selectedKey]: selectedValue };
      deps.setConfig(next);
      await deps.persistConfig(next);
      ui.notify(`${KEY_LABELS[selectedKey]} set to ${selectedValue}`, "info");
    },
  });
}