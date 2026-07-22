import { AsyncLocalStorage } from "node:async_hooks";
import type { TelegramTurn } from "./types.ts";

const telegramTurnStorage = new AsyncLocalStorage<TelegramTurn>();

export function getCurrentTelegramTurn(): TelegramTurn | undefined {
  return telegramTurnStorage.getStore();
}

export function runWithTelegramTurn<T>(turn: TelegramTurn, run: () => T): T {
  return telegramTurnStorage.run(turn, run);
}
