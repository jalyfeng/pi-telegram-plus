/**
 * Desktop guard for unit tests. pi's login dialog calls `openBrowser(url)`,
 * which spawns `open` / `xdg-open` / `rundll32`, so one `npm test` opened the
 * developer's real browser. This module wraps the `node:child_process`
 * launchers: a call that would start a desktop program (browser opener,
 * clipboard writer, ...) is recorded and answered with a fake result, and
 * nothing is started. Every other command runs as usual.
 *
 * `_setup.ts` installs the guard for every test file and fails any test that
 * left a recorded launch behind. A test that expects a launch drains the
 * record itself with `drainDesktopLaunches()`.
 *
 * The state lives on `globalThis` so that the copy loaded by a setup file and
 * the copy loaded by a test file share one record.
 */
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

/** Programs that open a browser/file or write the system clipboard. */
const DESKTOP_PROGRAMS = new Set([
  "open",
  "xdg-open",
  "wslview",
  "rundll32",
  "explorer",
  "start",
  "clip",
  "pbcopy",
  "xclip",
  "xsel",
  "wl-copy",
  "osascript",
]);

export type DesktopLaunch = {
  /** The launcher API that was called, e.g. `spawn` or `exec`. */
  api: string;
  /** The desktop program name, lower-cased, without `.exe`. */
  program: string;
  /** The arguments or the shell command string as the caller passed them. */
  args: unknown[];
};

const LAUNCHES_KEY = Symbol.for("pitg.desktopLaunches");
const GUARD_MARK = Symbol.for("pitg.desktopGuard");

type Launches = DesktopLaunch[];
const launches: Launches = ((globalThis as Record<symbol, unknown>)[LAUNCHES_KEY] ??= []) as Launches;

type Api = "spawn" | "spawnSync" | "exec" | "execSync" | "execFile" | "execFileSync";
const APIS: readonly Api[] = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"];
const SHELL_APIS = new Set<Api>(["exec", "execSync"]);

type ChildProcessModule = Record<string, unknown> & { [GUARD_MARK]?: boolean };
const childProcess = createRequire(import.meta.url)("node:child_process") as ChildProcessModule;

function programName(token: string): string {
  return basename(token).toLowerCase().replace(/\.exe$/, "");
}

/** The desktop program this call would start, or undefined when it is harmless. */
function desktopProgramOf(api: Api, args: unknown[]): string | undefined {
  if (SHELL_APIS.has(api)) {
    // Shell strings: check the first word of every command segment.
    const command = typeof args[0] === "string" ? args[0] : "";
    for (const segment of command.split(/[;&|\n()]+/)) {
      const first = segment.trim().split(/\s+/)[0] ?? "";
      const program = programName(first);
      if (program && DESKTOP_PROGRAMS.has(program)) return program;
    }
    return undefined;
  }
  const file = typeof args[0] === "string" ? args[0] : "";
  const options = (Array.isArray(args[1]) ? args[2] : args[1]) as { shell?: unknown } | undefined;
  if (options?.shell) {
    const command = [file, ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
    return desktopProgramOf("exec", [command]);
  }
  const program = programName(file);
  return DESKTOP_PROGRAMS.has(program) ? program : undefined;
}

/** Stands in for a ChildProcess that never started: no pid, no pipes, no events. */
function fakeChild(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
    killed: false,
    connected: false,
    kill: () => true,
    ref() {},
    unref() {},
    send: () => false,
    disconnect() {},
  });
}

function blockedError(program: string): Error {
  return new Error(`blocked in unit tests: ${program} would launch a desktop program`);
}

function guardedLauncher(api: Api, real: (...args: unknown[]) => unknown) {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    const program = desktopProgramOf(api, args);
    if (program === undefined) return real.apply(this, args);
    launches.push({ api, program, args: [...args] });
    if (api.endsWith("Sync")) throw blockedError(program);
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const error = blockedError(program);
      process.nextTick(() => (callback as (e: Error) => void)(error));
    }
    return fakeChild();
  };
}

/** Wrap the launchers once per process. Safe to call from every test file. */
export function installDesktopGuard(): void {
  if (childProcess[GUARD_MARK]) return;
  for (const api of APIS) {
    const real = childProcess[api] as (...args: unknown[]) => unknown;
    childProcess[api] = guardedLauncher(api, real);
  }
  childProcess[GUARD_MARK] = true;
  // ESM importers of `node:child_process` see the wrapped functions only after
  // this sync; the pi modules import their launchers as ESM named bindings.
  syncBuiltinESMExports();
}

/** Returns every recorded desktop launch and clears the record. */
export function drainDesktopLaunches(): DesktopLaunch[] {
  return launches.splice(0, launches.length);
}
