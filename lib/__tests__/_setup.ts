/**
 * Global test setup: disable the file logger by default before every test.
 *
 * Many test files (controller, attachments, polling, …) exercise modules that
 * import the `log` singleton. Without this guard, those tests would write real
 * JSON Lines records into the user's actual log directory
 * (`~/.pi/agent/logs/…`) — polluting it with test-generated errors like
 * "command boom" and "photo unavailable".
 *
 * Test files that NEED a working logger (logger.test.ts, telegram-api.test.ts)
 * call `initLogger({ dir: <tmpdir>, level, enabled: true })` in their own
 * beforeEach, which runs after this global hook and re-enables logging into a
 * per-test temp directory.
 *
 * Desktop guard: no test may start a browser, a clipboard writer or any other
 * desktop program (see `_desktop-guard.ts`). A launch that reached the guard
 * and was not drained by its test fails that test here.
 */
import { afterEach, beforeEach } from "vitest";
import { initLogger } from "../logger.ts";
import { drainDesktopLaunches, installDesktopGuard } from "./_desktop-guard.ts";

installDesktopGuard();

beforeEach(() => {
  initLogger({ enabled: false });
});

afterEach(() => {
  const launches = drainDesktopLaunches();
  if (launches.length === 0) return;
  const list = launches.map((launch) => `${launch.api}(${launch.program})`).join(", ");
  throw new Error(`unit test tried to launch a desktop program that was not started: ${list}`);
});