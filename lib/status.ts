import type { TelegramStatusLevel } from "./types.ts";

const FILLED = "\u25CF";
const HOLLOW = "\u25CB";

export const TELEGRAM_STATUS_KEY = "telegram-plus";

export type StatusLineTheme = {
  fg(token: "accent" | "error" | "muted" | "warning" | "success", text: string): string;
};

export type StatusLineUi = {
  theme: StatusLineTheme;
  setStatus(key: string, text: string | undefined): void;
};

export function formatTelegramStatusLine(
  theme: StatusLineTheme,
  state: {
    hasBotToken: boolean;
    pollingActive: boolean;
    paired: boolean;
    processing?: boolean;
    error?: string;
    botUsername?: string;
  },
  level?: TelegramStatusLevel,
): string | undefined {
  if (level === "hidden") return undefined;
  const label = theme.fg("accent", level === "minimal" ? "tg+" : "telegram+");
  if (state.error) {
    return `${label} ${theme.fg("error", FILLED)} ${theme.fg("muted", state.error)}`;
  }
  if (!state.hasBotToken) {
    return `${label} ${theme.fg("muted", "not configured")}`;
  }
  if (!state.pollingActive) {
    return `${label} ${theme.fg("muted", HOLLOW)}`;
  }
  if (!state.paired) {
    return `${label} ${theme.fg("warning", "awaiting pairing")}`;
  }
  const bot = level === "brief" || level === "minimal" ? "" : state.botUsername ? ` @${state.botUsername}` : "";
  if (state.processing) {
    return `${label} ${theme.fg("warning", "active")}${bot}`;
  }
  return `${label} ${theme.fg("success", FILLED)}${bot}`;
}

export function clearTelegramStatus(ctx: { ui?: StatusLineUi }): void {
  if (!ctx?.ui?.setStatus) return;
  ctx.ui.setStatus(TELEGRAM_STATUS_KEY, undefined);
}
