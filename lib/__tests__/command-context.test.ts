import { describe, expect, it } from "vitest";
import { currentCommandScope, runDetached, runInCommand } from "../tui/command-context.ts";
import type { CommandScope } from "../tui/origin.ts";

const scopeA = { id: "resume", label: "resume" } as unknown as CommandScope;

describe("runDetached", () => {
  it("runs with no command scope even when started from a command", () => {
    const seen = runInCommand(scopeA, () => runDetached(() => currentCommandScope()));
    expect(seen).toBeUndefined();
  });

  it("keeps later async continuations of detached work free of the command scope", async () => {
    const seen = await runInCommand(scopeA, () => runDetached(async () => {
      const before = currentCommandScope();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [before, currentCommandScope()];
    }));
    expect(seen).toEqual([undefined, undefined]);
  });

  it("does not leak the detached state back into the command that started it", async () => {
    await runInCommand(scopeA, async () => {
      await runDetached(async () => undefined);
      expect(currentCommandScope()).toBe(scopeA);
    });
  });

  it("detached timers created inside it do not see the command scope", async () => {
    const seen = await runInCommand(scopeA, () => runDetached(() => new Promise<CommandScope | undefined>((resolve) => {
      setTimeout(() => resolve(currentCommandScope()), 1);
    })));
    expect(seen).toBeUndefined();
  });
});
