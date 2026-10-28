import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

function isUnder(path: string, parent: string): boolean {
  const child = resolve(path);
  const base = resolve(parent);
  return child === base || child.startsWith(base + sep);
}

describe("unit test logger isolation", () => {
  it("a logger re-imported after vi.resetModules() writes under the temp dir, not ~/.pi", async () => {
    vi.resetModules();
    const fresh = await import("../logger.ts");

    const logDir = fresh.getLogDir();
    expect(isUnder(logDir, tmpdir())).toBe(true);
    expect(isUnder(logDir, join(homedir(), ".pi"))).toBe(false);

    const probe = `isolation probe ${Date.now()}`;
    fresh.log.error(probe, { source: "logger-isolation.test" });
    const files = await fresh.__drainAndListFiles();
    expect(files.length).toBeGreaterThan(0);

    const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
    expect(contents.some((c) => c.includes(probe))).toBe(true);
    for (const f of files) {
      expect(isUnder(f, tmpdir())).toBe(true);
      expect(isUnder(f, join(homedir(), ".pi"))).toBe(false);
    }
  });
});
