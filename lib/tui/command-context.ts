/**
 * Command call-chain context (v8 §0.2): OutputCapture claims a host chat
 * component only when it is added inside the call chain of the command that
 * submitted it. The chain is carried by `AsyncLocalStorage`: the synchronous
 * part of the submit call and every await continuation started from it see the
 * store; agent event handling runs in the agent loop's own async context and
 * does not.
 *
 * Two places switch the context off inside a command chain:
 * - `outside`: the command starts an agent turn (`session.prompt`); its output
 *   belongs to the renderer, not to the command.
 * - `history`: the host rebuilds the transcript from session history
 *   (`/resume`, `/fork`, compaction redraws); rebuilt history is not output.
 *
 * The store lives on `globalThis` under a `Symbol.for` key so every module
 * instance (OMP `?mtime=` imports, `/reload`) shares one storage.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandScope } from "./origin.ts";

export type CommandContext =
  | { kind: "command"; scope: CommandScope }
  | { kind: "outside" }
  | { kind: "history" };

const STORAGE_KEY = Symbol.for("pi-telegram-plus.command-context");

function storage(): AsyncLocalStorage<CommandContext> {
  const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<CommandContext> | undefined>;
  let current = holder[STORAGE_KEY];
  if (!current) {
    current = new AsyncLocalStorage<CommandContext>();
    holder[STORAGE_KEY] = current;
  }
  return current;
}

/** Run `fn` inside the call chain of the command `scope`. */
export function runInCommand<T>(scope: CommandScope, fn: () => T): T {
  return storage().run({ kind: "command", scope }, fn);
}

/** Run `fn` as an agent turn that the command started: nothing it adds is command output. */
export function runOutsideCommand<T>(fn: () => T): T {
  return storage().run({ kind: "outside" }, fn);
}

/** Run `fn` as a host history rebuild: nothing it adds is command output. */
export function runAsHistory<T>(fn: () => T): T {
  return storage().run({ kind: "history" }, fn);
}

/** The scope of the command whose call chain is running, if any. */
export function currentCommandScope(): CommandScope | undefined {
  const context = storage().getStore();
  return context?.kind === "command" ? context.scope : undefined;
}
