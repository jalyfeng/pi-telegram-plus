/**
 * Zero-dependency file logger for pi-telegram-plus.
 *
 * Design (see README "Logging"):
 * - Levels: debug / info / warn / error. A minimum level filters records.
 * - Format: JSON Lines — one self-contained JSON object per line, so remote
 *   Telegram issues can be grep'd / jq'd after the fact.
 * - Sink: file only, under the pi agent cache dir (`~/.pi/agent/logs/` or
 *   `$PI_CODING_AGENT_DIR/logs/`). One file per calendar day (UTC):
 *   `pi-telegram-plus-YYYY-MM-DD.log`. When a day file exceeds `maxFileSize`
 *   it is rotated logrotate-style (`…-YYYY-MM-DD.1.log`, `…-YYYY-MM-DD.2.log`,
 *   …) keeping at most `maxFiles` rotations per day.
 * - Never touches the console: pi runs in TUI/RPC/JSON modes where console
 *   output pollutes the TUI input box. The logger is side-effect-free w.r.t.
 *   the terminal.
 * - Never throws: every public method swallows its own internal errors so a
 *   logging failure can never crash the extension or alter control flow. The
 *   silent catches inside this module are intentional and localized to the
 *   logger itself.
 * - Serialized writes: a single module-level promise chain orders all appends
 *   and rotations, so the root logger and every `child()` share one sink and
 *   cannot interleave or race on the same day file.
 *
 * Usage:
 *   import { log } from "./logger.ts";
 *   log.warn("HTML fallback", { reason, snippet });
 *   const apiLog = log.child("telegram-api");
 *   apiLog.error("send failed", { chatId, code });
 *
 * `index.ts` calls `initLogger({ dir?, level? })` at activation to pin the log
 * directory to the active pi agent dir; before that the logger falls back to a
 * computed default and degrades to a no-op if the directory cannot be created.
 */

import { appendFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per day file before rotation
const DEFAULT_MAX_FILES = 5; // rotated suffixes kept per day
const FILE_PREFIX = "pi-telegram-plus-";

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Tagged sub-logger: every record carries `scope=<scope>` in addition to any parent scope. */
  child(scope: string): Logger;
  /** Returns a `.catch` handler that logs the rejection at `level` with the given msg/fields plus `err`, then resolves to `undefined` (preserves the `T | undefined` shape of the promise chain for probes like `stat(path).catch(swallow(...))`). */
  swallow(level: LogLevel, msg: string, fields?: LogFields): (err: unknown) => undefined;
}

interface LoggerConfig {
  dir: string;
  minLevel: LogLevel;
  maxFileSize: number;
  maxFiles: number;
  enabled: boolean;
}

/** Default log directory: mirrors config.getAgentDir() without importing it (avoid a cycle). */
function defaultLogDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "logs");
}

function todayStamp(d = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoTs(d = new Date()): string {
  return d.toISOString();
}

function safeStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // A non-serializable field (circular, BigInt) would break the line; replace
    // fields with a safe fallback so we never lose the log event entirely.
    try {
      return JSON.stringify({ ...record, fields: "[unserializable]" });
    } catch {
      return JSON.stringify({ ts: isoTs(), level: record.level, msg: String(record.msg ?? ""), error: "[unserializable]" });
    }
  }
}

function ensureFieldSafety(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "symbol") out[k] = v.toString();
    else if (typeof v === "function") out[k] = `[function ${v.name || "anonymous"}]`;
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, stack: v.stack };
    else {
      // Probe serializability; downgrade to string if it fails.
      try { JSON.stringify(v); out[k] = v; } catch { out[k] = String(v); }
    }
  }
  return out;
}

// ---- Shared sink: one queue + size tracker for ALL loggers (root + children) ----

const sink = {
  queue: Promise.resolve(),
  currentDate: undefined as string | undefined,
  currentSize: 0,
  dirReady: false,
};

/** Reset sink state — used by tests to get a clean queue between cases. */
export function __resetSinkForTests(): void {
  sink.queue = Promise.resolve();
  sink.currentDate = undefined;
  sink.currentSize = 0;
  sink.dirReady = false;
}

function basePath(cfg: LoggerConfig, stamp: string): string {
  return join(cfg.dir, `${FILE_PREFIX}${stamp}.log`);
}
function rotatedPath(cfg: LoggerConfig, stamp: string, n: number): string {
  return join(cfg.dir, `${FILE_PREFIX}${stamp}.${n}.log`);
}

async function sizeOfFile(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

/**
 * logrotate-style rotation for one day: shift `.N` → `.N+1` up to maxFiles-1,
 * drop the one that falls off the end, then rename the base file to `.1`. The
 * next append recreates the base file fresh.
 */
async function rotate(cfg: LoggerConfig, stamp: string): Promise<void> {
  try {
    const max = cfg.maxFiles;
    for (let n = max - 1; n >= 1; n--) {
      await rename(rotatedPath(cfg, stamp, n), rotatedPath(cfg, stamp, n + 1)).catch(() => undefined);
    }
    await rename(basePath(cfg, stamp), rotatedPath(cfg, stamp, 1)).catch(() => undefined);
  } catch {
    // Best-effort: on failure keep appending to the base file (may exceed cap).
  }
}

async function appendLine(cfg: LoggerConfig, line: string): Promise<void> {
  if (!cfg.enabled) return;
  if (!sink.dirReady) {
    try {
      await mkdir(cfg.dir, { recursive: true });
      sink.dirReady = true;
    } catch {
      // Cannot create log dir (read-only fs, permissions). Degrade to no-op.
      cfg.enabled = false;
      return;
    }
  }
  const stamp = todayStamp();
  if (sink.currentDate !== stamp) {
    sink.currentDate = stamp;
    sink.currentSize = await sizeOfFile(basePath(cfg, stamp));
  }
  const base = basePath(cfg, stamp);
  const lineBytes = Buffer.byteLength(line);
  if (sink.currentSize + lineBytes > cfg.maxFileSize && sink.currentSize > 0) {
    await rotate(cfg, stamp);
    sink.currentSize = 0;
  }
  try {
    await appendFile(base, line, { encoding: "utf8" });
    sink.currentSize += lineBytes;
  } catch {
    // Append failed (disk full, etc.). Drop the line; next call retries.
  }
}

function enqueue(cfg: LoggerConfig, line: string): void {
  sink.queue = sink.queue
    .then(() => appendLine(cfg, line))
    .catch(() => undefined); // never let a logging error escape or break the chain
}

// ---- Logger implementation ----

class FileLogger implements Logger {
  readonly level: LogLevel;
  private readonly scope: string | undefined;
  private readonly cfg: LoggerConfig;

  constructor(cfg: LoggerConfig, scope?: string) {
    this.cfg = cfg;
    this.level = cfg.minLevel;
    this.scope = scope;
  }

  child(scope: string): Logger {
    const merged = this.scope ? `${this.scope}:${scope}` : scope;
    return new FileLogger(this.cfg, merged);
  }

  swallow(level: LogLevel, msg: string, fields?: LogFields): (err: unknown) => undefined {
    return (err) => { this.emit(level, msg, { ...fields, err }); return undefined; };
  }

  debug(msg: string, fields?: LogFields): void { this.emit("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void { this.emit("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.emit("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.emit("error", msg, fields); }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!this.cfg.enabled) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.cfg.minLevel]) return;
    const record: Record<string, unknown> = {
      ts: isoTs(),
      level,
      msg,
      ...(this.scope ? { scope: this.scope } : {}),
      ...ensureFieldSafety(fields),
    };
    enqueue(this.cfg, safeStringify(record) + "\n");
  }
}

// ---- Module-level singleton ----

const initialConfig: LoggerConfig = {
  dir: defaultLogDir(),
  minLevel: "info",
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  maxFiles: DEFAULT_MAX_FILES,
  enabled: true,
};

export interface InitLoggerOptions {
  dir?: string;
  level?: LogLevel;
  maxFileSize?: number;
  maxFiles?: number;
  enabled?: boolean;
}

/**
 * Pin logger configuration at extension activation. Call once from `index.ts`
 * before any subsystem logs. Mutates the shared config object in place so the
 * root logger and all existing `child()` loggers pick up the new settings.
 */
export function initLogger(options?: InitLoggerOptions): void {
  initialConfig.dir = options?.dir ?? defaultLogDir();
  initialConfig.minLevel = options?.level ?? "info";
  initialConfig.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  initialConfig.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  initialConfig.enabled = options?.enabled ?? true;
  // Re-stat the new day file on the next append (dir may have changed).
  sink.currentDate = undefined;
  sink.currentSize = 0;
  sink.dirReady = false;
}

/** Read-only access to the resolved log directory (for /status diagnostics). */
export function getLogDir(): string {
  return initialConfig.dir;
}

export function getLogLevel(): LogLevel {
  return initialConfig.minLevel;
}

export function isLoggingEnabled(): boolean {
  return initialConfig.enabled;
}

/** The default root logger. Module-scoped loggers should use `log.child("<scope>")`. */
export const log: Logger = new FileLogger(initialConfig);

/**
 * Test/inspection helper: drain the in-flight write queue and return today's
 * log file paths actually on disk. Not used at runtime.
 */
export async function __drainAndListFiles(dir?: string): Promise<string[]> {
  await sink.queue.catch(() => undefined);
  const target = dir ?? initialConfig.dir;
  try {
    const entries = await readdir(target);
    return entries.filter((e) => e.startsWith(FILE_PREFIX)).sort().map((e) => join(target, e));
  } catch {
    return [];
  }
}