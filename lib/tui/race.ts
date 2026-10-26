/**
 * The UI race (§4.12, decision 53): when an extension calls one of the host's
 * dialog methods (`select`, `confirm`, `input`, and on OMP `editor`, `approve`
 * and `askDialog`), the host still draws its dialog, but a Telegram answer goes
 * straight into the extension's own call instead of steering the host
 * component with keystrokes.
 * The wrapper races the plugin-side `RaceHandle` against the host's promise:
 * whoever answers first wins, and a Telegram win aborts the host dialog
 * through the `signal` handed to the original call (measured ~2 ms to close
 * on both hosts, S25).
 *
 * The wrapper goes on *outside* the entry wrapper (`entry.ts`): it registers
 * its handle before the entry wrapper runs, so `FocusTracker.pushEntry` can
 * attach it to the entry the very same call pushes.
 */

import { hasStickyMark, isFunctionRaced, mark, markFunction, markFunctionRaced } from "./install-marks.ts";

export type RaceHandle = {
  /** Answer from Telegram: the first call settles the race with `value`, aborts the host dialog and returns true; later calls return false. */
  answer(value: unknown): boolean;
  readonly settled: boolean;
};

/** The dialog methods `installRace` can wrap. */
export type RaceMethod = "select" | "confirm" | "input" | "editor" | "approve" | "askDialog";

/** Where each dialog method's option object (the one carrying `signal`) sits
 * in the host signature: OMP's `editor(title, prefill, dialogOptions,
 * editorOptions)` keeps a fourth argument, `approve(prompt, dialogOptions)` and
 * `askDialog(questions, dialogOptions?)` take their options second. */

export const OPTS_INDEX: Record<RaceMethod, number> = { select: 2, confirm: 2, input: 2, editor: 2, approve: 1, askDialog: 1 };

/** The handle of the race call currently running synchronously. */
let pendingRace: RaceHandle | undefined;

/**
 * Take the handle registered by the race wrapper whose host call is running
 * right now (the entry wrapper calls this while pushing), so a later
 * `takePendingRace` finds nothing. Cleared by the wrapper as soon as the host
 * method returns synchronously, whatever it returned.
 */
export function takePendingRace(): RaceHandle | undefined {
  const handle = pendingRace;
  pendingRace = undefined;
  return handle;
}

/**
 * Wrap `target[method]` in the race. Skips an object/method pair that already
 * has a race wrapper (keyed by the object, not the function: hosts hand out a
 * new wrapper on every read), so the per-tick `attachEntryHooks` stays
 * idempotent. Returns whether a new wrapper was installed.
 */
export function installRace(
  target: Record<string, unknown>,
  method: RaceMethod,
): boolean {
  const current = target[method];
  if (typeof current !== "function") return false;
  if (hasStickyMark(target, method, `race:${method}`) || isFunctionRaced(current)) return false;
  const call = current as (...args: unknown[]) => unknown;
  const wrapped = function ptpRace(this: unknown, ...args: unknown[]): unknown {
    const controller = new AbortController();
    const index = OPTS_INDEX[method];
    const argsCopy = [...args];
    while (argsCopy.length < index + 1) argsCopy.push(undefined);
    const opts = argsCopy[index] && typeof argsCopy[index] === "object"
      ? (argsCopy[index] as Record<string, unknown>)
      : undefined;
    const caller = opts?.signal;
    const signal = caller instanceof AbortSignal
      ? AbortSignal.any([caller, controller.signal])
      : controller.signal;
    const plugin = Promise.withResolvers<unknown>();
    let settled = false;
    const handle: RaceHandle = {
      get settled(): boolean { return settled; },
      answer(value: unknown): boolean {
        if (settled) return false;
        settled = true;
        plugin.resolve(value);
        controller.abort();
        return true;
      },
    };
    let result: unknown;
    pendingRace = handle;
    try {
      // Every argument past the options object (editor's `editorOptions` at
      // index 3) goes through untouched.
      result = call.apply(this, [...argsCopy.slice(0, index), { ...(opts ?? {}), signal }, ...argsCopy.slice(index + 1)]);
    } finally {
      pendingRace = undefined;
    }
    const host = Promise.resolve(result).then(
      (value) => { settled = true; return value; },
      (error: unknown) => { settled = true; throw error; },
    );
    // A plugin answer wins and the host's late `undefined` is dropped; a host
    // answer (or rejection) wins when the user was faster - errors keep
    // propagating to the extension exactly as they would without the race.
    return Promise.race([plugin.promise, host]);
  };
  Object.defineProperty(wrapped, "name", { value: `ptp-race:${method}` });
  try {
    target[method] = wrapped;
  } catch {
    // Frozen host object: this dialog stays keystroke-driven.
    return false;
  }
  mark(target, `race:${method}`);
  markFunctionRaced(wrapped);
  markFunction(current);
  markFunction(wrapped);
  return true;
}
