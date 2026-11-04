import type { TgConfigDeps } from "./register.ts";
import type { TelegramBashConfirm, TelegramConfig, TelegramMessageMode, TelegramRenderLevel } from "../types.ts";
import { BASH_CONFIRM_MODES, MESSAGE_MODES, RENDER_LEVELS } from "../types.ts";
import type { MenuUi } from "./telegram-commands.ts";

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  thinking: "💭 Thinking rendering",
  retry: "🔄 Retry count",
  bash: "🐚 Shell confirm",
  mode: "📨 Message mode",
};

// ── Reusable config flow functions (used by the /tg Config submenu) ───────

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

export async function configBashFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const current = config.bashConfirm ?? "dangerous";
  let selected: TelegramBashConfirm | undefined;
  if (value && (BASH_CONFIRM_MODES as readonly string[]).includes(value)) {
    selected = value as TelegramBashConfirm;
  } else if (!value) {
    const labels = [...BASH_CONFIRM_MODES].map((mode) => (mode === current ? `● ${mode}` : `  ${mode}`));
    const choice = await ui.select(KEY_LABELS.bash, labels);
    if (!choice) return;
    const index = labels.indexOf(choice);
    if (index >= 0) selected = BASH_CONFIRM_MODES[index];
  } else {
    ui.notify("Invalid. Use: always, dangerous, or never", "error");
    return;
  }
  if (!selected) return;
  const next: TelegramConfig = { ...config, bashConfirm: selected };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.bash} set to ${selected}`, "info");
}

export async function configModeFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const current = config.messageMode ?? "steer";
  let selected: TelegramMessageMode | undefined;
  if (value && (MESSAGE_MODES as readonly string[]).includes(value)) {
    selected = value as TelegramMessageMode;
  } else if (!value) {
    const labels = [...MESSAGE_MODES].map((mode) => (mode === current ? `● ${mode}` : `  ${mode}`));
    const choice = await ui.select(KEY_LABELS.mode, labels);
    if (!choice) return;
    const index = labels.indexOf(choice);
    if (index >= 0) selected = MESSAGE_MODES[index];
  } else {
    ui.notify("Invalid. Use: steer or queue", "error");
    return;
  }
  if (!selected) return;
  const next: TelegramConfig = { ...config, messageMode: selected };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.mode} set to ${selected}`, "info");
}

async function pickRenderLevel(ui: MenuUi, title: string, current: TelegramRenderLevel): Promise<TelegramRenderLevel | undefined> {
  const labels = [...RENDER_LEVELS].map((v) => (v === current ? `● ${v}` : `  ${v}`));
  const choice = await ui.select(title, labels);
  if (!choice) return undefined;
  const idx = labels.indexOf(choice);
  if (idx < 0 || idx >= RENDER_LEVELS.length) return undefined;
  return RENDER_LEVELS[idx];
}