import type { TuiHost } from "./tui-bridge.ts";

/**
 * Host commands that only make sense in the terminal: they act on the host
 * machine or show their result only there. They are kept out of the Telegram
 * menus and the /tg command list, and a typed Telegram message is answered
 * with a hint instead of being forwarded to the host.
 */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "local",
  "dump",
  "open",
  "stats",
  "trace",
  "record",
  "live",
  "git",
  "tree",
  "copy",
  "mcp",
  "context",
]);

const toCommandName = (name: string): string => name.replace(/_/g, "-").toLowerCase();

/**
 * Whether a command must not be offered in Telegram or forwarded to the host.
 * `cd` is terminal-only on OMP only: OMP has its own `/move`, and the plugin's
 * `/cd` cannot create a session there.
 */
export function isTerminalOnlyCommand(name: string, host: TuiHost): boolean {
  // `/git:foo` is the host's `/git` with a suffix: judged by its base name.
  const normalized = toCommandName(name).split(":")[0] ?? "";
  if (TERMINAL_ONLY_COMMANDS.has(normalized)) return true;
  return host === "omp" && normalized === "cd";
}

/** The hint sent back to Telegram for a terminal-only command. Plain text; escape before HTML sending. */
export function terminalOnlyReply(name: string, host: TuiHost): string {
  const normalized = toCommandName(name);
  if (host === "omp" && normalized === "cd") {
    return "On OMP, use /move <path> to change the working directory.";
  }
  return `/${normalized} only works in the terminal.`;
}
