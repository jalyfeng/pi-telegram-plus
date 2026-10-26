/**
 * Host capture view and method hooks (stage 1 of the TUI parity plan).
 *
 * Capture itself still lives in `lib/tui-bridge.ts`; this module is the single
 * view the new TUI modules (focus, origin, gateway, output) read, plus the
 * wrapper primitive they use to observe host methods without replacing them.
 * Stage 5 moves the capture ownership here; until then the bridge is the one
 * patching `InteractiveMode`.
 */
import { getTuiHostState, installTuiBridge, onTuiCaptured, type TuiHost, type TuiHostState } from "../tui-bridge.ts";
import { log } from "../logger.ts";
import { hasStickyMark, inheritFunctionKinds, isFunctionKindMarked, mark, markFunctionKind } from "./install-marks.ts";

const hostLog = log.child("tui-host");

export type HostState = TuiHostState;
export type HostMethod = (this: unknown, ...args: unknown[]) => unknown;

export function isHostObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function currentHostState(): HostState {
  return getTuiHostState();
}

export function currentHostName(): TuiHost {
  return getTuiHostState().host;
}

/** Install the bridge once and notify `listener` for every captured host state. */
export function installHostCapture(): Promise<void> {
  return installTuiBridge().catch((err) => {
    hostLog.debug("host capture failed", { err });
  });
}

export function onHostState(listener: (state: HostState) => void): () => void {
  return onTuiCaptured(listener);
}

/**
 * Wrap a method on an instance or prototype. Multiple hooks may wrap the same
 * method: each object/method/kind is marked (see `install-marks.ts`), so a
 * re-capture does not install the same hook twice, while different modules
 * still compose.
 *
 * The wrapper never changes the return value and never lets an observer throw
 * into the host.
 */
export function hookMethod(
  target: unknown,
  name: string,
  kind: string,
  before?: (args: unknown[], self: unknown) => void,
  after?: (args: unknown[], result: unknown, self: unknown) => void,
): boolean {
  if (!isHostObject(target)) return false;
  const object = target as Record<string, unknown>;
  let current: unknown;
  try {
    current = object[name];
  } catch {
    return false;
  }
  if (typeof current !== "function") return false;
  const hookKey = `hook:${name}:${kind}`;
  // Pi hands one function to two objects; once it is wrapped for this kind,
  // wrapping it again would report the same entry twice (H24).
  if (hasStickyMark(object, name, hookKey) || isFunctionKindMarked(current, kind)) return false;
  const original = current as HostMethod;
  const wrapped: HostMethod = function patchedHostMethod(this: unknown, ...args: unknown[]): unknown {
    if (before) {
      try { before(args, this); } catch (err) { hostLog.debug("host before-hook failed", { kind, name, err }); }
    }
    let result: unknown;
    let failure: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      failure = err;
    }
    if (after) {
      try { after(args, result, this); } catch (err) { hostLog.debug("host after-hook failed", { kind, name, err }); }
    }
    if (failure !== undefined) throw failure;
    return result;
  };
  try {
    object[name] = wrapped;
  } catch {
    return false;
  }
  inheritFunctionKinds(original, wrapped);
  markFunctionKind(wrapped, kind);
  mark(object, hookKey);
  return true;
}

/** Candidate objects that expose status/error/warning on pi and OMP. */
export function statusHosts(state: HostState): Array<Record<string, unknown>> {
  const hosts: Array<Record<string, unknown>> = [];
  for (const value of [state.mode, state.ui]) {
    if (isHostObject(value)) hosts.push(value);
  }
  return hosts;
}

export function readEditorText(): string {
  const { editor, defaultEditor } = getTuiHostState();
  const target = editor ?? defaultEditor;
  if (!isHostObject(target)) return "";
  const getText = target.getText;
  if (typeof getText === "function") {
    try {
      const value = (getText as HostMethod).call(target);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  const value = target.text ?? target.value;
  return typeof value === "string" ? value : "";
}

export function writeEditorText(text: string): boolean {
  const { editor, defaultEditor } = getTuiHostState();
  const target = editor ?? defaultEditor;
  if (!isHostObject(target)) return false;
  const setText = target.setText;
  if (typeof setText !== "function") return false;
  try {
    (setText as HostMethod).call(target, text);
    return true;
  } catch {
    return false;
  }
}
