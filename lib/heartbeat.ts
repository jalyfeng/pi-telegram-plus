import { formatTelegramStatusLine } from "./status.ts";
import type { TelegramConfig, TelegramTurn } from "./types.ts";
import { log } from "./logger.ts";

const heartbeatLog = log.child("heartbeat");

const TYPING_REFRESH_MS = 4000;
const HEARTBEAT_MS = 2000;

export type StatusState = Parameters<typeof formatTelegramStatusLine>[1];

export type HeartbeatDeps = {
  getConfig: () => TelegramConfig;
  getActiveTurns: () => TelegramTurn[];
  sendChatAction: (chatId: number, action: string, messageThreadId?: number) => Promise<void>;
  ensurePollingStarted: () => void;
};

export function createHeartbeat(deps: HeartbeatDeps) {
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingInFlight = false;
  let typingGeneration = 0;

  const turnKey = (turn: TelegramTurn): string => `${turn.chatId}:${turn.messageThreadId ?? "main"}`;

  const sendTypingPulse = async (generation: number): Promise<void> => {
    const turns = deps.getActiveTurns();
    if (turns.length === 0 || typingInFlight || generation !== typingGeneration) return;
    typingInFlight = true;
    try {
      const activeTurnKeys = new Set(deps.getActiveTurns().map(turnKey));
      await Promise.all(turns
        .filter((turn) => generation === typingGeneration && activeTurnKeys.has(turnKey(turn)))
        .map((turn) => deps.sendChatAction(turn.chatId, "typing", turn.messageThreadId)));
    } catch (err) {
      // Non-critical: the next pulse can retry while the turn is still processing.
      heartbeatLog.debug("typing pulse sendChatAction failed", { err });
    } finally {
      typingInFlight = false;
    }
  };

  const stopTyping = (): void => {
    typingGeneration++;
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = undefined;
  };

  const syncTypingWithStatus = (state: StatusState): void => {
    const turns = deps.getActiveTurns();
    // Typing strictly mirrors activeTurns.size > 0 — the same condition
    // that drives the TUI [Working...] status.
    const shouldType = state.processing && turns.length > 0;
    if (!shouldType) {
      stopTyping();
      return;
    }
    const generation = typingGeneration;
    void sendTypingPulse(generation);
    if (!typingTimer) {
      typingTimer = setInterval(() => void sendTypingPulse(generation), TYPING_REFRESH_MS);
    }
  };

  const refreshStatus = (state: StatusState): void => {
    // Called by the outer module which sets the TUI status line.
    // We only sync typing from here.
    syncTypingWithStatus(state);
  };

  const startStatusHeartbeat = (onHeartbeat: () => void): void => {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      deps.ensurePollingStarted();
      onHeartbeat();
    }, HEARTBEAT_MS);
  };

  const stopStatusHeartbeat = (): void => {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = undefined;
  };

  const dispose = (): void => {
    stopStatusHeartbeat();
    stopTyping();
  };

  return {
    refreshStatus,
    syncTypingWithStatus,
    startStatusHeartbeat,
    stopStatusHeartbeat,
    stopTyping,
    dispose,
    /** Expose for external clearStatus which stops typing then clears the TUI line. */
    stopTypingOnly: stopTyping,
  };
}