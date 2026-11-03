/**
 * /new on OMP: the host prints its own "✔ New session started" line into the command's
 * message, so the plugin must not add a second "✅ New session started." (P2-35 follow-up).
 * pi keeps the plugin's notice: its gateway path does not print one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOmpHost } from "../session-capture.ts";
import { registerSessionCommands } from "../commands/session.ts";
import type { CommandRegistry } from "../commands/register.ts";

vi.mock("../session-capture.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../session-capture.ts")>();
  return { ...mod, isOmpHost: vi.fn(() => false) };
});

afterEach(() => {
  vi.mocked(isOmpHost).mockReturnValue(false);
});

type NewHandler = (args: string, ctx: unknown) => Promise<void>;

function newHandler(options: { omp: boolean; withSetUIContext: boolean }): NewHandler {
  vi.mocked(isOmpHost).mockReturnValue(options.omp);
  let handler: NewHandler | undefined;
  const registry: CommandRegistry = {
    registerCommand: (name, opts) => {
      if (name === "new") handler = opts.handler as unknown as NewHandler;
    },
  };
  const session = {
    extensionRunner: options.withSetUIContext ? { setUIContext: () => undefined } : {},
  };
  registerSessionCommands(registry, { getSession: () => session as never });
  if (!handler) throw new Error("/new not registered");
  return handler;
}

function ctxFor(notify: ReturnType<typeof vi.fn>) {
  return {
    ui: { confirm: vi.fn(async () => true), notify },
    // The host runs the post-replacement hook: OMP passes `setup`, pi passes `withSession`.
    newSession: vi.fn(async (hooks: { setup?: () => Promise<void>; withSession?: () => Promise<void> }) => {
      await (hooks.setup ?? hooks.withSession)?.();
      return {};
    }),
  };
}

describe("/new started notice", () => {
  it("does not add the plugin's notice on OMP, where the host prints its own line", async () => {
    const notify = vi.fn();
    const handler = newHandler({ omp: true, withSetUIContext: false });
    await handler("", ctxFor(notify));
    expect(notify).not.toHaveBeenCalledWith("✅ New session started.", "info");
  });

  it("keeps the plugin's notice on pi", async () => {
    const notify = vi.fn();
    const handler = newHandler({ omp: false, withSetUIContext: true });
    await handler("", ctxFor(notify));
    expect(notify).toHaveBeenCalledWith("✅ New session started.", "info");
  });
});
