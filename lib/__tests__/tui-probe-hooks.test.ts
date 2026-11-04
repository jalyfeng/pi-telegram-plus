/**
 * The host probe observes through the shared hook wrappers (`tui/hooks.ts`):
 * a probed method keeps one plugin layer, shared with the focus tracker's
 * stages, and every stage runs once per call.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fn = (...args: unknown[]) => unknown;
type ProbeModule = typeof import("../tui/probe.ts");
type HooksModule = typeof import("../tui/hooks.ts");
type HostModule = typeof import("../tui/host.ts");

let dir = "";
let outputPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ptp-probe-hooks-"));
  outputPath = join(dir, "probe.json");
  vi.stubEnv("PITG_PROBE", outputPath);
  vi.stubEnv("PITG_PROBE_HOST", "pi");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** An editor whose `handleInput` counts the calls the host really receives. */
function makeEditor(): { editor: Record<string, unknown>; hostCalls: () => number } {
  let count = 0;
  const editor: Record<string, unknown> = {
    onSubmit: (() => undefined) as Fn,
    handleInput: (..._args: unknown[]) => {
      count += 1;
      return undefined;
    },
  };
  return { editor, hostCalls: () => count };
}

function readProbeDoc(): { inputCalls: Array<{ kind: string; data: { input?: string } }> } {
  return JSON.parse(readFileSync(outputPath, "utf8")) as {
    inputCalls: Array<{ kind: string; data: { input?: string } }>;
  };
}

describe("probe observers share the hook wrapper with the focus tracker", () => {
  it("keeps one plugin layer when the focus hook is installed before the probe", async () => {
    const probe: ProbeModule = await import("../tui/probe.ts");
    const hooks: HooksModule = await import("../tui/hooks.ts");
    const host: HostModule = await import("../tui/host.ts");
    const { editor, hostCalls } = makeEditor();
    const focusScope = {};
    let focusStage = 0;
    host.hookMethod(editor, "handleInput", "focus-local-input", () => { focusStage += 1; }, undefined, focusScope);

    probe.probeCapture({ editor, session: {}, chatContainer: {} }, "pi");
    expect(hooks.pluginWrapperDepth(editor, "handleInput")).toBe(1);

    (editor.handleInput as Fn)("x");
    (editor.handleInput as Fn)("y");

    expect(focusStage).toBe(2);
    expect(hostCalls()).toBe(2);
    (globalThis as unknown as { __ptpProbe: { flush: () => void } }).__ptpProbe.flush();
    const inputs = readProbeDoc().inputCalls.filter((event) => event.kind === "editor-input");
    expect(inputs.map((event) => event.data.input)).toEqual(["x", "y"]);
  });

  it("keeps one plugin layer when the probe is installed before the focus hook", async () => {
    const probe: ProbeModule = await import("../tui/probe.ts");
    const hooks: HooksModule = await import("../tui/hooks.ts");
    const host: HostModule = await import("../tui/host.ts");
    const { editor, hostCalls } = makeEditor();
    const focusScope = {};
    let focusStage = 0;

    probe.probeCapture({ editor, session: {}, chatContainer: {} }, "pi");
    host.hookMethod(editor, "handleInput", "focus-local-input", () => { focusStage += 1; }, undefined, focusScope);
    expect(hooks.pluginWrapperDepth(editor, "handleInput")).toBe(1);

    (editor.handleInput as Fn)("x");

    expect(focusStage).toBe(1);
    expect(hostCalls()).toBe(1);
  });
});
