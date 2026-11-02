/**
 * Adapter P2: pi's `/settings` (`SettingsList`, §4.6.4 #5). The generic
 * `filteredRows` guess shows it as a plain "Choose" list, losing the current
 * values and the submenu nesting, so every field the component itself keeps
 * is read instead: rows, cursor, per-row `values`, and the open submenu
 * (usually a nested pi-tui `SelectList`).
 *
 * All actions go in as keystrokes (§4.6): arrows and Enter, exactly like a
 * terminal user. While a submenu is open, `SettingsList.handleInput`
 * forwards every key to it, so the same `sendKey` drives both levels and the
 * component keeps ownership of its own values.
 *
 * Search text is keystrokes too: unclaimed keys belong to the component's
 * own `searchInput`, so a `search` action types into it the same way.
 */
import { stripAnsi } from "../../ansi.ts";
import { findShape, isSelectList } from "../find-shape.ts";
import { setInputValue } from "../keys.ts";
import type { DialogAdapter, DialogModel } from "../model.ts";
import { constructorName, labelOf, moveCursor, resolveRowKey, rowKey, selectRow } from "./utils.ts";

type HostRecord = Record<string, unknown>;

/** One live settings/submenu row plus its stable "index + label" key. */
type SettingRow = { key: string; label: string; raw: HostRecord };

const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const asRecord = (value: unknown): HostRecord => (typeof value === "object" && value !== null ? (value as HostRecord) : {});
const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.map((entry) => text(entry)) : undefined);

/** The list the component itself draws: the filtered one while searching. */
function mainRows(component: HostRecord): SettingRow[] {
  const source = component.searchEnabled === true && Array.isArray(component.filteredItems)
    ? (component.filteredItems as unknown[])
    : Array.isArray(component.items)
      ? (component.items as unknown[])
      : [];
  return source.map((entry, index) => {
    const raw = asRecord(entry);
    const label = text(raw.label);
    return { key: rowKey(index, label), label, raw };
  });
}

/** The rows a nested `SelectList` draws: its filtered list when filtering. */
function submenuRows(list: HostRecord): SettingRow[] {
  const filtered = Array.isArray(list.filteredItems) ? (list.filteredItems as unknown[]) : [];
  const source = filtered.length > 0
    ? filtered
    : Array.isArray(list.items)
      ? (list.items as unknown[])
      : [];
  return source.map((entry, index) => {
    const raw = asRecord(entry);
    const label = labelOf(raw);
    return { key: rowKey(index, label), label, raw };
  });
}

/** The current search term; "" when the component has no readable input. */
function searchQuery(component: HostRecord): string {
  const input = component.searchInput;
  if (!input || typeof input !== "object") return "";
  const getValue = (input as HostRecord).getValue;
  return typeof getValue === "function" ? text((getValue as () => unknown).call(input)) : "";
}

/**
 * The line pi's `SelectSubmenu` draws under its title (e.g. a stepped
 * submenu's "Step 1/2 · Select a model to configure"). The component keeps
 * no field for it; it is the `Text` child at index 2 (title, Spacer, text),
 * and only a description line can sit there: without one that slot holds
 * the search Input or the list. Found through the component owning `list`.
 */
function submenuSubtitle(open: object, list: HostRecord): string | undefined {
  const owner = findShape(
    open,
    (candidate: unknown): candidate is HostRecord =>
      typeof candidate === "object" && candidate !== null && (candidate as HostRecord).selectList === list,
    3,
  );
  const children = owner && Array.isArray(owner.children) ? owner.children : [];
  const line = children[2];
  if (!line || typeof line !== "object" || typeof (line as HostRecord).text !== "string") return undefined;
  const subtitle = stripAnsi((line as HostRecord).text as string).trim();
  return subtitle.length > 0 ? subtitle : undefined;
}

/** The open submenu as a nested model, or undefined while none is open. */
function readSubmenu(component: HostRecord, rows: SettingRow[]): { itemKey: string; model: DialogModel } | undefined {
  const open = component.submenuComponent;
  if (!open || typeof open !== "object") return undefined;
  // The row whose Enter opened the submenu; the component keeps its index.
  const openerIndex = typeof component.submenuItemIndex === "number"
    ? component.submenuItemIndex
    : readNumber(component.selectedIndex);
  const opener = rows[openerIndex];
  const itemKey = opener?.key ?? rowKey(openerIndex, "");
  const title = opener?.label ?? "";
  const list = findShape(open, isSelectList, 3);
  if (!list) {
    return { itemKey, model: { kind: "unsupported", title, what: `settings submenu: ${constructorName(open)}` } };
  }
  const subRows = submenuRows(list);
  const cursor = readNumber(list.selectedIndex);
  const currentValue = text(opener?.raw.currentValue);
  const subtitle = submenuSubtitle(open, list);
  return {
    itemKey,
    model: {
      kind: "select",
      title,
      ...(subtitle !== undefined ? { subtitle } : {}),
      total: subRows.length,
      items: subRows.map((row, index) => ({
        key: row.key,
        label: row.label,
        focused: index === cursor,
        current: opener !== undefined && text(row.raw.value) === currentValue,
      })),
    },
  };
}

export const piSettingsAdapter: DialogAdapter = {
  id: "pi-settings",

  detect(component, ctx) {
    return ctx.host === "pi"
      && constructorName(component) === "SettingsList"
      && Array.isArray((component as HostRecord).items);
  },

  read(component, ctx): DialogModel {
    const record = component as HostRecord;
    const rows = mainRows(record);
    const cursor = readNumber(record.selectedIndex);
    const items = rows.map((row, index) => {
      const values = stringList(row.raw.values);
      return {
        key: row.key,
        label: row.label,
        value: text(row.raw.currentValue),
        focused: index === cursor,
        ...(values !== undefined ? { values } : {}),
        hasSubmenu: Boolean(row.raw.submenu),
      };
    });
    const submenu = readSubmenu(record, rows);
    // Search belongs to the main list only: while a submenu is open every
    // keystroke (typed or sent) belongs to the submenu.
    const search = submenu === undefined && record.searchEnabled === true
      ? { query: searchQuery(record) }
      : undefined;
    return { kind: "settings", title: "Settings", items, ...(search ? { search } : {}), ...(submenu ? { submenu } : {}) };
  },

  act(component, action, ctx) {
    const record = component as HostRecord;
    // Main list or submenu, Escape is the component's own cancel key; while a
    // submenu is open the component routes it there, closing only the submenu.
    if (action.type === "cancel") return ctx.sendKey("esc");

    const open = record.submenuComponent;
    if (open && typeof open === "object") {
      // Every other key belongs to the submenu, and only Enter rows exist.
      if (action.type !== "choose") return false;
      const list = findShape(open, isSelectList, 3);
      if (!list) return false;
      const rows = submenuRows(list);
      const target = resolveRowKey(rows.map((row) => row.label), action.key);
      if (target === undefined) return false;
      return selectRow(ctx.sendKey, readNumber(list.selectedIndex), target);
    }

    if (action.type === "search") {
      // Without the search box there is nothing to type into; a `search`
      // action on such a host must fail, not swallow keys.
      if (record.searchEnabled !== true) return false;
      // A leading space would activate the row while the filter is empty
      // (`SettingsList` treats space as Enter then), so drop leading blanks.
      return setInputValue(record, action.query.replace(/^\s+/, ""));
    }

    const rows = mainRows(record);
    const labels = rows.map((row) => row.label);
    const cursor = readNumber(record.selectedIndex);

    if (action.type === "submenu") {
      const target = resolveRowKey(labels, action.key);
      if (target === undefined) return false;
      return moveCursor(ctx.sendKey, cursor, target) && ctx.sendKey("enter");
    }
    if (action.type !== "cycle") return false;
    const target = resolveRowKey(labels, action.key);
    if (target === undefined) return false;
    const row = rows[target];

    if (action.value === undefined) {
      // One Enter: the component cycles the row itself.
      return moveCursor(ctx.sendKey, cursor, target) && ctx.sendKey("enter");
    }
    const values = stringList(row.raw.values);
    if (values === undefined || values.length === 0) return false;
    const wanted = values.indexOf(action.value);
    const from = values.indexOf(text(row.raw.currentValue));
    if (wanted < 0 || from < 0) return false;
    const presses = (wanted - from + values.length) % values.length;
    if (presses === 0) return true;
    if (!moveCursor(ctx.sendKey, cursor, target)) return false;
    for (let press = 0; press < presses; press += 1) {
      if (!ctx.sendKey("enter")) return false;
    }
    // The component owns the value: believe the re-read row, not the maths.
    const after = mainRows(record).find((entry) => entry.key === row.key);
    return after !== undefined && text(after.raw.currentValue) === action.value;
  },
};
