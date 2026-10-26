import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AnyHandler = (event: unknown, ctx: unknown, ...rest: unknown[]) => unknown;

/**
 * OMP runs every sub-agent session through the same extension factory, so the
 * event handlers of a sub-agent session are registered on the same process.
 * `ctx.agent.kind === "sub"` identifies those sessions. pi has no sub-agents
 * and no `ctx.agent`, so a missing agent is always treated as the main session.
 */
function isSubagentContext(ctx: unknown): boolean {
  const agent = (ctx as { agent?: { kind?: unknown } } | undefined)?.agent;
  return agent?.kind === "sub";
}

function mainOnlyHandler(handler: AnyHandler): AnyHandler {
  return (event, ctx, ...rest) => {
    if (isSubagentContext(ctx)) return undefined;
    return handler(event, ctx, ...rest);
  };
}

/**
 * Wraps the extension API so that `pi.on` handlers do not run inside sub-agent
 * sessions. Every other member is forwarded unchanged with its `this` bound to
 * the real API.
 */
export function mainOnlyEvents(pi: ExtensionAPI): ExtensionAPI {
  const on = (event: string, handler: AnyHandler) =>
    (pi.on as unknown as (event: string, handler: AnyHandler) => () => void)(event, mainOnlyHandler(handler));
  return new Proxy(pi, {
    get(target, prop) {
      if (prop === "on") return on;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
