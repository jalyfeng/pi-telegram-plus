/**
 * Adapter P1: pi's built-in list selectors, read from their own fields
 * (§4.1.4). The generic `filteredRows` guess produces JSON labels and wrong
 * titles here, so each known component is described exactly instead.
 *
 * pi does not minify, so the constructor name is a stable identity, and TS
 * `private` only exists at compile time: the lists, cursors and current
 * markers are plain properties we can read (pi 1.4.0
 * `packages/coding-agent/src/modes/interactive/components/`).
 */
import { stripAnsi } from "../../ansi.ts";
import { setInputValue } from "../keys.ts";
import type { AdapterContext, DialogAction, DialogAdapter, DialogItem, DialogModel } from "../model.ts";
import { constructorName, moveCursor, resolveRowKey, rowKey, selectRow } from "./utils.ts";

type HostRecord = Record<string, unknown>;

const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const asRecord = (value: unknown): HostRecord => (typeof value === "object" && value !== null ? (value as HostRecord) : {});

/** `/fork` keeps whole messages; Telegram labels stay one readable line. */
const MESSAGE_LABEL_MAX = 60;

/** One known pi selector: how to reach its rows and how to present them. */
type PiListSpec = {
  items(component: HostRecord): unknown[];
  label(item: HostRecord): string;
  /** The row the host itself marks as its current value. */
  current?(component: HostRecord, item: HostRecord): boolean;
  /** Multi-select checkbox state. */
  checked?(item: HostRecord): boolean;
  title(component: HostRecord): string;
  multi?: boolean;
};

const messageLabel = (item: HostRecord): string => {
  const oneLine = text(item.text).replace(/\n/g, " ").trim();
  return oneLine.length > MESSAGE_LABEL_MAX ? `${oneLine.slice(0, MESSAGE_LABEL_MAX)}…` : oneLine;
};

const PI_LIST_SPECS: Record<string, PiListSpec> = {
  // `/model`: `filteredModels` rows are `{ provider, id, model }`.
  ModelSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredModels) ? (c.filteredModels as unknown[]) : []),
    label: (item) => `${text(item.provider)}/${text(item.id)}`,
    current: (c, item) => {
      const current = asRecord(c.currentModel);
      return current.provider !== undefined
        && current.provider === item.provider
        && current.id === item.id;
    },
    title: () => "Select model",
  },
  // `/scoped-models`: Enter toggles the row, ctrl+s persists, so it is a
  // multi-select on Telegram; `enabled` is the checkbox.
  ScopedModelsSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredItems) ? (c.filteredItems as unknown[]) : []),
    label: (item) => text(item.fullId),
    checked: (item) => item.enabled === true,
    title: () => "Model Configuration",
    multi: true,
  },
  // `/login` and `/logout`: one provider list with two titles.
  OAuthSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredProviders) ? (c.filteredProviders as unknown[]) : []),
    label: (item) => text(item.name),
    title: (c) => (c.mode === "login" ? "Select provider to configure" : "Select provider to logout"),
  },
  // `/trust`: the saved decision marks the current row.
  TrustSelectorComponent: {
    items: (c) => (Array.isArray(c.trustOptions) ? (c.trustOptions as unknown[]) : []),
    label: (item) => text(item.label),
    current: (c, item) => {
      const saved = asRecord(c.savedDecision);
      return item.trusted !== undefined && saved.decision === item.trusted && saved.path === item.savedPath;
    },
    title: () => "Project trust",
  },
  // `/fork` and `/clone`: the focus owner is the inner `UserMessageList`
  // (`UserMessageSelectorComponent.getMessageList()`).
  UserMessageList: {
    items: (c) => (Array.isArray(c.messages) ? (c.messages as unknown[]) : []),
    label: messageLabel,
    title: () => "Select message",
  },
};

const specFor = (component: object): PiListSpec | undefined => PI_LIST_SPECS[constructorName(component)];

/** Live rows plus the terminal cursor, or undefined once the shape is gone. */
function rowsOf(component: object, spec: PiListSpec): { raw: HostRecord[]; labels: string[]; cursor: number } | undefined {
  const record = component as HostRecord;
  const items = spec.items(record);
  if (!Array.isArray(items)) return undefined;
  const raw = items.map(asRecord);
  return { raw, labels: raw.map((item) => spec.label(item)), cursor: readNumber(record.selectedIndex) };
}

export const piListAdapter: DialogAdapter = {
  id: "pi-list",

  detect(component, ctx) {
    if (ctx.host !== "pi") return false;
    const spec = specFor(component);
    return spec !== undefined && Array.isArray(spec.items(component as HostRecord));
  },

  read(component, ctx): DialogModel {
    const spec = specFor(component);
    const rows = spec ? rowsOf(component, spec) : undefined;
    if (!spec || !rows) {
      return { kind: "unsupported", what: "pi-list: component shape is gone" };
    }
    const items: DialogItem[] = rows.raw.map((item, index) => ({
      key: rowKey(index, rows.labels[index]),
      label: rows.labels[index],
      focused: index === rows.cursor,
      ...(spec.current ? { current: spec.current(component as HostRecord, item) } : {}),
      ...(spec.multi && spec.checked ? { checked: spec.checked(item) } : {}),
    }));
    return {
      kind: "select",
      title: spec.title(component as HostRecord),
      items,
      total: items.length,
      ...(spec.multi ? { multi: true } : {}),
    };
  },

  act(component, action, ctx) {
    const spec = specFor(component);
    if (!spec) return false;
    if (action.type === "cancel") return ctx.sendKey("esc");

    const multi = spec.multi === true;
    if (action.type === "submit") {
      // Scoped models: ctrl+s persists (the host's `app.models.save`), then
      // esc closes the dialog the way the terminal user leaves it.
      if (!multi) return false;
      if (!ctx.sendKey("ctrl-s")) return false;
      ctx.sendKey("esc");
      return true;
    }
    if (action.type !== "choose" && action.type !== "toggle") return false;
    // Enter means "pick" on a single-select and "tick" on a multi-select;
    // sending the wrong action would flip a checkbox or close the dialog.
    if ((action.type === "toggle") !== multi) return false;

    const rows = rowsOf(component, spec);
    if (!rows) return false;
    const target = resolveRowKey(rows.labels, action.key);
    if (target === undefined) return false;
    return selectRow(ctx.sendKey, rows.cursor, target);
  },
};

/**
 * `/resume` (P3): `SessionSelectorComponent` delegates keys to its inner
 * `SessionList`, whose rows are `{ session, depth }` tree nodes. The table
 * specs above cover flat components with a top-level cursor, so this one
 * adapter is dedicated: rows live one level down, labels concatenate two
 * fields, and Tab toggles the folder scope (§4.1.4).
 */
const SESSION_LABEL_MAX = 50;

/** The name, else the first message on one line, cut to the label width. */
const sessionBase = (session: HostRecord): string => {
  let base = text(session.name);
  if (base === "") {
    base = text(session.firstMessage).replace(/\n/g, " ");
    if (base.length > SESSION_LABEL_MAX) base = `${base.slice(0, SESSION_LABEL_MAX)}…`;
  }
  return base;
};

const sessionLabel = (session: HostRecord): string => `${sessionBase(session)} · ${readNumber(session.messageCount)} msgs`;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `modified` as local `YYYY-MM-DD HH:mm`; empty when the host has no date. */
const sessionTime = (session: HostRecord): string => {
  const modified = session.modified;
  if (!(modified instanceof Date) || Number.isNaN(modified.getTime())) return "";
  return `${modified.getFullYear()}-${pad2(modified.getMonth() + 1)}-${pad2(modified.getDate())}`
    + ` ${pad2(modified.getHours())}:${pad2(modified.getMinutes())}`;
};

/** The inner `SessionList`, or undefined once the shape is gone. */
function sessionListOf(component: object): HostRecord | undefined {
  const list = asRecord((component as HostRecord).sessionList);
  return Array.isArray(list.filteredSessions) ? list : undefined;
}

/** Live rows: tree nodes flattened to their sessions, plus the terminal cursor. */
function sessionRows(list: HostRecord): { raw: HostRecord[]; labels: string[]; cursor: number } {
  const raw = (list.filteredSessions as unknown[]).map((node) => asRecord(asRecord(node).session));
  return { raw, labels: raw.map(sessionLabel), cursor: readNumber(list.selectedIndex) };
}

/** The host's search box text (`SessionList.searchInput`); "" when unreadable. */
function sessionSearchText(list: HostRecord): string {
  const input = asRecord(list.searchInput);
  const getValue = input.getValue;
  return typeof getValue === "function" ? text((getValue as () => unknown).call(input)) : "";
}

/** The session with `path` in the first pool that has it. */
function findSessionByPath(path: unknown, pools: unknown[]): HostRecord | undefined {
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const found = pool.map(asRecord).find((session) => session.path === path);
    if (found) return found;
  }
  return undefined;
}

/** The host's rename field, when the selector is in rename mode. */
function renameInputOf(component: HostRecord): HostRecord | undefined {
  const input = component.renameInput;
  return typeof input === "object" && input !== null ? (input as HostRecord) : undefined;
}

/**
 * A row action waiting for its row (OMP's pick mode). Telegram has no host
 * highlight to move, so Rename/Delete first ask which row, then move the
 * cursor there and press the host's own key for the action.
 */
type SessionRowAction = "rename" | "delete";
const pendingSessionAction = new WeakMap<object, SessionRowAction>();
const SESSION_ROW_KEYS: Record<SessionRowAction, string> = { rename: "ctrl-r", delete: "ctrl-d" };

/** The host's status line (`SessionSelectorHeader.statusMessage`), e.g. "Cannot delete the active session". */
function sessionStatusNotice(component: HostRecord): string | undefined {
  const message = text(asRecord(asRecord(component.header).statusMessage).message);
  return message === "" ? undefined : message;
}

/** Rename mode: the host's own field, named after the session it renames. */
function sessionRenameModel(component: HostRecord): DialogModel {
  const session = findSessionByPath(component.renameTargetPath, [component.currentSessions, component.allSessions]);
  const name = session ? text(session.name) : "";
  return {
    kind: "input",
    title: "Rename session",
    secret: false,
    ...(name !== "" ? { placeholder: name } : {}),
  };
}

function actSessionRename(component: HostRecord, action: DialogAction, ctx: AdapterContext): boolean {
  // Esc is the component's own cancel while renaming: it leaves rename mode.
  if (action.type === "cancel") return ctx.sendKey("esc");
  if (action.type !== "submit" || action.text === undefined) return false;
  const value = action.text.trim();
  if (value === "") return false;
  // Replace the field text, then Enter: the host saves the name and leaves rename mode.
  return setInputValue(component, value) && ctx.sendKey("enter");
}

function actSessionDelete(component: HostRecord, action: DialogAction, ctx: AdapterContext): boolean {
  // Enter deletes, Esc keeps the session (the host's own confirm keys).
  if (action.type !== "confirm") return false;
  return ctx.sendKey(action.yes ? "enter" : "esc");
}

function actSessionList(component: HostRecord, list: HostRecord, action: DialogAction, ctx: AdapterContext): boolean {
  const pending = pendingSessionAction.get(component);
  if (action.type === "search") {
    // The host's search box re-filters on every typed key.
    if (!setInputValue(list, action.query)) return false;
    ctx.requestRender();
    return true;
  }
  if (action.type === "key") {
    if (pending !== undefined) {
      if (action.name !== "back") return false;
      pendingSessionAction.delete(component);
      ctx.requestRender();
      return true;
    }
    switch (action.name) {
      case "tab":
        return ctx.sendKey("tab");
      case "sort":
        return ctx.sendKey("ctrl-s");
      case "named":
        return ctx.sendKey("ctrl-n");
      case "rename":
      case "delete":
        if (sessionRows(list).raw.length === 0) return false;
        pendingSessionAction.set(component, action.name);
        ctx.requestRender();
        return true;
      default:
        return false;
    }
  }
  if (action.type !== "choose") return false;
  const { labels, cursor } = sessionRows(list);
  const target = resolveRowKey(labels, action.key);
  if (target === undefined) return false;
  if (pending !== undefined) {
    pendingSessionAction.delete(component);
    // Move the host cursor without choosing, then press the host's key for the action.
    return moveCursor(ctx.sendKey, cursor, target) && ctx.sendKey(SESSION_ROW_KEYS[pending]);
  }
  return selectRow(ctx.sendKey, cursor, target);
}

/**
 * `/resume` (P3): `SessionSelectorComponent` delegates keys to its inner
 * `SessionList`, whose rows are `{ session, depth }` tree nodes. The table
 * specs above cover flat components with a top-level cursor, so this one
 * adapter is dedicated: rows live one level down, labels concatenate two
 * fields, and the host's own keys drive scope, sort, named filter, search,
 * rename and delete (§4.1.4). Rename mode swaps the list for the host's field.
 */
export const piSessionAdapter: DialogAdapter = {
  id: "pi-session",

  detect(component, ctx) {
    if (ctx.host !== "pi") return false;
    if (constructorName(component) !== "SessionSelectorComponent") return false;
    const record = component as HostRecord;
    if (record.mode === "rename") return renameInputOf(record) !== undefined;
    return sessionListOf(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const record = component as HostRecord;
    if (record.mode === "rename") return sessionRenameModel(record);
    const list = sessionListOf(component);
    if (!list) {
      return { kind: "unsupported", what: "pi-session: component shape is gone" };
    }
    // The host asks before deleting: its confirm keys are Enter and Esc.
    if (typeof list.confirmingDeletePath === "string") {
      const session = findSessionByPath(list.confirmingDeletePath, [list.allSessions, record.currentSessions, record.allSessions]);
      const name = session ? sessionBase(session) : "this session";
      return { kind: "confirm", title: `Delete session ${name}?`, confirmLabel: "Delete", cancelLabel: "Cancel" };
    }
    const { raw, labels, cursor } = sessionRows(list);
    const currentPath = text(list.currentSessionCanonicalPath);
    const items: DialogItem[] = raw.map((session, index) => ({
      key: rowKey(index, labels[index]),
      label: labels[index],
      description: sessionTime(session),
      current: currentPath !== "" && session.path === currentPath,
      focused: index === cursor,
    }));
    const all = record.scope === "all";
    const pending = pendingSessionAction.get(record);
    const notice = sessionStatusNotice(record);
    const extraActions = pending !== undefined
      ? [{ label: "Back", key: "back" }]
      : [
          { label: all ? "This folder only" : "Show all", key: "tab" },
          { label: `Sort: ${text(list.sortMode)}`, key: "sort" },
          { label: `Named: ${list.nameFilter === "named" ? "only" : "all"}`, key: "named" },
          { label: "Rename", key: "rename" },
          { label: "Delete", key: "delete" },
        ];
    return {
      kind: "select",
      title: all ? "Resume session (all)" : "Resume session (this folder)",
      ...(pending !== undefined ? { subtitle: `${pending === "rename" ? "Rename" : "Delete"}: choose a session` } : {}),
      items,
      total: items.length,
      search: { query: sessionSearchText(list), placeholder: "Type to search" },
      extraActions,
      ...(notice !== undefined ? { notice } : {}),
    };
  },

  act(component, action, ctx) {
    const record = component as HostRecord;
    if (record.mode === "rename") {
      return renameInputOf(record) !== undefined && actSessionRename(record, action, ctx);
    }
    const list = sessionListOf(component);
    if (!list) return false;
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (typeof list.confirmingDeletePath === "string") return actSessionDelete(record, action, ctx);
    return actSessionList(record, list, action, ctx);
  },
};

/**
 * `/tree` (P4): `TreeSelectorComponent` delegates keys to its inner `TreeList`
 * (`filteredNodes` rows of `{ node, indent }`). Row text comes from the host's
 * own `getEntryDisplayText(node, false)` minus colors - the call is per entry,
 * not a screen read.
 */
const TREE_LABEL_MAX = 60;

/** The inner `TreeList`, or undefined once the shape is gone. */
function treeListOf(component: object): HostRecord | undefined {
  const list = asRecord((component as HostRecord).treeList);
  return Array.isArray(list.filteredNodes) ? list : undefined;
}

/** The host's own row text, one trimmed line; falls back to the entry type. */
function treeRowText(list: HostRecord, node: HostRecord): string {
  const display = list.getEntryDisplayText;
  if (typeof display === "function") {
    try {
      const raw = (display as (n: HostRecord, selected: boolean) => unknown).call(list, node, false);
      if (typeof raw === "string") {
        const oneLine = stripAnsi(raw).trim();
        return oneLine.length > TREE_LABEL_MAX ? `${oneLine.slice(0, TREE_LABEL_MAX)}…` : oneLine;
      }
    } catch {
      // Host text unavailable; the entry type still identifies the row.
    }
  }
  return text(asRecord(node.entry).type);
}

/** Live rows: the tree nodes, their indent-prefixed labels, plus the terminal cursor. */
function treeRows(list: HostRecord): { nodes: HostRecord[]; labels: string[]; cursor: number } {
  const rows = (list.filteredNodes as unknown[]).map(asRecord);
  const nodes = rows.map((row) => asRecord(row.node));
  const labels = rows.map((row, index) => {
    const indent = Math.min(readNumber(row.indent), 6);
    return "· ".repeat(indent) + treeRowText(list, nodes[index]);
  });
  return { nodes, labels, cursor: readNumber(list.selectedIndex) };
}

export const piTreeAdapter: DialogAdapter = {
  id: "pi-tree",

  detect(component, ctx) {
    if (ctx.host !== "pi") return false;
    if (constructorName(component) !== "TreeSelectorComponent") return false;
    // Renaming swaps a text input in front of the list; it owns the keys then.
    const labelInput = (component as HostRecord).labelInput;
    if (labelInput !== null && labelInput !== undefined) return false;
    return treeListOf(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const list = treeListOf(component);
    if (!list) {
      return { kind: "unsupported", what: "pi-tree: component shape is gone" };
    }
    const { nodes, labels, cursor } = treeRows(list);
    const leafId = typeof list.currentLeafId === "string" ? list.currentLeafId : "";
    const items: DialogItem[] = nodes.map((node, index) => ({
      key: rowKey(index, labels[index]),
      label: labels[index],
      current: leafId !== "" && text(asRecord(node.entry).id) === leafId,
      focused: index === cursor,
    }));
    return { kind: "select", title: "Session tree", items, total: items.length };
  },

  act(component, action, ctx) {
    const list = treeListOf(component);
    if (!list) return false;
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "choose") return false;
    const { labels, cursor } = treeRows(list);
    const target = resolveRowKey(labels, action.key);
    if (target === undefined) return false;
    return selectRow(ctx.sendKey, cursor, target);
  },
};
