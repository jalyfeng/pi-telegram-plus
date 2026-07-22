import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { encodeUiCallback } from "./callback-protocol.ts";
import { bridgeCustomDialog } from "./custom-dialogs.ts";
import { escapeHtml } from "./html.ts";
import type { CapturedAgentSession, PendingInputResolver, TelegramTransport } from "./types.ts";

const MAX_BUTTON_TEXT = 60;
const PAGE_SIZE = 10;
const INPUT_TIMEOUT_MS = 10 * 60 * 1000;

type Pending = { flowId: string; resolve: PendingInputResolver; timer: NodeJS.Timeout; sensitive: boolean; acceptsText: boolean; promptMessageId?: number };

function truncateLabel(text: string): string { return text.length <= MAX_BUTTON_TEXT ? text : text.slice(0, MAX_BUTTON_TEXT - 1) + "…"; }

export type TelegramUiRuntime = {
  create(chatId: number, messageThreadId?: number, sourceMessageId?: number): ExtensionUIContext & { chatId: number; messageThreadId?: number; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  resolveInput(chatId: number, value: string | boolean | undefined, replyToMessageId?: number, fromCallback?: boolean, messageThreadId?: number): { handled: boolean; promptMessageId?: number };
  isSensitiveInput(chatId: number, replyToMessageId?: number, messageThreadId?: number): boolean;
  hasPendingInput(chatId: number, messageThreadId?: number): boolean;
  dispose(): void;
};

export function createTelegramUiRuntime(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  onPendingInputChange?: (chatId: number) => void;
}): TelegramUiRuntime {
  const pendingByTarget = new Map<string, Map<string, Pending>>();
  // Per-flow replace targets prevent rapid callbacks from overwriting each other.
  const replaceNextMessageByFlow = new Map<string, number>();
  const latestTextFlow = new Map<string, string>();
  const latestFlow = new Map<string, string>();
  let nextFlowId = 1;

  const targetKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  const flows = (chatId: number, messageThreadId?: number) => {
    const key = targetKey(chatId, messageThreadId);
    let map = pendingByTarget.get(key);
    if (!map) { map = new Map(); pendingByTarget.set(key, map); }
    return map;
  };
  const clearFlow = (chatId: number, messageThreadId: number | undefined, flowId: string) => {
    const key = targetKey(chatId, messageThreadId);
    const map = pendingByTarget.get(key); const pending = map?.get(flowId);
    if (pending) clearTimeout(pending.timer);
    map?.delete(flowId);
    if (latestTextFlow.get(key) === flowId) latestTextFlow.delete(key);
    if (latestFlow.get(key) === flowId) latestFlow.delete(key);
    if (map && map.size === 0) pendingByTarget.delete(key);
    if (pending) deps.onPendingInputChange?.(chatId);
  };
  const beginFlow = () => String(nextFlowId++);
  const waitInput = (chatId: number, messageThreadId: number | undefined, flowId: string, sensitive = false, acceptsText = true, promptMessageId?: number) =>
    new Promise<string | boolean | undefined>((resolve) => {
      const timer = setTimeout(() => { if (flows(chatId, messageThreadId).has(flowId)) { clearFlow(chatId, messageThreadId, flowId); resolve(undefined); } }, INPUT_TIMEOUT_MS);
      flows(chatId, messageThreadId).set(flowId, { flowId, resolve, timer, sensitive, acceptsText, promptMessageId });
      const key = targetKey(chatId, messageThreadId);
      latestFlow.set(key, flowId);
      if (acceptsText) latestTextFlow.set(key, flowId);
      deps.onPendingInputChange?.(chatId);
    });
  const cb = (flowId: string, value: string) => encodeUiCallback(`f:${flowId}:${value}`);
  const getReplaceIdForFlow = (flowId: string | undefined): number | undefined => {
    if (!flowId) return undefined;
    const id = replaceNextMessageByFlow.get(flowId);
    if (id !== undefined) replaceNextMessageByFlow.delete(flowId);
    return id;
  };
  const sendOrReplaceText = async (chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined, text: string, flowId?: string) => {
    const replaceId = getReplaceIdForFlow(flowId);
    if (replaceId !== undefined) {
      await deps.transport.editText(chatId, replaceId, text);
      return { message_id: replaceId };
    }
    const [sent] = await deps.transport.sendText(chatId, text, messageThreadId, sourceMessageId);
    return sent;
  };
  const sendOrReplaceButtons = async (chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined, text: string, rows: { text: string; value: string }[][], flowId?: string) => {
    const replaceId = getReplaceIdForFlow(flowId);
    if (replaceId !== undefined) {
      await deps.transport.editButtons(chatId, replaceId, text, rows);
      return { message_id: replaceId };
    }
    return deps.transport.sendButtons(chatId, text, rows, messageThreadId, sourceMessageId);
  };

  /** Track the currently active flow for each chat/thread (for sendOrReplace lookups). */
  const activeFlowByTarget = new Map<string, string>();

  return {
    create(chatId, messageThreadId, sourceMessageId) {
      // base is the real TUI UI context (create() is called BEFORE runWithTelegramUi
      // swaps the UI context, so this is the genuine TUI context). We forward persistent
      // /stateful methods to base so the TUI stays accurate even when the trigger came
      // from Telegram. Interactive modals stay Telegram-only; editor ops are no-ops.
      const base = deps.getSession()?.extensionRunner.getUIContext?.() as ExtensionUIContext | undefined;
      const target = targetKey(chatId, messageThreadId);

      const notifyFn = (message: string, level: "info" | "warning" | "error" = "info") => {
        const fid = activeFlowByTarget.get(target);
        void sendOrReplaceText(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(String(level))}</b>\n${escapeHtml(message)}`, fid);
      };

      return {
        chatId,
        messageThreadId,

        // ---- Interactive modals: Telegram-only (do NOT forward to base) ----
        // Plan Layer A: "谁触发的 turn 就给谁". A Telegram-triggered turn must NOT
        // also pop the modal in the local TUI, because ExtensionUIContext.custom and
        // the other modals expose no external cancel handle — once the Telegram side
        // resolves, any TUI-side component we mounted could never be dismissed, so
        // the local TUI would stay "stuck at the selection". Local TUI turns never
        // enter runWithTelegramUi, so they keep using the real TUI UIContext and are
        // completely unaffected by this Telegram-only path.
        notify: notifyFn,
        confirm: async (title, message) => {
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`, [[
            { text: "Yes", value: cb(flowId, "yes") }, { text: "No", value: cb(flowId, "no") }, { text: "Cancel", value: cb(flowId, "cancel") },
          ]], flowId);
          const value = await waitInput(chatId, messageThreadId, flowId, false, false, sent.message_id);
          activeFlowByTarget.delete(target);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return value === true || value === "yes";
        },
        input: async (title, placeholder) => {
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, messageThreadId, flowId, false, true, sent.message_id);
          activeFlowByTarget.delete(target);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        inputSecret: async (title: string, placeholder?: string) => {
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, messageThreadId, flowId, true, true, sent.message_id);
          activeFlowByTarget.delete(target);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        editor: async (title, prefill) => {
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(title)}</b>${prefill ? `\n${escapeHtml(prefill)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, messageThreadId, flowId, false, true, sent.message_id);
          activeFlowByTarget.delete(target);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        select: async (title, options) => {
          if (options.length === 0) return undefined;
          let page = 0; const pageCount = Math.ceil(options.length / PAGE_SIZE); const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          while (true) {
            const start = page * PAGE_SIZE; const pageOptions = options.slice(start, start + PAGE_SIZE);
            const rows = pageOptions.map((label, i) => [{ text: truncateLabel(label), value: cb(flowId, `s:${start + i}`) }]);
            const nav = [];
            if (page > 0) nav.push({ text: "◀ Prev", value: cb(flowId, `p:${page - 1}`) });
            if (page < pageCount - 1) nav.push({ text: "Next ▶", value: cb(flowId, `p:${page + 1}`) });
            nav.push({ text: "Cancel", value: cb(flowId, "cancel") }); rows.push(nav);
            const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
            const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(title + suffix)}</b>`, rows, flowId);
            const value = await waitInput(chatId, messageThreadId, flowId, false, false, sent.message_id);
            if (typeof value !== "string") { activeFlowByTarget.delete(target); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return undefined; }
            if (value === "cancel") { activeFlowByTarget.delete(target); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return undefined; }
            if (value.startsWith("p:")) { const next = parseInt(value.slice(2), 10); if (next >= 0 && next < pageCount) page = next; continue; }
            if (value.startsWith("s:")) { const idx = parseInt(value.slice(2), 10); activeFlowByTarget.delete(target); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return idx >= 0 && idx < options.length ? options[idx] : undefined; }
            if (options.includes(value)) { activeFlowByTarget.delete(target); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return value; }
            activeFlowByTarget.delete(target);
            void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
            return undefined;
          }
        },
        // custom: bridge pi-goal dialogs to Telegram buttons (Layer B). Does NOT
        // forward to base — see the modals comment above for why racing the TUI is
        // structurally un-dismissible and would leave the local TUI stuck.
        custom: async <T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any | Promise<any>, _options?: any): Promise<T> => {
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          let promptMessageId: number | undefined;
          const result = await bridgeCustomDialog<T>({
            factory,
            theme: base?.theme,
            width: 80,
            sendButtons: async (text, rows) => {
              const encodedRows = rows.map((row) => row.map((btn) => ({ text: btn.text, value: cb(flowId, btn.value) })));
              const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, text, encodedRows, flowId);
              promptMessageId = sent.message_id;
              return sent;
            },
            waitInput: (acceptsText = false, sensitive = false) =>
              waitInput(chatId, messageThreadId, flowId, sensitive, acceptsText, promptMessageId),
            notify: notifyFn,
            removeKeyboard: async () => { if (promptMessageId) await deps.transport.removeInlineKeyboard(chatId, promptMessageId); },
          });
          activeFlowByTarget.delete(target);
          // pi-goal accesses result.cancelled/answers without an undefined-guard, so
          // never resolve undefined: fall back to a structured cancelled result.
          return (result ?? ({ questions: [], answers: [], cancelled: true } as unknown as T)) as T;
        },

        // ---- Persistent/stateful UI: forward to TUI base (keeps TUI accurate) ----
        setStatus: (key: string, text: string | undefined) => { base?.setStatus?.(key, text); },
        setWorkingMessage: (message?: string) => { base?.setWorkingMessage?.(message); },
        setWorkingVisible: (visible: boolean) => { base?.setWorkingVisible?.(visible); },
        setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => { base?.setWorkingIndicator?.(options); },
        setHiddenThinkingLabel: (label?: string) => { base?.setHiddenThinkingLabel?.(label); },
        setWidget: ((key: string, content: unknown, options?: unknown) => { base?.setWidget?.(key as string, content as any, options as any); }) as ExtensionUIContext["setWidget"],
        setFooter: (factory: unknown) => { base?.setFooter?.(factory as any); },
        setHeader: (factory: unknown) => { base?.setHeader?.(factory as any); },
        setTitle: (title: string) => { base?.setTitle?.(title); },
        setToolsExpanded: (expanded: boolean) => { base?.setToolsExpanded?.(expanded); },
        getToolsExpanded: () => base?.getToolsExpanded?.() ?? false,
        setTheme: (theme: string | unknown) => base?.setTheme?.(theme as any) ?? { success: false, error: "UI not available" },
        getTheme: (name: string) => base?.getTheme?.(name),
        getAllThemes: () => base?.getAllThemes?.() ?? [],

        // ---- Editor/terminal: no-ops (remote turns must not touch local editor) ----
        onTerminalInput: () => () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        setEditorComponent: () => {},
        getEditorComponent: () => undefined,
        addAutocompleteProvider: () => {},

        // ---- Theme getter: delegate to base (factory needs theme.fg/bg) ----
        // base is always defined when create() runs (create() is called before the
        // runWithTelegramUi UI swap, per plan §2.1). The non-null assertion makes
        // this precondition explicit instead of hiding it behind a cast.
        get theme() { return base!.theme; },
      };
    },
    resolveInput(chatId, raw, replyToMessageId, fromCallback = false, messageThreadId) {
      const key = targetKey(chatId, messageThreadId);
      let flowId: string | undefined; let value = raw;
      if (fromCallback && typeof raw === "string" && raw.startsWith("f:")) {
        const [, id, ...rest] = raw.split(":"); flowId = id; const inner = rest.join(":");
        value = inner === "yes" ? true : inner === "no" ? false : inner === "cancel" ? undefined : inner;
      } else {
        const map = pendingByTarget.get(key);
        const isCancel = raw === undefined;
        if (replyToMessageId) {
          flowId = map ? [...map.values()].find((p) =>
            p.promptMessageId === replyToMessageId && (isCancel || p.acceptsText)
          )?.flowId : undefined;
          if (!flowId) return { handled: false };
        } else {
          flowId = isCancel ? latestFlow.get(key) : latestTextFlow.get(key);
        }
      }
      if (!flowId) return { handled: false };
      const pending = pendingByTarget.get(key)?.get(flowId); if (!pending) return { handled: false };
      if (fromCallback) {
        if (replyToMessageId !== pending.promptMessageId) return { handled: false };
      } else if (raw !== undefined && !pending.acceptsText) return { handled: false };
      clearFlow(chatId, messageThreadId, flowId);
      // Store the per-flow replace target after clearing, so subsequent sendOrReplace* calls
      // (e.g. pagination, notify) can edit the message instead of sending a new one.
      if (fromCallback && replyToMessageId !== undefined) replaceNextMessageByFlow.set(flowId, replyToMessageId);
      pending.resolve(value); return { handled: true, promptMessageId: pending.promptMessageId };
    },
    isSensitiveInput(chatId, replyToMessageId, messageThreadId) {
      const key = targetKey(chatId, messageThreadId);
      const map = pendingByTarget.get(key); if (!map) return false;
      if (replyToMessageId) {
        const exact = [...map.values()].find((p) => p.acceptsText && p.promptMessageId === replyToMessageId);
        return exact?.sensitive === true;
      }
      const latest = latestTextFlow.get(key);
      return latest ? map.get(latest)?.sensitive === true : false;
    },
    hasPendingInput(chatId, messageThreadId) {
      return (pendingByTarget.get(targetKey(chatId, messageThreadId))?.size ?? 0) > 0;
    },
    dispose() {
      for (const map of pendingByTarget.values()) {
        for (const pending of map.values()) {
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
      }
      pendingByTarget.clear();
      replaceNextMessageByFlow.clear();
      latestTextFlow.clear();
      latestFlow.clear();
      activeFlowByTarget.clear();
    },
  };
}