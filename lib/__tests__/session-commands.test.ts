import { describe, expect, it, vi } from "vitest";
import { registerSessionCommands } from "../commands/session.ts";
import type { CommandRegistry, SessionDeps } from "../commands/register.ts";

type HandlerEntry = {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function makeRegistry(): { registry: CommandRegistry; handlers: Map<string, HandlerEntry> } {
  const handlers = new Map<string, HandlerEntry>();
  return {
    handlers,
    registry: {
      registerCommand: (name, options) => {
        handlers.set(name, {
          name,
          description: options.description,
          handler: options.handler as HandlerEntry["handler"],
        });
      },
    },
  };
}

function makeDeps(isOmp: boolean): SessionDeps {
  return { getSession: () => undefined, isOmpHost: () => isOmp };
}

function makeCtx() {
  const notify = vi.fn();
  const input = vi.fn(async () => undefined);
  return { ctx: { ui: { notify, input }, cwd: "/work" }, notify, input };
}

describe("registerSessionCommands /cd", () => {
  it("registers the context switch on pi", () => {
    const { registry, handlers } = makeRegistry();
    registerSessionCommands(registry, makeDeps(false));

    expect(handlers.get("cd")?.description).toBe("Switch pi working directory");
  });

  it("registers /cd on OMP without a description so it never becomes a TUI command", () => {
    const { registry, handlers } = makeRegistry();
    registerSessionCommands(registry, makeDeps(true));

    const cd = handlers.get("cd");
    expect(cd).toBeDefined();
    expect(cd?.description).toBeUndefined();
  });

  it("answers /cd on OMP with a /move hint carrying the requested path", async () => {
    const { registry, handlers } = makeRegistry();
    registerSessionCommands(registry, makeDeps(true));
    const { ctx, notify, input } = makeCtx();

    await handlers.get("cd")!.handler("~/proj", ctx);

    expect(input).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("This host switches directories with /move ~/proj.", "info");
  });

  it("answers a bare /cd on OMP with the /move placeholder", async () => {
    const { registry, handlers } = makeRegistry();
    registerSessionCommands(registry, makeDeps(true));
    const { ctx, notify, input } = makeCtx();

    await handlers.get("cd")!.handler("", ctx);

    expect(input).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("This host switches directories with /move <path>.", "info");
  });

  it("uses the imported host probe when no override is supplied", () => {
    const { registry, handlers } = makeRegistry();
    // The test environment has no host module loaded, so the real probe reports
    // pi and /cd keeps its description and handler.
    registerSessionCommands(registry, { getSession: () => undefined });

    expect(handlers.get("cd")?.description).toBe("Switch pi working directory");
  });
});
