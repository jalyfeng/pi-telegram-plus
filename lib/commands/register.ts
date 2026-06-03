import type { CapturedAgentSession } from "../types.ts";
import { registerModelCommands } from "./model.ts";
import { registerSessionCommands } from "./session.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerInfoCommands } from "./info.ts";
import { registerLifecycleCommands } from "./lifecycle.ts";
import { registerSettingsCommands } from "./settings.ts";
import { registerTgConfigCommands } from "./tg-config.ts";

export type CommandRegistry = {
  registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
};

/** Minimal base deps — most commands only need session access. */
export type SessionDeps = {
  getSession: () => CapturedAgentSession | undefined;
};

/** Extended deps for session commands that also manage session names. */
export type SessionNameDeps = SessionDeps & {
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
};

/** Deps for tg-config command. */
export type TgConfigDeps = SessionDeps & {
  getConfig: () => import("../types.ts").TelegramConfig;
  setConfig: (c: import("../types.ts").TelegramConfig) => void;
  persistConfig: (c: import("../types.ts").TelegramConfig) => Promise<void>;
};

export function registerAllCommands(registry: CommandRegistry, sessionDeps: SessionDeps, sessionNameDeps: SessionNameDeps, tgConfigDeps?: TgConfigDeps): void {
  registerSettingsCommands(registry, sessionDeps);
  registerModelCommands(registry, sessionDeps);
  registerSessionCommands(registry, sessionNameDeps);
  registerAuthCommands(registry, sessionDeps);
  registerInfoCommands(registry, sessionDeps);
  registerLifecycleCommands(registry);
  if (tgConfigDeps) registerTgConfigCommands(registry, tgConfigDeps);
}