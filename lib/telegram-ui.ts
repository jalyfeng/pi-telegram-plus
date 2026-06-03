import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { encodeUiCallback } from "./callback-protocol.ts";
import { escapeHtml } from "./html.ts";
import type { CapturedAgentSession, PendingInputResolver, TelegramTransport } from "./types.ts";

const MAX_BUTTON_TEXT = 60;
const PAGE_SIZE = 10;
const INPUT_TIMEOUT_MS = 10 * 60 * 1000;

type Pending = { flowId: string; resolve: PendingInputResolver; timer: NodeJS.Timeout; sensitive: boolean; acceptsText: boolean; promptMessageId?: number };

function truncateLabel(text: string): string { return text.length <= MAX_BUTTON_TEXT ? text : text.slice(0, MAX_BUTTON_TEXT - 1) + "…"; }

export type TelegramUiRuntime = {
  create(chatId: number): ExtensionUIContext & { chatId: number; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  resolveInput(chatId: number, value: string | boolean | undefined, replyToMessageId?: number, fromCallback?: boolean): { handled: boolean; promptMessageId?: number };
  isSensitiveInput(chatId: number, replyToMessageId?: number): boolean;
  hasPendingInput(chatId: number): boolean;
  dispose(): void;
};

export function createTelegramUiRuntime(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  onPendingInputChange?: (chatId: number) => void;
}): TelegramUiRuntime {
  const pendingByChat = new Map<number, Map<string, Pending>>();
  // Per-flow replace targets prevent rapid callbacks from overwriting each other.
  const replaceNextMessageByFlow = new Map<string, number>();
  const latestTextFlow = new Map<number, string>();
  const latestFlow = new Map<number, string>();
  let nextFlowId = 1;

  const flows = (chatId: number) => {
    let map = pendingByChat.get(chatId);
    if (!map) { map = new Map(); pendingByChat.set(chatId, map); }
    return map;
  };
  const clearFlow = (chatId: number, flowId: string) => {
    const map = pendingByChat.get(chatId); const pending = map?.get(flowId);
    if (pending) clearTimeout(pending.timer);
    map?.delete(flowId);
    if (latestTextFlow.get(chatId) === flowId) latestTextFlow.delete(chatId);
    if (latestFlow.get(chatId) === flowId) latestFlow.delete(chatId);
    if (map && map.size === 0) pendingByChat.delete(chatId);
    if (pending) deps.onPendingInputChange?.(chatId);
  };
  const beginFlow = () => String(nextFlowId++);
  const waitInput = (chatId: number, flowId: string, sensitive = false, acceptsText = true, promptMessageId?: number) =>
    new Promise<string | boolean | undefined>((resolve) => {
      const timer = setTimeout(() => { if (flows(chatId).has(flowId)) { clearFlow(chatId, flowId); resolve(undefined); } }, INPUT_TIMEOUT_MS);
      flows(chatId).set(flowId, { flowId, resolve, timer, sensitive, acceptsText, promptMessageId });
      latestFlow.set(chatId, flowId);
      if (acceptsText) latestTextFlow.set(chatId, flowId);
      deps.onPendingInputChange?.(chatId);
    });
  const cb = (flowId: string, value: string) => encodeUiCallback(`f:${flowId}:${value}`);
  const getReplaceIdForFlow = (chatId: number, flowId: string | undefined): number | undefined => {
    if (!flowId) return undefined;
    const id = replaceNextMessageByFlow.get(flowId);
    if (id !== undefined) replaceNextMessageByFlow.delete(flowId);
    return id;
  };
  const sendOrReplaceText = async (chatId: number, text: string, flowId?: string) => {
    const replaceId = getReplaceIdForFlow(chatId, flowId);
    if (replaceId !== undefined) {
      await deps.transport.editText(chatId, replaceId, text);
      return { message_id: replaceId };
    }
    const [sent] = await deps.transport.sendText(chatId, text);
    return sent;
  };
  const sendOrReplaceButtons = async (chatId: number, text: string, rows: { text: string; value: string }[][], flowId?: string) => {
    const replaceId = getReplaceIdForFlow(chatId, flowId);
    if (replaceId !== undefined) {
      await deps.transport.editButtons(chatId, replaceId, text, rows);
      return { message_id: replaceId };
    }
    return deps.transport.sendButtons(chatId, text, rows);
  };

  /** Track the currently active flow for each chat (for sendOrReplace lookups). */
  const activeFlowByChat = new Map<number, string>();

  return {
    create(chatId) {
      const base = deps.getSession()?.extensionRunner.getUIContext?.();
      return {
        ...(base as ExtensionUIContext),
        chatId,
        notify: (message, level = "info") => {
          const flowId = activeFlowByChat.get(chatId);
          void sendOrReplaceText(chatId, `<b>${escapeHtml(String(level))}</b>\n${escapeHtml(message)}`, flowId);
        },
        confirm: async (title, message) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`, [[
            { text: "Yes", value: cb(flowId, "yes") }, { text: "No", value: cb(flowId, "no") }, { text: "Cancel", value: cb(flowId, "cancel") },
          ]], flowId);
          const value = await waitInput(chatId, flowId, false, false, sent.message_id);
          activeFlowByChat.delete(chatId);
          return value === true || value === "yes";
        },
        input: async (title, placeholder) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, false, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          return typeof value === "string" ? value : undefined;
        },
        inputSecret: async (title: string, placeholder?: string) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, true, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          return typeof value === "string" ? value : undefined;
        },
        editor: async (title, prefill) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${prefill ? `\n${escapeHtml(prefill)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, false, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          return typeof value === "string" ? value : undefined;
        },
        select: async (title, options) => {
          if (options.length === 0) return undefined;
          let page = 0; const pageCount = Math.ceil(options.length / PAGE_SIZE); const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          while (true) {
            const start = page * PAGE_SIZE; const pageOptions = options.slice(start, start + PAGE_SIZE);
            const rows = pageOptions.map((label, i) => [{ text: truncateLabel(label), value: cb(flowId, `s:${start + i}`) }]);
            const nav = [];
            if (page > 0) nav.push({ text: "◀ Prev", value: cb(flowId, `p:${page - 1}`) });
            if (page < pageCount - 1) nav.push({ text: "Next ▶", value: cb(flowId, `p:${page + 1}`) });
            nav.push({ text: "Cancel", value: cb(flowId, "cancel") }); rows.push(nav);
            const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
            const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title + suffix)}</b>`, rows, flowId);
            const value = await waitInput(chatId, flowId, false, false, sent.message_id);
            if (typeof value !== "string") { activeFlowByChat.delete(chatId); return undefined; }
            if (value === "cancel") { activeFlowByChat.delete(chatId); return undefined; }
            if (value.startsWith("p:")) { const next = parseInt(value.slice(2), 10); if (next >= 0 && next < pageCount) page = next; continue; }
            if (value.startsWith("s:")) { const idx = parseInt(value.slice(2), 10); activeFlowByChat.delete(chatId); return idx >= 0 && idx < options.length ? options[idx] : undefined; }
            if (options.includes(value)) { activeFlowByChat.delete(chatId); return value; }
            activeFlowByChat.delete(chatId);
            return undefined;
          }
        },
      };
    },
    resolveInput(chatId, raw, replyToMessageId, fromCallback = false) {
      let flowId: string | undefined; let value = raw;
      if (fromCallback && typeof raw === "string" && raw.startsWith("f:")) {
        const [, id, ...rest] = raw.split(":"); flowId = id; const inner = rest.join(":");
        value = inner === "yes" ? true : inner === "no" ? false : inner === "cancel" ? undefined : inner;
      } else {
        const map = pendingByChat.get(chatId);
        const isCancel = raw === undefined;
        if (replyToMessageId) {
          flowId = map ? [...map.values()].find((p) =>
            p.promptMessageId === replyToMessageId && (isCancel || p.acceptsText)
          )?.flowId : undefined;
          if (!flowId) return { handled: false };
        } else {
          flowId = isCancel ? latestFlow.get(chatId) : latestTextFlow.get(chatId);
        }
      }
      if (!flowId) return { handled: false };
      const pending = pendingByChat.get(chatId)?.get(flowId); if (!pending) return { handled: false };
      if (fromCallback) {
        if (replyToMessageId !== pending.promptMessageId) return { handled: false };
      } else if (raw !== undefined && !pending.acceptsText) return { handled: false };
      clearFlow(chatId, flowId);
      // Store the per-flow replace target after clearing, so subsequent sendOrReplace* calls
      // (e.g. pagination, notify) can edit the message instead of sending a new one.
      if (fromCallback && replyToMessageId !== undefined) replaceNextMessageByFlow.set(flowId, replyToMessageId);
      pending.resolve(value); return { handled: true, promptMessageId: pending.promptMessageId };
    },
    isSensitiveInput(chatId, replyToMessageId) {
      const map = pendingByChat.get(chatId); if (!map) return false;
      if (replyToMessageId) {
        const exact = [...map.values()].find((p) => p.acceptsText && p.promptMessageId === replyToMessageId);
        return exact?.sensitive === true;
      }
      const latest = latestTextFlow.get(chatId);
      return latest ? map.get(latest)?.sensitive === true : false;
    },
    hasPendingInput(chatId) {
      return (pendingByChat.get(chatId)?.size ?? 0) > 0;
    },
    dispose() {
      for (const map of pendingByChat.values()) {
        for (const pending of map.values()) {
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
      }
      pendingByChat.clear();
      replaceNextMessageByFlow.clear();
      latestTextFlow.clear();
      latestFlow.clear();
      activeFlowByChat.clear();
    },
  };
}