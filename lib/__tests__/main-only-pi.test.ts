import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { mainOnlyEvents } from "../main-only-pi.ts";

function createApi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    registerCommand: vi.fn(function (this: unknown, name: string, _options: unknown) {
      return { name, self: this };
    }),
    getCommands: vi.fn(() => [{ name: "x" }]),
  };
  return { api, handlers };
}

describe("mainOnlyEvents", () => {
  it("does not call handlers for a sub-agent context", async () => {
    const { api, handlers } = createApi();
    const handler = vi.fn(() => "result");
    mainOnlyEvents(api as unknown as ExtensionAPI).on("agent_start" as never, handler as never);

    const wrapped = handlers.get("agent_start")!;
    expect(await wrapped({}, { agent: { kind: "sub", id: "s", name: "s", depth: 1 } })).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls handlers for a main-agent context and passes the return value through", async () => {
    const { api, handlers } = createApi();
    const handler = vi.fn(() => ({ block: true }));
    mainOnlyEvents(api as unknown as ExtensionAPI).on("tool_call" as never, handler as never);

    const ctx = { agent: { kind: "main", id: "m", name: "main", depth: 0 } };
    expect(handlers.get("tool_call")!({ a: 1 }, ctx)).toEqual({ block: true });
    expect(handler).toHaveBeenCalledWith({ a: 1 }, ctx);
  });

  it("treats a missing context or a context without agent as the main session", () => {
    const { api, handlers } = createApi();
    const handler = vi.fn(() => "ok");
    mainOnlyEvents(api as unknown as ExtensionAPI).on("session_start" as never, handler as never);

    const wrapped = handlers.get("session_start")!;
    expect(wrapped({})).toBe("ok");
    expect(wrapped({}, undefined)).toBe("ok");
    expect(wrapped({}, {})).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("forwards non-event members unchanged and keeps this bound to the real API", () => {
    const { api } = createApi();
    const wrapped = mainOnlyEvents(api as unknown as ExtensionAPI) as unknown as typeof api;

    expect(wrapped.registerCommand("tg", {})).toEqual({ name: "tg", self: api });
    expect(api.registerCommand).toHaveBeenCalledWith("tg", {});
    expect(wrapped.getCommands()).toEqual([{ name: "x" }]);
  });

  it("returns the unsubscribe function from the real API", () => {
    const { api, handlers } = createApi();
    const unsubscribe = mainOnlyEvents(api as unknown as ExtensionAPI).on("message_end" as never, vi.fn() as never);
    expect(handlers.has("message_end")).toBe(true);
    (unsubscribe as unknown as () => boolean)();
    expect(handlers.has("message_end")).toBe(false);
  });
});
