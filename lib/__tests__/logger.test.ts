import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __drainAndListFiles,
  __resetSinkForTests,
  getLogDir,
  getLogLevel,
  initLogger,
  isLoggingEnabled,
  log,
  type LogLevel,
} from "../logger.ts";

function freshDir(): string {
  return join(tmpdir(), `pi-tg-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function drain(): Promise<void> {
  await __drainAndListFiles().catch(() => undefined);
}

let dir: string;

beforeEach(() => {
  dir = freshDir();
  __resetSinkForTests();
  initLogger({ dir, level: "debug" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function readTodayLog(): Promise<string> {
  await drain();
  const files = await __drainAndListFiles(dir);
  const base = files.find((f) => /^\S+\/pi-telegram-plus-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  if (!base) throw new Error("no base log file produced");
  return readFile(base, "utf8");
}

function parseLines(text: string): Record<string, unknown>[] {
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

describe("logger — file sink", () => {
  it("writes JSON Lines records with ts/level/msg/scope", async () => {
    const api = log.child("telegram-api");
    api.warn("HTML fallback", { reason: "bad tags", snippet: "hi" });
    log.info("startup");
    const text = await readTodayLog();
    const records = parseLines(text);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ level: "warn", msg: "HTML fallback", scope: "telegram-api", reason: "bad tags", snippet: "hi" });
    expect(records[1]).toMatchObject({ level: "info", msg: "startup" });
    expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects minimum level (info filters out debug)", async () => {
    initLogger({ dir, level: "info" });
    log.debug("hidden");
    log.info("shown");
    const records = parseLines(await readTodayLog());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ msg: "shown" });
  });

  it("child scopes nest with ':'", async () => {
    const polling = log.child("polling");
    const sub = polling.child("lock");
    sub.error("lock stale");
    const records = parseLines(await readTodayLog());
    expect(records[0]).toMatchObject({ scope: "polling:lock", msg: "lock stale", level: "error" });
  });

  it("serializes Error fields into name/message/stack", async () => {
    const err = new Error("boom");
    log.error("send failed", { err, chatId: 123 });
    const r = parseLines(await readTodayLog())[0];
    expect((r.err as any).name).toBe("Error");
    expect((r.err as any).message).toBe("boom");
    expect(typeof (r.err as any).stack).toBe("string");
    expect(r.chatId).toBe(123);
  });

  it("downgrades unserializable fields (circular) to a string, never throws", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    log.info("weird", { payload: circular });
    const r = parseLines(await readTodayLog())[0];
    expect(r.msg).toBe("weird");
    // Either the field was stringified or replaced with [unserializable] marker;
    // either way the line is valid JSON and the event is preserved.
    expect(typeof r.payload).toBe("string");
  });

  it("rotates when the day file exceeds maxFileSize (logrotate-style)", async () => {
    initLogger({ dir, level: "debug", maxFileSize: 120, maxFiles: 3 });
    const api = log.child("api");
    for (let i = 0; i < 30; i++) api.info(`event ${i}`, { i });
    await drain();
    const files = (await __drainAndListFiles(dir)).map((f) => f.split("/").pop()!);
    // Base file plus at least one rotation suffix.
    expect(files.some((f) => /^\S+-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
    expect(files.some((f) => /^\S+-\d{4}-\d{2}-\d{2}\.1\.log$/.test(f))).toBe(true);
    // Base file must be under the cap (rotation triggers before exceeding).
    const base = files.find((f) => /^\S+-\d{4}-\d{2}-\d{2}\.log$/.test(f))!;
    expect((await stat(join(dir, base))).size).toBeLessThanOrEqual(120);
  });

  it("never throws and degrades to no-op if the log dir cannot be created", async () => {
    // Point at a path under a file (not a dir) so mkdir fails.
    initLogger({ dir: "/dev/null/impossible", level: "debug" });
    expect(() => log.error("anything")).not.toThrow();
    await drain();
    // No file written; the call was a no-op.
    expect(await __drainAndListFiles("/dev/null/impossible")).toEqual([]);
  });

  it("getLogLevel / getLogDir / isLoggingEnabled reflect init", () => {
    initLogger({ dir, level: "warn", enabled: true });
    expect(getLogLevel()).toBe("warn" as LogLevel);
    expect(getLogDir()).toBe(dir);
    expect(isLoggingEnabled()).toBe(true);
  });
});