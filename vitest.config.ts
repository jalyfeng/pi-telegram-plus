import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Per-run agent dir for the whole test process. The logger resolves its log
// directory from PI_CODING_AGENT_DIR when the module is evaluated, so every
// logger instance (including ones re-imported after vi.resetModules()) writes
// under this temporary directory and never into the user's real ~/.pi/agent.
const testAgentDir = mkdtempSync(join(tmpdir(), "pitg-vitest-"));

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    setupFiles: ["lib/__tests__/_setup.ts"],
    env: {
      PI_CODING_AGENT_DIR: testAgentDir,
    },
  },
});
