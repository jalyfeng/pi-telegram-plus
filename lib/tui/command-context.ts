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

/** Where a command's own lines go: OutputCapture registers itself while it runs. */
export type CommandMessageRoute = {
  /** Adds one line to the message of `scope`; false when that scope owns no live message. */
  notice(scope: CommandScope, html: string): boolean;
};

const ROUTE_KEY = Symbol.for("pi-telegram-plus.command-message-route");

function holder(): { route?: CommandMessageRoute } {
  const g = globalThis as unknown as Record<symbol, { route?: CommandMessageRoute } | undefined>;
  g[ROUTE_KEY] ??= {};
  return g[ROUTE_KEY] as { route?: CommandMessageRoute };
}

/** Install `route` as the active one; it stays until `clearCommandMessageRoute` removes it. */
export function setCommandMessageRoute(route: CommandMessageRoute): void {
  holder().route = route;
}

/** Clears the route only if `route` is still the installed one (a replaced runtime must not clear its successor). */
export function clearCommandMessageRoute(route: CommandMessageRoute): void {
  const current = holder();
  if (current.route === route) current.route = undefined;
}

/** Adds `html` to the message of the running command; false when no live command message owns it. */
export function routeCommandNotice(html: string): boolean {
  const scope = currentCommandScope();
  const route = holder().route;
  return scope !== undefined && route !== undefined && route.notice(scope, html);
}
