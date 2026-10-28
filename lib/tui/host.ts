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
import { installHook } from "./hooks.ts";

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
 * Wrap a method on an instance or prototype. The wrapper is the object's single
 * plugin wrapper for `name` (see `hooks.ts`): `kind` names this hook as one
 * stage on it, so installing the same kind again replaces the stage instead of
 * adding a layer.
 *
 * `scope` (optional) is the owner of the stage (such as a FocusTracker or an
 * output capture); `removeOwnerHooks(scope)` removes it again.
 *
 * `before` runs first and `after` runs after the host method, with its result.
 * Observer errors are logged and never reach the host; a host error is rethrown
 * unchanged, and the wrapper returns the host's result as it is.
 */
export function hookMethod(
  target: unknown,
  name: string,
  kind: string,
  before?: (args: unknown[], self: unknown) => void,
  after?: (args: unknown[], result: unknown, self: unknown) => void,
  scope?: object,
): boolean {
  if (!isHostObject(target)) return false;
  return installHook(target, name, `hook:${kind}`, (next, args, self) => {
    if (before) {
      try { before(args, self); } catch (err) { hostLog.debug("host before-hook failed", { kind, name, err }); }
    }
    let result: unknown;
    let failed = false;
    let failure: unknown;
    try {
      result = next(args);
    } catch (err) {
      failed = true;
      failure = err;
    }
    if (after) {
      try { after(args, result, self); } catch (err) { hostLog.debug("host after-hook failed", { kind, name, err }); }
    }
    if (failed) throw failure;
    return result;
  }, { priority: 10, owner: scope });
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
