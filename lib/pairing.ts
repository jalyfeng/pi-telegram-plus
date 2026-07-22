import { randomInt } from "node:crypto";
import type { TelegramConfig } from "./types.ts";

export type TelegramAuthorizationDecision = {
  authorized: boolean;
  paired: boolean;
  config: TelegramConfig;
};

export function createTelegramPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function ensureTelegramPairingCode(config: TelegramConfig): TelegramConfig {
  if (config.allowedUserId !== undefined) {
    const { pairingCode: _pairingCode, ...rest } = config;
    return rest;
  }
  if (config.pairingCode) return config;
  return { ...config, pairingCode: createTelegramPairingCode() };
}

export function extractTelegramPairingCode(text: string | undefined, botUsername?: string): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^\/pair(?:@([A-Za-z0-9_]+))?\s+([A-Za-z0-9_-]+)$/i);
  if (!match) return undefined;
  const addressedBot = match[1];
  if (addressedBot && botUsername && addressedBot.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return match[2];
}

export function authorizeTelegramUser(
  config: TelegramConfig,
  userId: number | undefined,
  text?: string,
  botUsername?: string,
): TelegramAuthorizationDecision {
  if (userId === undefined) return { authorized: false, paired: false, config };
  if (config.allowedUserId !== undefined) {
    return { authorized: config.allowedUserId === userId, paired: false, config };
  }
  const pairingCode = extractTelegramPairingCode(text, botUsername);
  if (config.pairingCode && pairingCode === config.pairingCode) {
    const { pairingCode: _pairingCode, ...rest } = config;
    return { authorized: true, paired: true, config: { ...rest, allowedUserId: userId } };
  }
  return { authorized: false, paired: false, config };
}

export function formatPairingInstructions(config: TelegramConfig): string {
  if (config.allowedUserId !== undefined) return "Telegram user is already paired.";
  if (!config.pairingCode) return "Telegram pairing is required, but no pairing code is available.";
  return `Telegram pairing required. Send this message to the bot from your Telegram account:\n/pair ${config.pairingCode}`;
}
