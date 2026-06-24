import type { CommandRegistry, TgConfigDeps } from "./register.ts";
import type { TelegramConfig, TelegramMessageMode, TelegramRenderLevel, TelegramStatusLevel } from "../types.ts";
import { RENDER_LEVELS, MODE_VALUES, STATUS_TEXT_LEVELS } from "../types.ts";

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  thinking: "💭 Thinking rendering",
  mode: "📨 Message mode",
  retry: "🔄 Retry count",
  status: "📋 Status text",
};

const STATUS_OPTION_HINTS: Record<string, string> = {
  hidden: "no status line",
  minimal: "tg+ with icon",
  brief: "telegram+ with icon",
  full: "telegram+ with icon + @username (default)",
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
      const applyAndNotify = async (next: TelegramConfig, label: string, val: string | number) => {
        deps.setConfig(next);
        await deps.persistConfig(next);
        ui.notify(`${label} set to ${val}`, "info");
      };

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
          await applyAndNotify(next, key, value);
          return;
        } else if (key === "mode") {
          if (!(MODE_VALUES as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /tg-config mode <queue|steer>", "error");
            return;
          }
          const next = { ...config, messageMode: value as TelegramMessageMode };
          await applyAndNotify(next, "mode", value);
          return;
        } else if (key === "retry") {
          const n = parseInt(value, 10);
          if (!Number.isInteger(n) || n < 0 || n > 10) {
            ui.notify("Invalid. Use: /tg-config retry <0-10>", "error");
            return;
          }
          const next = { ...config, retryCount: n };
          await applyAndNotify(next, "retryCount", n);
          return;
        } else if (key === "status") {
          if (!(STATUS_TEXT_LEVELS as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /tg-config status <hidden|brief|full|minimal>", "error");
            return;
          }
          const next = { ...config, tuiStatus: value as TelegramStatusLevel };
          await applyAndNotify(next, "tuiStatus", value);
          return;
        } else {
          ui.notify("Invalid key. Use: tool, thinking, mode, status, or retry", "error");
          return;
        }
      }

      // Interactive mode
      const config = deps.getConfig();
      const currentTool = config.tool ?? "brief";
      const currentThinking = config.thinking ?? "brief";
      const currentMode = config.messageMode ?? "steer";
      const currentRetry = config.retryCount ?? 3;
      const currentStatus = config.tuiStatus ?? "full";

      const choice = await ui.select("⚙️ Telegram Config", [
        `${KEY_LABELS.tool}: ${currentTool}`,
        `${KEY_LABELS.thinking}: ${currentThinking}`,
        `${KEY_LABELS.mode}: ${currentMode}`,
        `${KEY_LABELS.status}: ${currentStatus}`,
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
      } else if (choice.startsWith(KEY_LABELS.status)) {
        selectedKey = "status";
        current = currentStatus;
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
        await applyAndNotify(next, KEY_LABELS.retry, n);
        return;
      } else {
        return;
      }

      const values = selectedKey === "status" ? STATUS_TEXT_LEVELS
        : selectedKey === "mode" ? MODE_VALUES
        : RENDER_LEVELS;
      const configKey = selectedKey === "status" ? "tuiStatus"
        : selectedKey === "mode" ? "messageMode"
        : selectedKey;
      const labels = values.map((v) => {
        const dot = v === current ? "● " : "  ";
        const hint = selectedKey === "status" && STATUS_OPTION_HINTS[v]
          ? ` — ${STATUS_OPTION_HINTS[v]}`
          : "";
        return `${dot}${v}${hint}`;
      });

      const valueChoice = await ui.select(KEY_LABELS[selectedKey], labels);
      if (!valueChoice) return;

      const idx = labels.indexOf(valueChoice);
      if (idx < 0 || idx >= values.length) return;
      const selectedValue = values[idx];
      const next = { ...config, [configKey]: selectedValue };
      await applyAndNotify(next, KEY_LABELS[selectedKey], selectedValue);
    },
  });
}