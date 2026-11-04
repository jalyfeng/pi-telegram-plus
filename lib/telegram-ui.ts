import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { routeCommandNotice } from "./tui/command-context.ts";
import { encodeUiCallback } from "./callback-protocol.ts";
import { escapeHtml } from "./html.ts";
import { log } from "./logger.ts";
import { hostUiBehindRouted } from "./pi-compat.ts";
import type { SecretStore } from "./tui/secrets.ts";
import type { CapturedAgentSession, PendingInputResolver, TelegramButton, TelegramTransport } from "./types.ts";

const uiLog = log.child("telegram-ui");

const MAX_BUTTON_TEXT = 60;
const PAGE_SIZE = 10;
const INPUT_TIMEOUT_MS = 10 * 60 * 1000;

type Pending = { flowId: string; resolve: PendingInputResolver; timer: NodeJS.Timeout; sensitive: boolean; acceptsText: boolean; promptMessageId?: number };

function truncateLabel(text: string): string { return text.length <= MAX_BUTTON_TEXT ? text : text.slice(0, MAX_BUTTON_TEXT - 1) + "…"; }

/** The UI context handed to one Telegram-originated flow. */
export type TelegramUiContext = ExtensionUIContext & {
  chatId: number;
  messageThreadId?: number;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  /** Like select, but successive menu() calls edit one message in place (nested menus).
   *  The optional body is text shown under the title on that same message. */
  menu: (title: string, options: string[], body?: string) => Promise<string | undefined>;
  /** Remove the keyboard from the live menu message (call when the menu exits). */
  closeMenu: () => Promise<void>;
  /** Id of the live menu message, while its keyboard is still attached. */
  menuMessageId: () => number | undefined;
};

export type TelegramUiRuntime = {
  /** onMenuMessage is told the id of the menu message each time menu() sends or edits it.
   *  onConfirmMessage is told the id of the message confirm() sends, before it waits. */
  create(chatId: number, messageThreadId?: number, sourceMessageId?: number, onMenuMessage?: (messageId: number) => void, onConfirmMessage?: (messageId: number) => void): TelegramUiContext;
  resolveInput(chatId: number, value: string | boolean | undefined, replyToMessageId?: number, fromCallback?: boolean, messageThreadId?: number): { handled: boolean; promptMessageId?: number };
  isSensitiveInput(chatId: number, replyToMessageId?: number, messageThreadId?: number): boolean;
  hasPendingInput(chatId: number, messageThreadId?: number): boolean;
  dispose(): void;
};

export function createTelegramUiRuntime(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  onPendingInputChange?: (chatId: number) => void;
  secrets?: SecretStore;
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

  /** Telegram text of a page: the bold title, the body, then the notices of the live menu. */
  const pageText = (title: string, body: string | undefined, notices: string[]) => {
    const parts = [`<b>${escapeHtml(title)}</b>`];
    if (body) parts.push(escapeHtml(body));
    if (notices.length > 0) parts.push(notices.map((notice) => escapeHtml(notice)).join("\n"));
    return parts.join("\n\n");
  };

  /** Track the currently active flow for each chat/thread (for sendOrReplace lookups). */
  const activeFlowByTarget = new Map<string, string>();

  /** `body` is plain text (already redacted by the caller); it sits under the title. */
  const buildSelectPage = (flowId: string, title: string, options: string[], page: number, body?: string) => {
    const pageCount = Math.ceil(options.length / PAGE_SIZE);
    const start = page * PAGE_SIZE; const pageOptions = options.slice(start, start + PAGE_SIZE);
    const rows = pageOptions.map((label, i) => [{ text: truncateLabel(label), value: cb(flowId, `s:${start + i}`) }]);
    const nav = [];
    if (page > 0) nav.push({ text: "◀ Prev", value: cb(flowId, `p:${page - 1}`) });
    if (page < pageCount - 1) nav.push({ text: "Next ▶", value: cb(flowId, `p:${page + 1}`) });
    nav.push({ text: "Cancel", value: cb(flowId, "cancel") }); rows.push(nav);
    const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
    return { title: title + suffix, body, rows, pageCount };
  };

  return {
    create(chatId, messageThreadId, sourceMessageId, onMenuMessage, onConfirmMessage) {
      // base is the real TUI UI context (create() is called BEFORE runWithTelegramUi
      // swaps the UI context, so this is the genuine TUI context). We forward persistent
      // /stateful methods to base so the TUI stays accurate even when the trigger came
      // from Telegram. Interactive modals stay Telegram-only; editor ops are no-ops.
      // While another Telegram turn holds the swap, getUIContext() returns that turn's
      // dispatch wrapper, not the TUI: unwrap it so reads of `base` never route back here.
      const base = hostUiBehindRouted(deps.getSession()?.extensionRunner.getUIContext?.()) as ExtensionUIContext | undefined;
      const target = targetKey(chatId, messageThreadId);
      // Caller-provided text is redacted BEFORE HTML escaping: a secret this
      // chat typed must never leak through plugin notices or prompts (§4.7.4).
      const redact = (text: string) => deps.secrets?.redact(target, text) ?? text;
      const notifyFn = (message: string, level: "info" | "warning" | "error" = "info") => {
        // Inside a command's call chain the line belongs to that command's message
        // (one command, one message); otherwise it is a message of its own.
        const prefix = level === "error" ? "❌ " : level === "warning" ? "⚠️ " : "";
        const line = `${prefix}${redact(message)}`;
        if (routeCommandNotice(escapeHtml(line))) return;
        if (menuMessageId !== undefined) {
          // A live /tg menu keeps the result on its own message, under the page.
          menuNotices.push(line);
          if (menuView) void drawMenu(menuView.title, menuView.body, menuView.rows).catch(uiLog.swallow("warn", "notice on menu message failed", { chatId }));
          return;
        }
        const fid = activeFlowByTarget.get(target);
        void sendOrReplaceText(chatId, messageThreadId, sourceMessageId, escapeHtml(line), fid);
      };

      // Live menu message (keyboard still attached). While it is live, the menu's
      // whole flow stays on it: successive menu() calls, the prompts, selects and
      // confirms of this UI, and the notices they report are all drawn on that one
      // message (edited in place). Notices stay under the page until the user answers.
      let menuMessageId: number | undefined;
      /** The last page drawn on the menu message (title, body, keyboard). */
      let menuView: { title: string; body?: string; rows: TelegramButton[][] } | undefined;
      /** Notices drawn under the menu page; cleared when the user answers. */
      let menuNotices: string[] = [];
      /** Menu-message edits run one after another, so the last page drawn is the last one sent. */
      let menuWrites: Promise<void> = Promise.resolve();
      const drawMenu = (title: string, body: string | undefined, rows: TelegramButton[][]): Promise<void> => {
        const id = menuMessageId;
        if (id === undefined) return Promise.resolve();
        menuView = { title, body, rows };
        const text = pageText(title, body, menuNotices);
        menuWrites = menuWrites.catch(() => undefined).then(() => deps.transport.editButtons(chatId, id, text, rows));
        return menuWrites;
      };
      const releaseMenu = () => {
        if (menuMessageId === undefined) return;
        const id = menuMessageId; menuMessageId = undefined; menuView = undefined; menuNotices = [];
        void deps.transport.removeInlineKeyboard(chatId, id);
      };
      /** A prompt answered on the menu message: its keyboard goes, its text stays. The
       *  answer's own line (if any) becomes the only notice; the earlier notices are answered. */
      const settleMenuAnswer = (answerLine?: string) => {
        menuNotices = answerLine === undefined ? [] : [answerLine];
        if (menuView) void drawMenu(menuView.title, menuView.body, []).catch(uiLog.swallow("warn", "settling menu prompt failed", { chatId }));
      };

      /** One text or button prompt. On a live menu it is drawn on the menu message; otherwise it is a message of its own. */
      const prompt = async (
        flowId: string,
        legacyText: string,
        title: string,
        body: string | undefined,
        rows: TelegramButton[][],
        sensitive: boolean,
        acceptsText: boolean,
        onShown?: (messageId: number) => void,
        answerLine?: (value: string | boolean | undefined) => string | undefined,
      ) => {
        activeFlowByTarget.set(target, flowId);
        let promptMessageId: number;
        if (menuMessageId !== undefined) {
          await drawMenu(title, body, rows);
          promptMessageId = menuMessageId;
        } else {
          promptMessageId = (await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, legacyText, rows, flowId)).message_id;
        }
        onShown?.(promptMessageId);
        const value = await waitInput(chatId, messageThreadId, flowId, sensitive, acceptsText, promptMessageId);
        activeFlowByTarget.delete(target);
        if (menuMessageId !== undefined && promptMessageId === menuMessageId) settleMenuAnswer(answerLine?.(value));
        else void deps.transport.removeInlineKeyboard(chatId, promptMessageId);
        return value;
      };
      const cancelRow = (flowId: string): TelegramButton[][] => [[{ text: "Cancel", value: cb(flowId, "cancel") }]];

      const created: TelegramUiContext = {
        chatId,
        messageThreadId,

        // ---- Interactive modals: Telegram-only (do NOT forward to base) ----
        // A Telegram-triggered turn must not also pop the modal in the local TUI: the
        // host modals expose no external cancel handle, so a component mounted here
        // could never be dismissed once Telegram answered. When the broker owns the
        // dialogs the host's own UI context is installed instead (promptUiMode), so
        // those prompts never run through this object. Local terminal turns never
        // enter it either.
        notify: notifyFn,
        confirm: async (title, message) => {
          const flowId = beginFlow();
          const value = await prompt(
            flowId,
            `<b>${escapeHtml(redact(title))}</b>\n${escapeHtml(redact(message))}`,
            redact(title), redact(message),
            [[{ text: "Yes", value: cb(flowId, "yes") }, { text: "No", value: cb(flowId, "no") }]],
            false, false,
            (messageId) => onConfirmMessage?.(messageId),
            (answer) => (answer === true ? "✅ Yes" : answer === false ? "❌ No" : undefined),
          );
          return value === true || value === "yes";
        },
        input: async (title, placeholder) => {
          const flowId = beginFlow();
          const value = await prompt(
            flowId,
            `<b>${escapeHtml(redact(title))}</b>${placeholder ? `\n${escapeHtml(redact(placeholder))}` : ""}`,
            redact(title), placeholder ? redact(placeholder) : undefined,
            cancelRow(flowId), false, true,
          );
          return typeof value === "string" ? value : undefined;
        },
        inputSecret: async (title: string, placeholder?: string) => {
          const flowId = beginFlow();
          const value = await prompt(
            flowId,
            `<b>${escapeHtml(redact(title))}</b>${placeholder ? `\n${escapeHtml(redact(placeholder))}` : ""}`,
            redact(title), placeholder ? redact(placeholder) : undefined,
            cancelRow(flowId), true, true,
          );
          if (typeof value === "string") deps.secrets?.remember(target, flowId, value);
          return typeof value === "string" ? value : undefined;
        },
        editor: async (title, prefill) => {
          releaseMenu();
          const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          const sent = await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, `<b>${escapeHtml(redact(title))}</b>${prefill ? `\n${escapeHtml(redact(prefill))}` : ""}`, cancelRow(flowId), flowId);
          const value = await waitInput(chatId, messageThreadId, flowId, false, true, sent.message_id);
          activeFlowByTarget.delete(target);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        select: async (title, options) => {
          if (options.length === 0) return undefined;
          let page = 0; const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          while (true) {
            const built = buildSelectPage(flowId, redact(title), options.map(redact), page);
            let messageId: number;
            if (menuMessageId !== undefined) {
              await drawMenu(built.title, undefined, built.rows);
              messageId = menuMessageId;
            } else {
              messageId = (await sendOrReplaceButtons(chatId, messageThreadId, sourceMessageId, pageText(built.title, undefined, []), built.rows, flowId)).message_id;
            }
            const value = await waitInput(chatId, messageThreadId, flowId, false, false, messageId);
            if (typeof value === "string" && value.startsWith("p:")) {
              const next = parseInt(value.slice(2), 10); if (next >= 0 && next < built.pageCount) page = next;
              continue;
            }
            let picked: string | undefined;
            if (typeof value === "string" && value.startsWith("s:")) {
              const idx = parseInt(value.slice(2), 10); picked = idx >= 0 && idx < options.length ? options[idx] : undefined;
            } else if (typeof value === "string" && value !== "cancel" && options.includes(value)) {
              picked = value;
            }
            activeFlowByTarget.delete(target);
            if (menuMessageId !== undefined && messageId === menuMessageId) settleMenuAnswer();
            else void deps.transport.removeInlineKeyboard(chatId, messageId);
            return picked;
          }
        },
        menu: async (title: string, options: string[], body?: string) => {
          if (options.length === 0) { releaseMenu(); return undefined; }
          let page = 0; const flowId = beginFlow();
          activeFlowByTarget.set(target, flowId);
          while (true) {
            const built = buildSelectPage(flowId, redact(title), options.map(redact), page, body === undefined ? undefined : redact(body));
            if (menuMessageId !== undefined) {
              await drawMenu(built.title, built.body, built.rows);
            } else {
              menuView = { title: built.title, body: built.body, rows: built.rows };
              menuMessageId = (await deps.transport.sendButtons(chatId, pageText(built.title, built.body, menuNotices), built.rows, messageThreadId, sourceMessageId)).message_id;
            }
            onMenuMessage?.(menuMessageId!);
            const value = await waitInput(chatId, messageThreadId, flowId, false, false, menuMessageId);
            // Pages and the next level edit menuMessageId directly, not via the
            // per-flow replace target that resolveInput records.
            replaceNextMessageByFlow.delete(flowId);
            if (typeof value === "string" && value.startsWith("p:")) {
              const next = parseInt(value.slice(2), 10); if (next >= 0 && next < built.pageCount) page = next; continue;
            }
            activeFlowByTarget.delete(target);
            // On a pick the keyboard stays: the next menu() call edits it, closeMenu() removes it.
            if (typeof value === "string" && value.startsWith("s:")) {
              const idx = parseInt(value.slice(2), 10);
              if (idx >= 0 && idx < options.length) { menuNotices = []; return options[idx]; }
            }
            releaseMenu();
            return undefined;
          }
        },
        closeMenu: async () => { releaseMenu(); },
        menuMessageId: () => menuMessageId,
        // custom: opaque host components are drawn by the host and presented to
        // this chat by the DialogBroker (§0.1 #4, decision 48). The plugin no longer
        // re-implements them as Telegram buttons (the old custom-dialogs bridge
        // parsed rendered text, violating plan §2 principle 2).
        custom: ((...args: unknown[]) =>
          (base!.custom as (...a: unknown[]) => unknown)(...args)) as ExtensionUIContext["custom"],

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
      return created;
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