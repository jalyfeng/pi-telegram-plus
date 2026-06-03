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
): string {
  const label = theme.fg("accent", "telegram+");
  if (state.error) {
    return `${label} ${theme.fg("error", "error")} ${theme.fg("muted", state.error)}`;
  }
  if (!state.hasBotToken) {
    return `${label} ${theme.fg("muted", "not configured")}`;
  }
  if (!state.pollingActive) {
    return `${label} ${theme.fg("muted", "disconnected")}`;
  }
  if (!state.paired) {
    return `${label} ${theme.fg("warning", "awaiting pairing")}`;
  }
  const bot = state.botUsername ? ` @${state.botUsername}` : "";
  if (state.processing) {
    return `${label} ${theme.fg("warning", "active")}${bot}`;
  }
  return `${label} ${theme.fg("success", "connected")}${bot}`;
}

export function clearTelegramStatus(ctx: { ui?: StatusLineUi }): void {
  if (!ctx?.ui?.setStatus) return;
  ctx.ui.setStatus(TELEGRAM_STATUS_KEY, undefined);
}