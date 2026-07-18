import type { CommandRegistry } from "./register.ts";
import type { CapturedAgentSession } from "../types.ts";
import type { PiModel } from "../pi-compat.ts";
import { getAllModels, getAvailableModels } from "../pi-compat.ts";

/**
 * Safely set the model on the session.
 * AgentSession.prototype.setModel() throws on auth failure;
 * this helper catches the error and returns a user-friendly message.
 */
async function trySetModel(
  session: CapturedAgentSession,
  model: PiModel,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await (session.setModel as (model: unknown) => Promise<void>)(model);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function formatModel(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * All command handlers capture ctx.ui at entry and use the captured reference
 * for notifications. This is critical because ctx.ui is a getter that reads
 * runner.uiContext, which gets reset to TUI UI after rebindSession (triggered
 * by newSession/fork/switchSession). The captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerModelCommands(
  registry: CommandRegistry,
  deps: { getSession: () => CapturedAgentSession | undefined },
): void {
  // ── /model ────────────────────────────────────────────────────────────
  registry.registerCommand("model", {
    description: "Show or change the current model",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (args) {
        const needle = args.toLowerCase();
        // Prefer available (auth'd) models, fall back to all models so
        // the user gets a clear auth error instead of "not found".
        const model =
          getAvailableModels(ctx, session).find((m) => {
            const ref = formatModel(m).toLowerCase();
            return ref === needle || m.id.toLowerCase() === needle || ref.includes(needle);
          }) ??
          getAllModels(ctx, session).find((m) => {
            const ref = formatModel(m).toLowerCase();
            return ref === needle || m.id.toLowerCase() === needle || ref.includes(needle);
          });
        if (!model) {
          ui.notify(`Model not found: ${args}`, "error");
          return;
        }
        const result = await trySetModel(session, model);
        if (result.ok) {
          ui.notify(`Model set: ${formatModel(model)}`, "info");
        } else {
          ui.notify(result.error, "error");
        }
        return;
      }

      const available = getAvailableModels(ctx, session);
      if (available.length === 0) {
        ui.notify("No authenticated models available. Use /login to add an API key.", "error");
        return;
      }

      const shown = available;
      const current = session.model;
      const labels = shown.map((m) =>
        (current && formatModel(current) === formatModel(m) ? "● " : "  ") + formatModel(m),
      );
      const choice = await ui.select("Select model", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0 || index >= shown.length) return;
      const selected = shown[index];
      const result = await trySetModel(session, selected);
      if (result.ok) {
        ui.notify(`Model set: ${formatModel(selected)}`, "info");
      } else {
        ui.notify(result.error, "error");
      }
    },
  });

  // ── /scoped-models ───────────────────────────────────────────────────
  registry.registerCommand("scoped-models", {
    description: "Show or select from scoped models",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      const scoped = session.scopedModels;
      if (!scoped || scoped.length === 0) {
        const allModels = getAvailableModels(ctx, session);
        if (allModels.length === 0) {
          ui.notify("No authenticated models. Use /login to add an API key.", "info");
          return;
        }
        const labels = allModels.map((m) => formatModel(m));
        const choice = await ui.select("No scoped models. Set one?", labels);
        if (!choice) return;
        const idx = labels.indexOf(choice);
        if (idx < 0) return;
        const selected = allModels[idx];
        const setResult = await trySetModel(session, selected);
        if (!setResult.ok) {
          ui.notify(setResult.error, "error");
          return;
        }
        session.setScopedModels([{ model: selected as any }]);
        ui.notify(`Scoped to ${formatModel(selected)}`, "info");
        return;
      }

      const labels = scoped.map((sm) =>
        formatModel(sm.model) + (sm.thinkingLevel ? ` (${sm.thinkingLevel})` : ""),
      );
      const choice = await ui.select("Scoped models", labels);
      if (!choice) return;
      const index = labels.indexOf(choice);
      if (index < 0 || index >= scoped.length) return;
      const sm = scoped[index];
      const switchResult = await trySetModel(session, sm.model);
      if (!switchResult.ok) {
        ui.notify(switchResult.error, "error");
        return;
      }
      if (sm.thinkingLevel) session.setThinkingLevel(sm.thinkingLevel);
      ui.notify(`Switched to ${formatModel(sm.model)}`, "info");
    },
  });

  // ── /thinking ────────────────────────────────────────────────────────
  registry.registerCommand("thinking", {
    description: "Show or change thinking level",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (args) {
        session.setThinkingLevel(args as any);
        ui.notify(`Thinking level set: ${args}`, "info");
        return;
      }

      const levels = session.getAvailableThinkingLevels();
      if (levels.length === 0) {
        ui.notify("Current model does not support thinking levels.", "info");
        return;
      }

      const current = session.thinkingLevel;
      const labels = levels.map((l) =>
        (l === current ? "● " : "  ") + String(l),
      );
      const choice = await ui.select("Thinking level", labels);
      if (!choice) return;
      const selected = levels[labels.indexOf(choice)];
      if (selected === undefined) return;
      session.setThinkingLevel(selected);
      ui.notify(`Thinking level set: ${selected}`, "info");
    },
  });
}