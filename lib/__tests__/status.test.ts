import { describe, expect, it } from "vitest";
import { formatTelegramStatusLine, TELEGRAM_STATUS_KEY } from "../status.ts";
import type { StatusLineTheme } from "../status.ts";

const theme: StatusLineTheme = {
  fg: (token, text) => `[${token}]${text}[/${token}]`,
};

describe("formatTelegramStatusLine", () => {
  it("shows error state", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      error: "timeout",
    });
    expect(result).toContain("timeout");
    expect(result).toContain("[error]");
  });

  it("shows 'not configured' without bot token", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: false,
      pollingActive: false,
      paired: false,
    });
    expect(result).toContain("not configured");
  });

  it("shows 'disconnected' when not polling", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: false,
    });
    expect(result).toContain("disconnected");
  });

  it("shows 'awaiting pairing' when not paired", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: false,
    });
    expect(result).toContain("awaiting pairing");
  });

  it("shows 'active' when processing", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      processing: true,
    });
    expect(result).toContain("active");
    expect(result).toContain("[warning]");
  });

  it("shows 'connected' when idle", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      processing: false,
    });
    expect(result).toContain("connected");
    expect(result).toContain("[success]");
  });

  it("includes bot username when provided", () => {
    const result = formatTelegramStatusLine(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      botUsername: "mybot",
    });
    expect(result).toContain("@mybot");
  });
});

describe("TELEGRAM_STATUS_KEY", () => {
  it("is 'telegram-plus'", () => {
    expect(TELEGRAM_STATUS_KEY).toBe("telegram-plus");
  });
});