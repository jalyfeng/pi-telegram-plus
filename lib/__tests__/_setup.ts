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
 */
import { beforeEach } from "vitest";
import { initLogger } from "../logger.ts";

beforeEach(() => {
  initLogger({ enabled: false });
});