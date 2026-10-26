/**
 * Dialog entry hooks (§4.1.2).
 *
 * Hooking component classes tells us *what is on screen*; hooking the entry
 * points tells us *what the dialog means*. Both hosts route interactive
 * prompts through named entry methods, so we wrap those and record an
 * `EntryInfo` before the original runs.
 *
 * Two places get patched, because the same dialog can be opened two ways: the
 * extension/tool UI context (pi's `createExtensionUIContext()` result, OMP's tool
 * UI context) and the host's own `show*` methods that context delegates to.
 *
 * An entry stays recorded for as long as the host's call is pending: the two hosts
 * differ on whether focus lands inside the call or on a later render tick, and a
 * dialog whose entry has already been retired reaches the adapters nameless. A
 * nested call merges into the pending entry, so double layers stay one entry.
 */
import type { EntryInfo } from "./model.ts";
import { hasStickyMark, isFunctionMarked, mark, markFunction } from "./install-marks.ts";

/** A recorded entry, returned so the hook that pushed it retires its own record. */
export type EntryToken = object;

/** What the hooks report; implemented by FocusTracker. */
export type EntrySink = {
  /**
   * Record the entry before the original runs. `nested` is true when this call
   * happens inside another entry call; a nested entry merges into the pending one
   * and returns no token.
   */
  push(info: EntryInfo, nested: boolean): EntryToken | undefined;
  /** Retire this hook's entry once the host's dialog has resolved (or thrown). */
  pop(token: EntryToken | undefined): void;
  /** Bind an entry straight to a component (async `custom` factories). */
  bind(component: object, info: EntryInfo): void;
};

type EntryKindLiteral = "select" | "confirm" | "input" | "editor" | "custom" | "ask" | "approval" | "panel";

export type EntrySpec = {
  method: string;
  kind: EntryKindLiteral;
  factory?: boolean;
  extract: Extract;
};

type Extract = (args: unknown[]) => EntryInfo | undefined;

const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
};

const firstString = (args: unknown[]): string | undefined =>
  args.find((arg): arg is string => typeof arg === "string" && arg.length > 0);

const optionsArg = (args: unknown[]): string[] | undefined =>
  args.map((arg) => strings(arg)).find((value): value is string[] => value !== undefined);

/** `select(title, options, opts)` and `showCollabAwareSelector(input, opts, done)`. */
const selectFrom: Extract = (args) => {
  const options = optionsArg(args);
  if (!options) return undefined;
  return { kind: "select", title: firstString(args), options, source: "pi" };
};

const confirmFrom: Extract = (args) => ({
  kind: "confirm",
  title: typeof args[0] === "string" ? args[0] : undefined,
  message: typeof args[1] === "string" ? args[1] : undefined,
  source: "pi",
});

const inputFrom = (secret: boolean): Extract => (args) => {
  const options = (args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) ?? {}) as Record<string, unknown>;
  return {
    kind: "input",
    title: typeof args[0] === "string" ? args[0] : undefined,
    placeholder: typeof args[1] === "string" ? args[1] : undefined,
    secret: secret || options.secret === true || options.sensitive === true,
    source: "pi",
  };
};

const editorFrom: Extract = (args) => ({
  kind: "editor",
  title: typeof args[0] === "string" ? args[0] : undefined,
  prefill: typeof args[1] === "string" ? args[1] : undefined,
  source: "pi",
});

const customFrom: Extract = (args) => {
  const options = (args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) ?? {}) as Record<string, unknown>;
  return { kind: "custom", title: typeof options.title === "string" ? options.title : firstString(args.slice(1)), source: "pi" };
};

const askFrom: Extract = (args) => {
  const questions = Array.isArray(args[0])
    ? (args[0] as Array<Record<string, unknown>>).map((question, index) => ({
        id: typeof question.id === "string" ? question.id : `q${index}`,
        question:
          typeof question.question === "string" ? question.question
          : typeof question.prompt === "string" ? question.prompt
          : `Question ${index + 1}`,
        header: typeof question.header === "string" ? question.header : undefined,
        options: Array.isArray(question.options)
          ? (question.options as Array<Record<string, unknown>>).map((option) => ({
              label: typeof option.label === "string" ? option.label : String(option.label ?? ""),
              description: typeof option.description === "string" ? option.description : undefined,
            }))
          : [],
        multi: question.multi === true,
        recommended: typeof question.recommended === "number" ? question.recommended : undefined,
        allowCustom: question.allowCustom !== false,
      }))
    : undefined;
  if (!questions || questions.length === 0) return undefined;
  return { kind: "ask", questions, source: "omp" };
};

const approvalFrom: Extract = (args) => {
  const info = (args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) ?? {}) as Record<string, unknown>;
  const pick = (name: string) => (typeof info[name] === "string" ? (info[name] as string) : undefined);
  const full = pick("full");
  const compact = pick("compact");
  const session = pick("session");
  if (!full && !compact && !session) return undefined;
  return { kind: "approval", title: "Tool approval", approval: { full, compact, session }, source: "omp" };
};

/** pi 1.4.0 `InteractiveMode` entry methods. Every dialog they build reaches the
 *  mode's dialog stack through `pushExtensionDialog` (bound in focus.ts). */
export const PI_ENTRY_SPECS: EntrySpec[] = [
  { method: "showExtensionSelector", kind: "select", extract: selectFrom },
  { method: "showExtensionConfirm", kind: "confirm", extract: confirmFrom },
  { method: "showExtensionInput", kind: "input", extract: inputFrom(false) },
  { method: "showExtensionEditor", kind: "editor", extract: editorFrom },
  { method: "showExtensionCustom", kind: "custom", factory: true, extract: customFrom },
];

/** Extension/tool UI context methods (both hosts expose the same names). */
export const UI_CONTEXT_SPECS: EntrySpec[] = [
  { method: "select", kind: "select", extract: selectFrom },
  { method: "confirm", kind: "confirm", extract: confirmFrom },
  { method: "input", kind: "input", extract: inputFrom(false) },
  { method: "inputSecret", kind: "input", extract: inputFrom(true) },
  { method: "editor", kind: "editor", extract: editorFrom },
  { method: "custom", kind: "custom", factory: true, extract: customFrom },
  { method: "askDialog", kind: "ask", extract: askFrom },
  { method: "approve", kind: "approval", extract: approvalFrom },
];

/** Fixed titles for OMP's full-screen read-only panels that take no title argument. */
const OMP_PANEL_TITLES: Record<string, string> = {
  showDebugSelector: "Debug",
  showUsageDashboard: "Usage",
  showExtensionsDashboard: "Extensions",
  showAgentsDashboard: "Agents",
};

/** OMP's full-screen dashboards take no title argument; each gets a fixed one. Reports (`showCommandReport`) are command output, handled by OutputCapture (T3.1). */
const panelFrom = (method: string): Extract => () => ({
  kind: "panel",
  title: OMP_PANEL_TITLES[method],
  source: "omp",
});

/** OMP 18.12.5 mode-level delegates that the tool context forwards to. */
export const OMP_ENTRY_SPECS: EntrySpec[] = [
  { method: "showCollabAwareSelector", kind: "select", extract: selectFrom },
  { method: "showHookConfirm", kind: "confirm", extract: confirmFrom },
  { method: "showHookInput", kind: "input", extract: inputFrom(false) },
  { method: "showCollabAwareEditor", kind: "editor", extract: editorFrom },
  { method: "showHookCustom", kind: "custom", factory: true, extract: customFrom },
  { method: "showAskDialog", kind: "ask", extract: askFrom },
  { method: "showCollabAwareApproval", kind: "approval", extract: approvalFrom },
  { method: "showDebugSelector", kind: "panel", extract: panelFrom("showDebugSelector") },
  { method: "showUsageDashboard", kind: "panel", extract: panelFrom("showUsageDashboard") },
  { method: "showExtensionsDashboard", kind: "panel", extract: panelFrom("showExtensionsDashboard") },
  { method: "showAgentsDashboard", kind: "panel", extract: panelFrom("showAgentsDashboard") },
];

/** Maps one entry-method call to its semantic entry (exported for tests). */
export function entryFromCall(spec: EntrySpec, args: unknown[], source: "pi" | "omp"): EntryInfo | undefined {
  if (spec.factory && typeof args[0] !== "function") return undefined;
  const info = spec.extract(args);
  if (!info) return undefined;
  return { ...info, source, method: spec.method };
}

/** How deep inside another entry call the current entry call is running. */
let entryCallDepth = 0;

/** True while the current call stack sits inside a hooked entry call. pi 1.4.0
 *  pushes selector/confirm/input/editor dialogs synchronously inside their
 *  `showExtension*` call; a custom dialog is pushed later, and its factory
 *  wrapper already binds that one itself. */
export function insideEntryCall(): boolean {
  return entryCallDepth > 0;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof value === "object" && typeof (value as PromiseLike<unknown>).then === "function";

/**
 * Wrap every listed entry method of one object. An object/method pair that is
 * already wrapped is skipped (keyed by the object, not the function: hosts hand
 * out a new wrapper on every read), which matters because both hosts expose the
 * same dialog through a tool context *and* a mode method.
 */
export function hookEntryMethods(
  target: Record<string, unknown> | undefined,
  specs: EntrySpec[],
  sink: EntrySink,
  source: "pi" | "omp",
): string[] {
  if (!target) return [];
  const hooked: string[] = [];
  for (const spec of specs) {
    const original = target[spec.method];
    if (typeof original !== "function") continue;
    if (hasStickyMark(target, spec.method, `entry:${spec.method}`)) continue;
    // Pi hands the same dialog function to two objects as their own property:
    // the function already wrapped through one of them must not be wrapped
    // again (H24). An inherited method is shared by every instance of the class
    // by design, so it says nothing about the other object.
    const ownMethod = Object.prototype.hasOwnProperty.call(target, spec.method);
    if (ownMethod && isFunctionMarked(original)) continue;
    const call = original as (...args: unknown[]) => unknown;
    const wrapped = spec.factory
      ? function patchedCustom(this: unknown, ...args: unknown[]): unknown {
          const info = entryFromCall(spec, args, source);
          if (!info) return call.apply(this, args);
          const factory = args[0];
          args[0] = (...factoryArgs: unknown[]) => {
            const bind = (component: unknown): unknown => {
              if (component && typeof component === "object") sink.bind(component as object, info);
              return component;
            };
            const produced = (factory as (...a: unknown[]) => unknown)(...factoryArgs);
            if (produced && typeof (produced as { then?: unknown }).then === "function") {
              return (produced as Promise<unknown>).then(bind);
            }
            return bind(produced);
          };
          return call.apply(this, args);
        }
      : function patchedEntry(this: unknown, ...args: unknown[]): unknown {
          let token: EntryToken | undefined;
          let info: EntryInfo | undefined;
          try {
            info = entryFromCall(spec, args, source);
            if (info) token = sink.push(info, entryCallDepth > 0);
          } catch {
            token = undefined;
          }
          let result: unknown;
          entryCallDepth += 1;
          try {
            result = call.apply(this, args);
          } finally {
            entryCallDepth -= 1;
          }
          // The dialog resolves when the user answers, and that is when the entry
          // stops describing what is on screen. Retiring it at the end of this
          // call loses every dialog whose focus arrives on a later tick (§4.1.2).
          const retire = (): void => { sink.pop(token); };
          if (isThenable(result)) void Promise.resolve(result).then(retire, retire);
          else retire();
          return result;
        };
    Object.defineProperty(wrapped, "name", { value: `ptp:${spec.method}` });
    try {
      target[spec.method] = wrapped;
      mark(target, `entry:${spec.method}`);
      markFunction(original);
      markFunction(wrapped);
      hooked.push(spec.method);
    } catch {
      // Frozen host object: the SnapshotAdapter still covers this dialog.
    }
  }
  return hooked;
}
