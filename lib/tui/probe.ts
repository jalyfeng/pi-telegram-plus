/**
 * Host probe (stage 0 of docs/tui-parity-refactor-plan.md).
 *
 * Enabled only by PITG_PROBE=<absolute output path>. It observes the live
 * InteractiveMode and TUI objects from the inside: prototype method names,
 * entry-point arguments, focus objects, dialog components, chat children,
 * prompt calls and command catalogs. It never changes behaviour and never
 * throws into the host; every observation is best-effort.
 *
 * The output is a single JSON document rewritten atomically after each event,
 * so a SIGKILLed TUI still leaves the observations collected up to that point.
 */
import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type AnyRecord = Record<string, unknown>;
type ProbeEvent = { at: number; seq: number; kind: string; data: UnknownRecord };
type UnknownRecord = Record<string, unknown>;

type Snap = {
  type: string;
  ctor?: string;
  name?: string;
  length?: number;
  value?: string | number | boolean | null;
  keys?: string[];
  fields?: Record<string, Snap>;
  items?: Snap[];
  shapes?: string[];
  size?: number;
  getter?: true;
  error?: string;
};

type NameOwner = { name: string; owner: string; kind: "function" | "accessor" | "value" };

type ProbeDoc = {
  schema: number;
  host: string;
  label: string;
  startedAt: string;
  pid: number;
  node: string;
  cwd: string;
  argv: string[];
  env: Record<string, string | undefined>;
  prototype: {
    mode: NameOwner[];
    ui: NameOwner[];
    editor: NameOwner[];
    session: NameOwner[];
    chat: NameOwner[];
  };
  mode?: Snap;
  ui?: Snap;
  editors: Record<string, Snap>;
  session?: Snap;
  chat?: Snap;
  focusRead: UnknownRecord;
  entryCalls: ProbeEvent[];
  focusEvents: ProbeEvent[];
  overlayEvents: ProbeEvent[];
  chatChildren: ProbeEvent[];
  promptCalls: ProbeEvent[];
  customComponents: ProbeEvent[];
  statusCalls: ProbeEvent[];
  inputCalls: ProbeEvent[];
  catalog: ProbeEvent[];
  extensionUi: ProbeEvent[];
  warnings: string[];
};

const OUTPUT = process.env.PITG_PROBE ? resolve(process.env.PITG_PROBE) : "";
const HOST = (process.env.PITG_PROBE_HOST ?? "unknown").toLowerCase();
const LABEL = process.env.PITG_PROBE_LABEL ?? HOST;
const MAX_ENTRY = 3000;
const MAX_FOCUS = 1500;
const MAX_CHAT = 600;
const MAX_INPUT = 200;
const MAX_CUSTOM = 60;
const MAX_TEXT = 4000;

let doc: ProbeDoc | undefined;
let seq = 0;
let flushTimer: NodeJS.Timeout | undefined;
let installedMode = false;
let liveMode: AnyRecord | undefined;
let liveUi: AnyRecord | undefined;
const capturedModes = new WeakSet<object>();
const capturedUi = new WeakSet<object>();
const capturedEditors = new WeakSet<object>();
const capturedSessions = new WeakSet<object>();
const capturedChats = new WeakSet<object>();
const capturedToolUis = new WeakSet<object>();
const customEntries = new WeakMap<object, number>();

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function safeGet(target: unknown, key: string): unknown {
  try {
    return isRecord(target) ? target[key] : undefined;
  } catch {
    return undefined;
  }
}

function ctorName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? value.constructor?.name;
  } catch {
    return undefined;
  }
}

function ownNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function descriptorMap(value: unknown): Record<string, PropertyDescriptor> {
  if (!isRecord(value)) return {};
  const result: Record<string, PropertyDescriptor> = {};
  for (const name of ownNames(value)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor) result[name] = descriptor;
    } catch {
      // A proxy can refuse a descriptor; that is itself an observation.
    }
  }
  return result;
}

function nameOwners(value: unknown): NameOwner[] {
  const owners: NameOwner[] = [];
  if (!isRecord(value)) return owners;
  const seen = new Set<string>();
  let current: unknown = value;
  for (let depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const owner = ctorName(current) ?? `depth${depth}`;
    for (const name of ownNames(current)) {
      if (seen.has(name) || name === "constructor") continue;
      seen.add(name);
      let kind: NameOwner["kind"] = "value";
      try {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
          if (typeof descriptor.value === "function") kind = "function";
          else if (descriptor.get || descriptor.set) kind = "accessor";
        }
      } catch {
        // keep "value"
      }
      owners.push({ name, owner, kind });
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
    if (current === Object.prototype || current === Function.prototype) break;
  }
  return owners;
}

function clipString(value: string, limit = MAX_TEXT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[${value.length - limit} chars clipped]`;
}

function snapshot(value: unknown, depth = 2, seen?: WeakSet<object>, textLimit = MAX_TEXT): Snap {
  const visited = seen ?? new WeakSet<object>();
  if (value === null) return { type: "null", value: null };
  const kind = typeof value;
  if (typeof value === "string") return { type: "string", value: clipString(value, textLimit) };
  if (kind === "number" || kind === "boolean") return { type: kind, value: value as number | boolean };
  if (kind === "undefined") return { type: "undefined" };
  if (kind === "bigint") return { type: "bigint", value: String(value) };
  if (kind === "symbol") return { type: "symbol", value: String(value) };
  if (kind === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return { type: "function", name: fn.name || "(anonymous)", length: fn.length };
  }
  if (!isRecord(value)) return { type: kind };

  if (value instanceof Date) return { type: "date", value: value.toISOString() };
  if (value instanceof Error) return { type: "error", name: value.name, value: clipString(value.message, textLimit) };
  if (visited.has(value)) return { type: "circular" };
  visited.add(value);

  if (Array.isArray(value)) {
    const items = depth > 0 ? value.slice(0, 16).map((item) => snapshot(item, depth - 1, visited, textLimit)) : [];
    return { type: "array", ctor: ctorName(value), length: value.length, items };
  }
  if (value instanceof Map) {
    const items = depth > 0
      ? [...value.entries()].slice(0, 12).map(([k, v]) => snapshot({ key: k, value: v }, depth - 1, visited, textLimit))
      : [];
    return { type: "map", size: value.size, items };
  }
  if (value instanceof Set) {
    const items = depth > 0
      ? [...value.values()].slice(0, 12).map((item) => snapshot(item, depth - 1, visited, textLimit))
      : [];
    return { type: "set", size: value.size, items };
  }

  const keys = ownNames(value);
  const fields: Record<string, Snap> = {};
  let kept = 0;
  for (const key of keys) {
    if (kept >= 48) break;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fields[key] = { type: "unreadable" };
      kept += 1;
      continue;
    }
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set) {
      // Never invoke host getters: they can mutate or throw.
      fields[key] = { type: "accessor", getter: true };
      kept += 1;
      continue;
    }
    const raw = "value" in descriptor ? descriptor.value : undefined;
    const rawKind = typeof raw;
    if (depth <= 0 && rawKind !== "string" && rawKind !== "number" && rawKind !== "boolean" && raw !== null) {
      continue;
    }
    // Container plumbing must not consume the depth/visited budget before the
    // component's own data fields: pi's SessionSelectorComponent holds
    // sessionList as both a direct field and inside children. The rows still
    // matter - that is where an adapter would read labels - so a deferred array
    // is recorded as a per-row shape summary instead of being dropped.
    const deferred: Record<string, true> = {
      children: true, tui: true, theme: true, terminal: true, session: true,
      settingsManager: true, modelRuntime: true, keybindings: true,
    };
    if (key in deferred) {
      fields[key] = Array.isArray(raw) ? summarizeRows(raw, visited) : snapshot(raw, 0, visited, textLimit);
      kept += 1;
      continue;
    }
    fields[key] = snapshot(raw, rawKind === "object" ? depth - 1 : depth, visited, textLimit);
    kept += 1;
  }
  return { type: "object", ctor: ctorName(value), keys: keys.slice(0, 80), fields };
}

/**
 * A deferred container is not walked, but its rows carry exactly what an adapter
 * needs: labels, the current index, the key handler. Each row is recorded as a
 * shape summary - constructor, own field names, detected shapes, and the row's
 * own scalar / short-string fields - so the structure is reviewable without
 * dumping the host's whole subtree.
 */
function summarizeRows(value: unknown[], visited: WeakSet<object>): Snap {
  const items = value.slice(0, 12).map((item) => {
    if (!isRecord(item)) return snapshot(item);
    if (visited.has(item)) return { type: "circular" };
    visited.add(item);
    const fields: Record<string, Snap> = {};
    for (const name of ownNames(item).slice(0, 16)) {
      const raw = safeGet(item, name);
      if (typeof raw === "function") {
        fields[name] = { type: "function", name: (raw as (...args: unknown[]) => unknown).name || "(anonymous)" };
      } else if (typeof raw === "string") {
        fields[name] = { type: "string", value: clipString(raw, 120) };
      } else if (typeof raw === "number" || typeof raw === "boolean") {
        fields[name] = { type: typeof raw, value: raw };
      } else if (Array.isArray(raw)) {
        fields[name] = { type: "array", ctor: ctorName(raw), length: raw.length };
      } else if (raw === null) {
        fields[name] = { type: "null", value: null };
      } else if (raw && typeof raw === "object") {
        fields[name] = { type: "object", ctor: ctorName(raw) };
      } else {
        fields[name] = { type: typeof raw };
      }
    }
    return {
      type: "object",
      ctor: ctorName(item),
      keys: ownNames(item).slice(0, 40),
      shapes: focusShapes(item),
      fields,
    };
  });
  return { type: "array", ctor: ctorName(value), length: value.length, items };
}

function focusShapes(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const keys = new Set(ownNames(value));
  const proto = new Set(nameOwners(value).map((entry) => entry.name));
  const has = (name: string): boolean => keys.has(name) || proto.has(name);
  const arrayFields = [...keys].filter((key) => {
    try {
      return Array.isArray(safeGet(value, key));
    } catch {
      return false;
    }
  });
  const shapes: string[] = [];
  const selectedIndex = safeGet(value, "selectedIndex");
  const hasIndex = typeof selectedIndex === "number";
  const filtered = arrayFields.filter((key) => /^filtered[A-Z]/.test(key));

  if (arrayFields.includes("items") && hasIndex) shapes.push("SelectList(items+selectedIndex)");
  if (filtered.length > 0 && hasIndex) shapes.push(`FilteredList(${filtered.join(",")}+selectedIndex)`);
  if (arrayFields.includes("items") && hasIndex && (has("activateItem") || has("onChange") || has("submenuComponent"))) {
    shapes.push("SettingsList(items+selectedIndex+activateItem/onChange)");
  }
  if (has("submenuComponent") && safeGet(value, "submenuComponent")) shapes.push("SettingsList(submenuComponent)");
  if (arrayFields.includes("questions")) shapes.push("Questionnaire(questions)");
  if (arrayFields.includes("options") && (has("selectedIndex") || has("onSelect") || has("selected"))) {
    shapes.push("OptionList(options+selection)");
  }
  if (has("setValue") && (has("getValue") || has("value")) && (has("onSubmitCallback") || has("onSubmit"))) {
    shapes.push("Input(setValue+onSubmitCallback)");
  }
  if (has("setText") && has("getText")) shapes.push("Editor(setText+getText)");
  if (has("render")) shapes.push("Component(render)");
  if (has("handleInput")) shapes.push("Interactive(handleInput)");
  if (has("abortController") || has("signal")) shapes.push("Abortable(abortController/signal)");
  if (arrayFields.includes("tabs") || has("activeTab") || has("tabBar")) shapes.push("Tabbed(tabs/activeTab)");
  const goalKeys = [...keys].filter((key) => /goal|draft|question|answer|option|choice/i.test(key));
  if (goalKeys.length > 0) shapes.push(`GoalLike(${goalKeys.slice(0, 8).join(",")})`);
  return shapes;
}

function document(): ProbeDoc {
  if (doc) return doc;
  doc = {
    schema: 1,
    host: HOST,
    label: LABEL,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 20),
    env: {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PITG_PROBE_HOST: process.env.PITG_PROBE_HOST,
      PITG_PROBE_LABEL: process.env.PITG_PROBE_LABEL,
    },
    prototype: { mode: [], ui: [], editor: [], session: [], chat: [] },
    editors: {},
    focusRead: {},
    entryCalls: [],
    focusEvents: [],
    overlayEvents: [],
    chatChildren: [],
    promptCalls: [],
    customComponents: [],
    statusCalls: [],
    inputCalls: [],
    catalog: [],
    extensionUi: [],
    warnings: [],
  };
  return doc;
}

function flushNow(): void {
  if (!OUTPUT || !doc) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    renameSync(temporary, OUTPUT);
  } catch (error) {
    try {
      doc.warnings.push(`flush failed: ${String(error)}`);
    } catch {
      // ignore
    }
  }
}

function scheduleFlush(): void {
  if (!OUTPUT || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushNow();
  }, 120);
  flushTimer.unref?.();
}

function push(list: ProbeEvent[], kind: string, data: UnknownRecord, immediate = false): void {
  if (!doc) return;
  if (list.length >= (kind === "chat-child" ? MAX_CHAT : 3000)) return;
  seq += 1;
  list.push({ at: Date.now(), seq, kind, data });
  if (immediate) flushNow();
  else scheduleFlush();
}

function warn(message: string): void {
  if (!doc) return;
  doc.warnings.push(`${new Date().toISOString()} ${message}`);
}

function argSnapshot(args: unknown[], depth = 2): Snap[] {
  return args.slice(0, 4).map((arg) => snapshot(arg, depth));
}

function installMethod(target: unknown, name: string, onCall: (args: unknown[], receiver: unknown) => void): boolean {
  if (!isRecord(target)) return false;
  const current = safeGet(target, name);
  if (typeof current !== "function") return false;
  if ("__ptpProbe" in current && current.__ptpProbe) return false;
  const wrapped = function patched(this: unknown, ...args: unknown[]): unknown {
    try {
      onCall(args, this);
    } catch (error) {
      warn(`${name} observer failed: ${String(error)}`);
    }
    return current.apply(this, args);
  };
  Object.defineProperty(wrapped, "__ptpProbe", { value: true });
  try {
    return Reflect.set(target, name, wrapped);
  } catch {
    return false;
  }
}

function installAsyncResult(value: unknown, name: string, args: unknown[]): void {
  if (!isRecord(value) && typeof value !== "object") return;
  const then = safeGet(value, "then");
  if (typeof then !== "function") return;
  try {
    (then as (resolve: (v: unknown) => void, reject: (e: unknown) => void) => void).call(
      value,
      (result: unknown) => {
        push(document().entryCalls, "entry-result", {
          name,
          args: argSnapshot(args),
          result: snapshot(result, 2),
        });
      },
      (error: unknown) => {
        push(document().entryCalls, "entry-error", { name, error: snapshot(error, 2) });
      },
    );
  } catch {
    // Host returned a hostile thenable; ignore.
  }
}

function rememberEntryTarget(component: unknown, entrySeq: number): void {
  if (isRecord(component)) customEntries.set(component, entrySeq);
}

function installEntryMethods(mode: AnyRecord): void {
  const skipped = new Set([
    "showStatus", "showError", "showWarning", // handled separately for targeted output
    "render", "handleInput", "getFocused", "getFocus", "setFocus", "run", "init",
  ]);
  const prototypeOwners = nameOwners(mode);
  const wrapped = new Set<string>();
  for (const entry of prototypeOwners) {
    if (entry.kind !== "function" || skipped.has(entry.name)) continue;
    if (!/^(show|open|ask|approve|prompt|select|confirm|input|editor|custom)/i.test(entry.name)) continue;
    if (/^(showStatus|showError|showWarning)/.test(entry.name)) continue;
    // Avoid wrapping the bridge's own mirror helpers.
    if (entry.name.startsWith("__")) continue;
    // Find the owner in the prototype chain so subclasses stay intact.
    let owner: unknown = mode;
    for (let depth = 0; depth < 8 && isRecord(owner); depth += 1) {
      const descriptor = descriptorMap(owner)[entry.name];
      if (descriptor?.value === safeGet(owner, entry.name) && typeof descriptor.value === "function") break;
      owner = Object.getPrototypeOf(owner);
    }
    if (!isRecord(owner)) owner = mode;
    if (wrapped.has(entry.name)) continue;
    const isCustom = /custom/i.test(entry.name);
    const did = installMethod(owner, entry.name, (args) => {
      const entrySeq = seq + 1;
      push(document().entryCalls, "entry", {
        name: entry.name,
        args: argSnapshot(args, 3),
        entrySeq,
        host: HOST,
      }, true);
      // Record the stack for correlation with the focus event that follows.
      const active = document().entryCalls[document().entryCalls.length - 1];
      if (active) active.data.active = true;
      if (isCustom && typeof args[0] === "function") {
        const factory = args[0] as (...factoryArgs: unknown[]) => unknown;
        args[0] = function probedFactory(this: unknown, ...factoryArgs: unknown[]) {
          const result = factory.apply(this, factoryArgs);
          if (result && typeof (result as { then?: unknown }).then === "function") {
            return (result as Promise<unknown>).then((component) => {
              recordCustomComponent(component, entrySeq, entry.name);
              return component;
            }, (error) => {
              push(document().entryCalls, "custom-error", { name: entry.name, error: snapshot(error, 2) });
              throw error;
            });
          }
          recordCustomComponent(result, entrySeq, entry.name);
          return result;
        };
      }
    });
    if (did) wrapped.add(entry.name);
  }

  // Status/error/warning are separate: they are tiny, frequent, and the most
  // important output source for the new OutputCapture.
  for (const name of ["showStatus", "showError", "showWarning"]) {
    if (typeof safeGet(mode, name) !== "function") continue;
    installMethod(mode, name, (args) => {
      push(document().statusCalls, "status", {
        name,
        args: argSnapshot(args, 2),
        streaming: safeGet(safeGet(mode, "session"), "isStreaming"),
      });
    });
  }
}

function recordCustomComponent(component: unknown, entrySeq: number, source: string): void {
  if (!isRecord(component)) {
    push(document().entryCalls, "custom-no-component", { source, component: snapshot(component, 1) });
    return;
  }
  rememberEntryTarget(component, entrySeq);
  push(document().customComponents, "custom-component", {
    source,
    entrySeq,
    ctor: ctorName(component),
    fields: snapshot(component, 4, undefined, 20000),
    shapes: focusShapes(component),
  }, true);
}

function installFocus(ui: AnyRecord): void {
  if (capturedUi.has(ui)) return;
  capturedUi.add(ui);
  document().prototype.ui = nameOwners(ui);

  for (const name of ["setFocus", "setFocusInternal"]) {
    if (typeof safeGet(ui, name) !== "function") continue;
    installMethod(ui, name, (args) => {
      const focused = args[0];
      const event: UnknownRecord = {
        via: name,
        focus: snapshot(focused, 3, undefined, 8000),
        shapes: focusShapes(focused),
        constructor: ctorName(focused),
        ownKeys: ownNames(focused).slice(0, 80),
        current: snapshot(readFocus(ui), 2, undefined, 4000),
        hookSelector: snapshot(safeGet(liveMode, "hookSelector"), 2, undefined, 5000),
        hookInput: snapshot(safeGet(liveMode, "hookInput"), 2, undefined, 5000),
        hookEditor: snapshot(safeGet(liveMode, "hookEditor"), 2, undefined, 5000),
        editorFocused: focused === safeGet(liveMode, "editor") || focused === safeGet(liveMode, "defaultEditor"),
      };
      const recent = document().entryCalls.slice(-4).map((entry) => ({
        name: entry.data.name,
        seq: entry.data.entrySeq,
        kind: entry.kind,
      }));
      event.recentEntries = recent;
      if (isRecord(focused)) {
        const entrySeq = customEntries.get(focused);
        if (entrySeq) event.customEntrySeq = entrySeq;
      }
      push(document().focusEvents, "focus", event, true);
    });
  }

  for (const name of ["showOverlay", "hideOverlay"]) {
    if (typeof safeGet(ui, name) !== "function") continue;
    installMethod(ui, name, (args) => {
      const component = args[0];
      push(document().overlayEvents, "overlay", {
        via: name,
        component: snapshot(component, 2, undefined, 8000),
        constructor: ctorName(component),
        options: snapshot(args[1], 2),
        shapes: focusShapes(component),
      }, name === "showOverlay");
    });
  }

  document().focusRead = {
    keys: ownNames(ui).slice(0, 120),
    hasGetFocused: typeof safeGet(ui, "getFocused") === "function",
    hasGetFocus: typeof safeGet(ui, "getFocus") === "function",
    focusedComponent: describeField(ui, "focusedComponent"),
    focused: describeField(ui, "focused"),
    getFocusedResult: callGetter(ui, "getFocused"),
    getFocusResult: callGetter(ui, "getFocus"),
  };
}

function describeField(target: unknown, name: string): Snap {
  if (!isRecord(target)) return { type: "absent" };
  const descriptor = descriptorMap(target)[name];
  if (!descriptor) return { type: "absent" };
  const present: Snap = {
    type: "object",
    fields: {
      present: snapshot(true, 0),
      accessor: snapshot(Boolean(descriptor.get || descriptor.set), 0),
      valueType: snapshot(typeof descriptor.value, 0),
      ctor: snapshot(ctorName(descriptor.value), 0),
    },
  };
  if (descriptor.value !== undefined) {
    present.fields = { ...present.fields, value: snapshot(descriptor.value, 1) };
  }
  return present;
}

function callGetter(target: unknown, name: string): UnknownRecord {
  const getter = safeGet(target, name);
  if (typeof getter !== "function") return { callable: false };
  try {
    const value = (getter as () => unknown).call(target);
    return { callable: true, ctor: ctorName(value), keys: ownNames(value).slice(0, 60), value: snapshot(value, 1) };
  } catch (error) {
    return { callable: true, error: String(error) };
  }
}

function readFocus(ui: unknown): unknown {
  for (const name of ["getFocused", "getFocus"]) {
    const getter = safeGet(ui, name);
    if (typeof getter !== "function") continue;
    try {
      const value = (getter as () => unknown).call(ui);
      if (value) return value;
    } catch {
      // try the next source
    }
  }
  return safeGet(ui, "focusedComponent") ?? safeGet(ui, "focused");
}

function installEditor(editor: AnyRecord): void {
  if (capturedEditors.has(editor)) return;
  capturedEditors.add(editor);
  document().prototype.editor = nameOwners(editor);
  const onSubmit = safeGet(editor, "onSubmit");
  if (typeof onSubmit === "function") {
    installMethod(editor, "onSubmit", (args) => {
      push(document().promptCalls, "editor-submit", {
        text: clipString(typeof args[0] === "string" ? args[0] : String(args[0] ?? ""), 2000),
        editorText: safeGet(editor, "getText") ? callOptional(editor, "getText") : undefined,
        focused: readFocus(liveUi) === editor,
      }, true);
    });
  }
  if (typeof safeGet(editor, "handleInput") === "function") {
    installMethod(editor, "handleInput", (args) => {
      if (document().inputCalls.length >= MAX_INPUT) return;
      const input = typeof args[0] === "string" ? args[0] : "";
      push(document().inputCalls, "editor-input", {
        input: clipString(input, 80),
        escape: input.includes("\x1b"),
        enter: input === "\r" || input === "\n",
      });
    });
  }
  for (const name of ["getText", "setText", "setValue"]) {
    // Presence is recorded in prototype.editor; do not wrap (hot path).
  }
}

function callOptional(target: unknown, name: string): unknown {
  const fn = safeGet(target, name);
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as () => unknown).call(target);
  } catch {
    return undefined;
  }
}

function installResultMethod(target: unknown, name: string): boolean {
  if (!isRecord(target)) return false;
  const current = safeGet(target, name);
  if (typeof current !== "function") return false;
  if ("__ptpProbeResult" in current && current.__ptpProbeResult) return false;
  const wrapped = function patched(this: unknown, ...args: unknown[]): unknown {
    const result = current.apply(this, args);
    try {
      push(document().promptCalls, "export-result", {
        method: name,
        args: argSnapshot(args, 2),
        result: snapshot(result, 2),
        resultType: typeof result,
      }, true);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        Promise.resolve(result).then(
          (value) => push(document().promptCalls, "export-resolved", {
            method: name,
            value: snapshot(value, 2),
            valueType: typeof value,
          }, true),
          (error) => push(document().promptCalls, "export-rejected", {
            method: name,
            error: snapshot(error, 2),
          }, true),
        );
      }
    } catch (error) {
      warn(`${name} result observer failed: ${String(error)}`);
    }
    return result;
  };
  Object.defineProperty(wrapped, "__ptpProbeResult", { value: true });
  try {
    return Reflect.set(target, name, wrapped);
  } catch {
    return false;
  }
}

function installSession(session: AnyRecord): void {
  if (capturedSessions.has(session)) return;
  capturedSessions.add(session);
  document().prototype.session = nameOwners(session);
  if (typeof safeGet(session, "prompt") === "function") {
    installMethod(session, "prompt", (args) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      const eventSeq = seq + 1;
      push(document().promptCalls, "prompt", {
        text: clipString(text, 2000),
        eventSeq,
        streaming: safeGet(session, "isStreaming"),
        compacting: safeGet(session, "isCompacting"),
        modePending: snapshot(safeGet(liveMode, "pendingUserInputs"), 2),
        onInputCallback: typeof safeGet(liveMode, "onInputCallback"),
      }, true);
    });
  }
  for (const name of ["exportToHtml", "exportToJsonl"]) {
    installResultMethod(session, name);
  }
}

function installChat(chat: AnyRecord): void {
  if (capturedChats.has(chat)) return;
  capturedChats.add(chat);
  document().prototype.chat = nameOwners(chat);
  if (typeof safeGet(chat, "addChild") === "function") {
    installMethod(chat, "addChild", (args) => {
      if (document().chatChildren.length >= MAX_CHAT) return;
      const child = args[0];
      push(document().chatChildren, "chat-child", {
        ctor: ctorName(child),
        keys: ownNames(child).slice(0, 60),
        shapes: focusShapes(child),
        text: snapshot(safeGet(child, "text"), 1),
        streamingComponent: child === safeGet(liveMode, "streamingComponent"),
        sessionStreaming: safeGet(safeGet(liveMode, "session"), "isStreaming"),
        snapshot: snapshot(child, 2, undefined, 4000),
      });
    });
  }
  if (typeof safeGet(chat, "clear") === "function") {
    installMethod(chat, "clear", () => {
      push(document().chatChildren, "chat-clear", { ctor: ctorName(chat) }, true);
    });
  }
}

function installToolUi(context: unknown): void {
  if (!isRecord(context) || capturedToolUis.has(context)) return;
  capturedToolUis.add(context);
  const methods: Record<string, string> = {};
  for (const name of ["askDialog", "approve", "select", "confirm", "input", "editor", "custom", "notify"]) {
    const value = safeGet(context, name);
    if (typeof value !== "function") continue;
    try {
      methods[name] = clipString(String(value), 1200);
    } catch {
      methods[name] = "[unprintable]";
    }
    installMethod(context, name, (args) => {
      push(document().entryCalls, "tool-ui-entry", {
        name,
        args: argSnapshot(args, 4),
        entrySeq: seq + 1,
      }, true);
    });
  }
  push(document().entryCalls, "tool-ui", {
    ctor: ctorName(context),
    keys: ownNames(context).slice(0, 80),
    prototype: nameOwners(context).slice(0, 120),
    methods,
  }, true);
}

function applyMode(mode: AnyRecord): void {
  liveMode = mode;
  document().prototype.mode = nameOwners(mode);
  document().mode = snapshot(mode, 1, undefined, 6000);
  const editorCandidates: Record<string, unknown> = {
    editor: safeGet(mode, "editor"),
    defaultEditor: safeGet(mode, "defaultEditor"),
    input: safeGet(mode, "input"),
  };
  for (const [name, candidate] of Object.entries(editorCandidates)) {
    if (!candidate) continue;
    document().editors[name] = snapshot(candidate, 2, undefined, 6000);
    document().editors[name].fields = {
      ...(document().editors[name].fields ?? {}),
      __onSubmit: snapshot(safeGet(candidate, "onSubmit"), 1),
      __handleInput: snapshot(safeGet(candidate, "handleInput"), 1),
      __getText: snapshot(safeGet(candidate, "getText"), 1),
      __setText: snapshot(safeGet(candidate, "setText"), 1),
      __autocompleteProvider: snapshot(safeGet(candidate, "autocompleteProvider"), 2),
    };
  }
  const uiCandidates: Record<string, unknown> = {
    ui: safeGet(mode, "ui"),
    uiContext: safeGet(mode, "uiContext"),
    tui: safeGet(mode, "tui"),
    app: safeGet(mode, "app"),
  };
  for (const [name, candidate] of Object.entries(uiCandidates)) {
    if (!candidate) continue;
    const uiSnap = snapshot(candidate, 2, undefined, 6000);
    uiSnap.fields = {
      ...(uiSnap.fields ?? {}),
      __getFocused: snapshot(safeGet(candidate, "getFocused"), 1),
      __getFocus: snapshot(safeGet(candidate, "getFocus"), 1),
      __focusedComponent: describeField(candidate, "focusedComponent"),
      __focused: describeField(candidate, "focused"),
      __terminal: snapshot(safeGet(candidate, "terminal"), 1),
      __renderer: snapshot(safeGet(candidate, "renderer"), 1),
      __uiName: snapshot(name, 1),
    };
    document().ui = uiSnap;
    liveUi = candidate as AnyRecord;
    installFocus(candidate as AnyRecord);
  }
  const sessionSnap = snapshot(safeGet(mode, "session"), 2, undefined, 6000);
  sessionSnap.fields = {
      ...(sessionSnap.fields ?? {}),
      __isStreaming: snapshot(safeGet(safeGet(mode, "session"), "isStreaming"), 1),
      __isCompacting: snapshot(safeGet(safeGet(mode, "session"), "isCompacting"), 1),
      __isIdle: snapshot(safeGet(safeGet(mode, "session"), "isIdle"), 1),
      __pendingUserInputs: snapshot(safeGet(mode, "pendingUserInputs"), 2),
      __onInputCallback: snapshot(safeGet(mode, "onInputCallback"), 1),
      __streamingComponent: snapshot(safeGet(mode, "streamingComponent"), 2),
  };
  document().session = sessionSnap;
  const chatSnap = snapshot(safeGet(mode, "chatContainer") ?? safeGet(mode, "chat"), 2, undefined, 6000);
  chatSnap.fields = {
      ...(chatSnap.fields ?? {}),
      __children: snapshot(safeGet(safeGet(mode, "chatContainer") ?? safeGet(mode, "chat"), "children"), 2),
  };
  document().chat = chatSnap;
  installEntryMethods(mode);
  if (typeof safeGet(mode, "setToolUIContext") === "function") {
    installMethod(mode, "setToolUIContext", (args) => installToolUi(args[0]));
  }
  installToolUi(callOptional(mode, "getToolUIContext"));
  for (const name of ["editor", "defaultEditor", "input"]) {
    const candidate = editorCandidates[name];
    if (isRecord(candidate) && typeof safeGet(candidate, "onSubmit") === "function") installEditor(candidate);
  }
  const session = safeGet(mode, "session");
  if (isRecord(session)) installSession(session);
  const chat = safeGet(mode, "chatContainer") ?? safeGet(mode, "chat");
  if (isRecord(chat)) installChat(chat);
  recordProviderCatalog(mode, editorCandidates);
}

function recordOmpCatalog(): void {
  if (HOST !== "omp" || !OUTPUT) return;
  void (async () => {
    try {
      const mod = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
      const defs = safeGet(mod, "BUILTIN_SLASH_COMMAND_DEFS");
      if (!Array.isArray(defs)) return;
      const commands = defs.map((item) => {
        const name = safeGet(item, "name");
        return {
          name: typeof name === "string" ? name : undefined,
          description: safeGet(item, "description"),
          aliases: safeGet(item, "aliases"),
        };
      }).filter((item) => item.name);
      push(document().catalog, "catalog", { source: "omp-builtin-registry", commands }, true);
    } catch (error) {
      warn(`omp catalog import failed: ${String(error)}`);
    }
  })();
}

function recordProviderCatalog(mode: AnyRecord, editors: Record<string, unknown>): void {
  const providers = [safeGet(mode, "autocompleteProvider")];
  for (const editor of Object.values(editors)) providers.push(safeGet(editor, "autocompleteProvider"));
  const seen = new Set<string>();
  for (const provider of providers) {
    const commands = safeGet(provider, "commands");
    if (!Array.isArray(commands)) continue;
    const list: UnknownRecord[] = [];
    for (const item of commands) {
      if (!isRecord(item)) continue;
      const name = safeGet(item, "name") ?? safeGet(item, "value");
      if (typeof name !== "string" || !name.trim() || seen.has(name)) continue;
      seen.add(name);
      list.push({
        name: name.trim(),
        description: snapshot(safeGet(item, "description"), 1),
        aliases: snapshot(safeGet(item, "aliases"), 1),
      });
    }
    if (list.length > 0) {
      push(document().catalog, "catalog", { source: "autocomplete", commands: list }, true);
    }
  }
}

function tick(mode: AnyRecord): void {
  const ui = safeGet(mode, "ui") ?? safeGet(mode, "uiContext") ?? safeGet(mode, "tui") ?? safeGet(mode, "app");
  const editor = safeGet(mode, "editor") ?? safeGet(mode, "defaultEditor") ?? safeGet(mode, "input");
  const session = safeGet(mode, "session");
  const chat = safeGet(mode, "chatContainer") ?? safeGet(mode, "chat");
  if (isRecord(ui) && !capturedUi.has(ui)) {
    document().prototype.ui = nameOwners(ui);
    installFocus(ui);
  }
  if (isRecord(editor) && !capturedEditors.has(editor) && typeof safeGet(editor, "onSubmit") === "function") {
    installEditor(editor);
  }
  if (isRecord(session) && !capturedSessions.has(session)) installSession(session);
  if (isRecord(chat) && !capturedChats.has(chat)) installChat(chat);
}

export function probeCapture(mode: unknown, host: string): void {
  if (!OUTPUT) return;
  if (!isRecord(mode)) return;
  try {
    if (!installedMode) {
      installedMode = true;
      document().host = host || HOST;
      document().label = process.env.PITG_PROBE_LABEL ?? document().host;
      process.on("exit", flushNow);
      installHooks();
      recordOmpCatalog();
    }
    if (capturedModes.has(mode)) {
      tick(mode);
      return;
    }
    capturedModes.add(mode);
    applyMode(mode);
    tick(mode);
    const timer = setInterval(() => tick(mode), 1000);
    timer.unref?.();
    flushNow();
  } catch (error) {
    try {
      warn(`probeCapture failed: ${String(error)}`);
      flushNow();
    } catch {
      // never break the host
    }
  }
}

function installHooks(): void {
  const globalObject = globalThis as unknown as { __ptpProbe?: UnknownRecord };
  globalObject.__ptpProbe = {
    record(kind: string, data: UnknownRecord): void {
      if (!doc) return;
      const list = kind.startsWith("extension-ui") ? doc.extensionUi : doc.extensionUi;
      push(list, kind, data, true);
    },
    describe: (value: unknown, depth = 2): Snap => snapshot(value, depth),
    flush: flushNow,
    path: OUTPUT,
    host: HOST,
  };
}
