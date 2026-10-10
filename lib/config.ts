import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BotRecord, BotRegistry, ProjectTelegramBinding, ResolvedTelegramConfig, TelegramConfig, TelegramRenderLevel } from "./types.ts";
import { log } from "./logger.ts";

const configLog = log.child("config");

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getTelegramConfigPath(): string {
  return join(getAgentDir(), "tg.json");
}

function emptyRegistry(): BotRegistry {
  return { version: 3, bots: [] };
}

export function enableConfiguredTelegramOnStartup(config: TelegramConfig): TelegramConfig {
  if (!config.botToken || config.telegramEnabled === true) return config;
  return { ...config, telegramEnabled: true };
}

const sleep = (ms: number) => new Promise<void>((resolveP) => setTimeout(resolveP, ms));

export async function withTelegramConfigLock<T>(run: () => Promise<T>): Promise<T> {
  await mkdir(getAgentDir(), { recursive: true });
  const lockPath = join(getAgentDir(), "tg.json.lock");
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockPath).then((s) => s.mtimeMs).catch(() => Date.now()));
      if (age > 30_000 || Date.now() - started > 10_000) {
        await rm(lockPath, { recursive: true, force: true }).catch(configLog.swallow("warn", "rm stale config lock failed", { lockPath }));
        continue;
      }
      await sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lockPath).catch(configLog.swallow("warn", "rmdir config lock failed on release", { lockPath }));
  }
}

// ── Registry (v3) read / write ────────────────────────────────────────────

export async function readBotRegistry(): Promise<BotRegistry> {
  const path = getTelegramConfigPath();
  if (!existsSync(path)) return emptyRegistry();
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await sleep(25);
    value = JSON.parse(await readFile(path, "utf8"));
  }
  const migrated = await migrateToV3(value);
  // If migration occurred, persist the v3 registry on disk.
  const isMigration = !value || typeof value !== "object" || (value as { version?: unknown }).version !== 3;
  if (isMigration) {
    await withTelegramConfigLock(async () => {
      await writeBotRegistry(migrated);
    }).catch(configLog.swallow("warn", "persist migrated Telegram registry failed", { path }));
  }
  return migrated;
}

export async function writeBotRegistry(registry: BotRegistry): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const path = getTelegramConfigPath();
  const normalized: BotRegistry = {
    version: 3,
    bots: registry.bots ?? [],
    ...(registry.defaultBotId === undefined ? {} : { defaultBotId: registry.defaultBotId }),
  };
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600).catch(configLog.swallow("warn", "chmod registry file failed", { path }));
}

export function findBotById(registry: BotRegistry, id: string): BotRecord | undefined {
  return registry.bots.find((bot) => bot.id === id);
}

export function findBotByName(registry: BotRegistry, name: string): BotRecord | undefined {
  const lower = name.toLowerCase();
  return registry.bots.find((bot) => bot.name.toLowerCase() === lower);
}

export function findBotByIdOrName(registry: BotRegistry, query: string): BotRecord | undefined {
  return findBotById(registry, query) ?? findBotByName(registry, query);
}

// ── Project binding (.pi/telegram.json) read / write ──────────────────────

/**
 * Walk up from `cwd` to find the nearest `.pi/telegram.json` file.
 * Returns the parsed binding and its directory, or undefined if not found.
 */
export async function readProjectBinding(cwd: string): Promise<{ path: string; binding: ProjectTelegramBinding } | undefined> {
  let dir = resolve(cwd);
  while (true) {
    const bindingPath = join(dir, ".pi", "telegram.json");
    if (existsSync(bindingPath)) {
      try {
        const raw = await readFile(bindingPath, "utf8");
        const binding = JSON.parse(raw) as ProjectTelegramBinding;
        return { path: dir, binding };
      } catch {
        // Corrupt binding file — treat as not found so caller falls back to default.
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function getProjectBindingPath(projectDir: string): string {
  return join(resolve(projectDir), ".pi", "telegram.json");
}

export async function writeProjectBinding(projectDir: string, binding: ProjectTelegramBinding): Promise<void> {
  const dir = resolve(projectDir);
  const piDir = join(dir, ".pi");
  await mkdir(piDir, { recursive: true });
  const path = getProjectBindingPath(dir);
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(binding, null, 2) + "\n", { mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600).catch(configLog.swallow("warn", "chmod project binding failed", { path }));
}

export async function removeProjectBinding(projectDir: string): Promise<void> {
  const path = getProjectBindingPath(projectDir);
  await rm(path, { force: true }).catch(configLog.swallow("warn", "remove project binding failed", { path }));
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the Telegram configuration for a given working directory.
 *
 * 1. Walk up from `cwd` to find `<project>/.pi/telegram.json`.
 *    - Found: botId = binding.botId ?? registry.defaultBotId; prefs from binding; runtime state from binding.
 *    - Not found: use registry.defaultBotId; prefs = defaults; no persisted runtime state.
 * 2. No bot resolves (no botId and no defaultBotId) → telegram not configured.
 * 3. Materialize ResolvedTelegramConfig from BotRecord + project prefs + runtime state.
 */
export async function resolveTelegramConfig(cwd: string): Promise<ResolvedTelegramConfig> {
  const registry = await readBotRegistry();
  const project = await readProjectBinding(cwd);

  const projectBotId = project?.binding.botId;
  let bot: BotRecord | undefined;
  if (projectBotId) {
    bot = findBotById(registry, projectBotId);
    // Dangling ref (bot removed): fall back to defaultBotId so the project
    // stays connected instead of silently becoming unconfigured.
    if (!bot && registry.defaultBotId) {
      bot = findBotById(registry, registry.defaultBotId);
    }
  } else if (registry.defaultBotId) {
    bot = findBotById(registry, registry.defaultBotId);
  }

  const config = materializeTelegramConfig(bot, project?.binding);

  return {
    registry,
    bot,
    hasProjectBinding: !!project,
    ...(project === undefined ? {} : { projectPath: project.path }),
    config,
  };
}

/**
 * Combine a BotRecord (identity) with a project binding (prefs + runtime state)
 * into a single TelegramConfig. Pure function for testability.
 */
export function materializeTelegramConfig(
  bot: BotRecord | undefined,
  binding: ProjectTelegramBinding | undefined,
): TelegramConfig {
  if (!bot) {
    // No bot resolves — check if binding says enabled (for status display).
    if (binding?.enabled === false) return { telegramEnabled: false };
    return {};
  }

  const config: TelegramConfig = {
    botToken: bot.token,
    ...(bot.botUsername === undefined ? {} : { botUsername: bot.botUsername }),
    ...(bot.allowedUserId === undefined ? {} : { allowedUserId: bot.allowedUserId }),
    ...(bot.pairingCode === undefined ? {} : { pairingCode: bot.pairingCode }),
    ...(bot.apiBase === undefined ? {} : { apiBase: bot.apiBase }),
  };

  // Project binding overrides prefs + runtime state.
  if (binding) {
    if (binding.enabled === undefined) {
      config.telegramEnabled = true; // file exists → default enabled
    } else {
      config.telegramEnabled = binding.enabled;
    }
    if (binding.tool !== undefined) config.tool = binding.tool;
    if (binding.thinking !== undefined) config.thinking = binding.thinking;
    if (binding.retryCount !== undefined) config.retryCount = binding.retryCount;
    if (binding.lastUpdateId !== undefined) config.lastUpdateId = binding.lastUpdateId;
    if (binding.activeChatId !== undefined) config.activeChatId = binding.activeChatId;
  } else {
    // No project binding → enabled by default if a bot resolves.
    config.telegramEnabled = true;
  }

  return config;
}

/**
 * Read resolved config from registry + project binding. Used as a replacement
 * for the old readResolvedTelegramConfig.
 */
export async function readResolvedTelegramConfig(cwd: string): Promise<ResolvedTelegramConfig> {
  return resolveTelegramConfig(cwd);
}

/**
 * Persist per-project runtime state + prefs to the project binding file, and
 * return a ResolvedTelegramConfig reflecting the post-write state.
 *
 * - Bound project: writes lastUpdateId (monotonic max), activeChatId, tool,
 *   thinking, retryCount to `<project>/.pi/telegram.json`; preserves botId.
 *   Never writes the registry.
 * - Unbound project: writes nothing (no .pi to write to). Re-resolves with
 *   `cwd` to pick up default-bot changes, then preserves in-memory runtime/
 *   pref state so the caller's `config = resolvedConfig.config` does not drop
 *   state that has no durable home. The coordinator cursor stays authoritative
 *   for polling; activeChatId is re-learned on restart.
 *
 * `cwd` is the resolution directory (defaults to the resolved project path or
 * process.cwd()) and is used only on the unbound path to re-resolve correctly.
 */
export async function persistProjectRuntimeState(
  resolved: ResolvedTelegramConfig,
  config: TelegramConfig,
  cwd?: string,
): Promise<ResolvedTelegramConfig> {
  if (!resolved.hasProjectBinding || !resolved.projectPath) {
    const resolveCwd = cwd ?? resolved.projectPath ?? process.cwd();
    const fresh = await resolveTelegramConfig(resolveCwd);
    return { ...fresh, config: preserveInMemoryRuntimeState(fresh.config, config) };
  }

  const projectDir = resolved.projectPath;
  // Read the registry once outside the config lock to avoid re-entrant lock
  // acquisition (resolveTelegramConfig would otherwise re-read it inside).
  const registry = await readBotRegistry();
  return await withTelegramConfigLock(async () => {
    const existing = await readProjectBinding(projectDir);
    const binding: ProjectTelegramBinding = existing?.binding ?? {};

    // Persist runtime state + per-project prefs. Preserve botId.
    if (typeof config.lastUpdateId === "number") {
      binding.lastUpdateId = Math.max(
        binding.lastUpdateId ?? -1,
        config.lastUpdateId,
      );
    }
    if (typeof config.activeChatId === "number") {
      binding.activeChatId = config.activeChatId;
    }
    if (config.tool !== undefined) binding.tool = config.tool;
    if (config.thinking !== undefined) binding.thinking = config.thinking;
    if (config.retryCount !== undefined) binding.retryCount = config.retryCount;

    await writeProjectBinding(projectDir, binding);

    // Materialize from the snapshot registry + just-written binding (no
    // re-entrant registry read inside the lock).
    const botId = binding.botId ?? registry.defaultBotId;
    let bot: BotRecord | undefined;
    if (botId) {
      bot = findBotById(registry, botId);
      if (!bot && binding.botId && registry.defaultBotId) {
        bot = findBotById(registry, registry.defaultBotId);
      }
    }
    return {
      registry,
      bot,
      hasProjectBinding: true,
      projectPath: projectDir,
      config: materializeTelegramConfig(bot, binding),
    };
  });
}

/**
 * Fill in-memory runtime/pref fields that `persisted` lacks from `memory`, so
 * an unbound project (no .pi/telegram.json) does not lose activeChatId /
 * lastUpdateId / tool / thinking / retryCount across a persist cycle. Values
 * already present in `persisted` (restored from disk for bound projects) win.
 */
export function preserveInMemoryRuntimeState(
  persisted: TelegramConfig,
  memory: TelegramConfig,
): TelegramConfig {
  return {
    ...persisted,
    ...(persisted.lastUpdateId === undefined && typeof memory.lastUpdateId === "number"
      ? { lastUpdateId: memory.lastUpdateId }
      : {}),
    ...(persisted.activeChatId === undefined && typeof memory.activeChatId === "number"
      ? { activeChatId: memory.activeChatId }
      : {}),
    ...(persisted.tool === undefined && memory.tool !== undefined ? { tool: memory.tool } : {}),
    ...(persisted.thinking === undefined && memory.thinking !== undefined ? { thinking: memory.thinking } : {}),
    ...(persisted.retryCount === undefined && memory.retryCount !== undefined
      ? { retryCount: memory.retryCount }
      : {}),
  };
}

/**
 * Bind a project to a registered bot. Writes `<project>/.pi/telegram.json`.
 * Does NOT re-paste the token — references the bot by id.
 */
export async function bindProjectTelegram(
  cwd: string,
  botId: string,
  options?: { enabled?: boolean; tool?: TelegramRenderLevel; thinking?: TelegramRenderLevel },
): Promise<ResolvedTelegramConfig> {
  const projectDir = resolve(cwd);
  const binding: ProjectTelegramBinding = {
    botId,
    enabled: options?.enabled ?? true,
    ...(options?.tool === undefined ? {} : { tool: options.tool }),
    ...(options?.thinking === undefined ? {} : { thinking: options.thinking }),
  };
  await writeProjectBinding(projectDir, binding);
  return resolveTelegramConfig(projectDir);
}

/**
 * Remove a project's Telegram binding. The project falls back to defaultBotId.
 */
export async function unbindProjectTelegram(cwd: string): Promise<ResolvedTelegramConfig> {
  const projectDir = resolve(cwd);
  await removeProjectBinding(projectDir);
  return resolveTelegramConfig(projectDir);
}

// ── Migration (v2 → v3) ───────────────────────────────────────────────────

/** Paths that could not be written during migration (non-fatal warnings). */
export type MigrationWarnings = { skippedPaths: string[] };

/**
 * Migrate a v2 store (or legacy flat config) to a v3 registry.
 * For workspaces, writes per-project `.pi/telegram.json` files.
 * Returns the v3 registry. Non-throwing for unwritable workspace paths.
 */
async function migrateToV3(value: unknown): Promise<BotRegistry> {
  if (value && typeof value === "object" && (value as { version?: unknown }).version === 3) {
    const raw = value as BotRegistry;
    return {
      version: 3,
      bots: Array.isArray(raw.bots) ? raw.bots : [],
      ...(raw.defaultBotId === undefined ? {} : { defaultBotId: raw.defaultBotId }),
    };
  }

  const warnings: MigrationWarnings = { skippedPaths: [] };
  const bots: BotRecord[] = [];
  let defaultBotId: string | undefined;

  // Handle legacy flat config (no version field) → treat as global.
  if (isLegacyFlatConfig(value)) {
    const flatConfig = value as TelegramConfig;
    if (flatConfig.botToken) {
      const bot = createBotRecordFromConfig(flatConfig, flatConfig.botUsername ?? "default");
      bots.push(bot);
      defaultBotId = bot.id;
    }
    return { version: 3, bots, ...(defaultBotId === undefined ? {} : { defaultBotId }) };
  }

  // Handle v2 store.
  if (value && typeof value === "object" && (value as { version?: unknown }).version === 2) {
    const store = value as {
      version: 2;
      global?: TelegramConfig;
      workspaces?: Array<{ path: string; config: TelegramConfig }>;
    };

    // Migrate global → default bot.
    if (store.global?.botToken) {
      const existingBot = bots.find((b) => b.token === store.global!.botToken);
      if (existingBot) {
        defaultBotId = existingBot.id;
      } else {
        const bot = createBotRecordFromConfig(store.global, store.global.botUsername ?? "default");
        bots.push(bot);
        defaultBotId = bot.id;
      }
    }

    // Migrate workspaces → project .pi/telegram.json files.
    for (const workspace of store.workspaces ?? []) {
      if (!workspace.config?.botToken) continue;
      const wsPath = resolve(workspace.path);

      // Dedup by token: if a bot with the same token already exists, reuse its id.
      let bot = bots.find((b) => b.token === workspace.config!.botToken);
      if (!bot) {
        const name = workspace.config.botUsername ?? basename(wsPath);
        bot = createBotRecordFromConfig(workspace.config, name);
        bots.push(bot);
      }

      // Write project .pi/telegram.json — skip if path doesn't exist or isn't writable.
      try {
        if (!existsSync(wsPath)) {
          warnings.skippedPaths.push(wsPath);
          continue;
        }
        const binding: ProjectTelegramBinding = {
          botId: bot.id,
          enabled: workspace.config.telegramEnabled !== false,
          ...(workspace.config.tool === undefined ? {} : { tool: workspace.config.tool }),
          ...(workspace.config.thinking === undefined ? {} : { thinking: workspace.config.thinking }),
          ...(workspace.config.retryCount === undefined ? {} : { retryCount: workspace.config.retryCount }),
          ...(workspace.config.lastUpdateId === undefined ? {} : { lastUpdateId: workspace.config.lastUpdateId }),
          ...(workspace.config.activeChatId === undefined ? {} : { activeChatId: workspace.config.activeChatId }),
        };
        await writeProjectBinding(wsPath, binding);
      } catch {
        warnings.skippedPaths.push(wsPath);
      }
    }

    if (warnings.skippedPaths.length > 0) {
      configLog.warn("migration skipped unwritable workspace paths", { skippedPaths: warnings.skippedPaths });
    }

    return { version: 3, bots, ...(defaultBotId === undefined ? {} : { defaultBotId }) };
  }

  throw new Error("Unsupported Telegram config format. Please recreate ~/.pi/agent/tg.json as version 3 or run /tg-bot-add.");
}

function createBotRecordFromConfig(config: TelegramConfig, name: string): BotRecord {
  return {
    id: randomUUID(),
    name,
    token: config.botToken!,
    ...(config.botUsername === undefined ? {} : { botUsername: config.botUsername }),
    ...(config.allowedUserId === undefined ? {} : { allowedUserId: config.allowedUserId }),
    ...(config.pairingCode === undefined ? {} : { pairingCode: config.pairingCode }),
    ...(config.apiBase === undefined ? {} : { apiBase: config.apiBase }),
  };
}

function isLegacyFlatConfig(value: unknown): value is TelegramConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !("version" in record) && !("global" in record) && !("workspaces" in record) && !("bots" in record);
}

// ── Bot registry CRUD helpers ─────────────────────────────────────────────

export async function addBot(bot: BotRecord): Promise<BotRegistry> {
  return await withTelegramConfigLock(async () => {
    const registry = await readBotRegistryUnsafe();
    registry.bots.push(bot);
    // First bot becomes default automatically.
    if (registry.bots.length === 1 && !registry.defaultBotId) {
      registry.defaultBotId = bot.id;
    }
    await writeBotRegistry(registry);
    return registry;
  });
}

export async function updateBot(id: string, updates: Partial<Omit<BotRecord, "id">>): Promise<BotRegistry> {
  return await withTelegramConfigLock(async () => {
    const registry = await readBotRegistryUnsafe();
    const index = registry.bots.findIndex((b) => b.id === id);
    if (index < 0) throw new Error(`Bot not found: ${id}`);
    registry.bots[index] = { ...registry.bots[index], ...updates };
    await writeBotRegistry(registry);
    return registry;
  });
}

export async function removeBot(id: string): Promise<BotRegistry> {
  return await withTelegramConfigLock(async () => {
    const registry = await readBotRegistryUnsafe();
    registry.bots = registry.bots.filter((b) => b.id !== id);
    if (registry.defaultBotId === id) {
      delete registry.defaultBotId;
      // If there's exactly one remaining bot, promote it to default.
      if (registry.bots.length === 1) {
        registry.defaultBotId = registry.bots[0].id;
      }
    }
    await writeBotRegistry(registry);
    return registry;
  });
}

export async function setDefaultBot(id: string): Promise<BotRegistry> {
  return await withTelegramConfigLock(async () => {
    const registry = await readBotRegistryUnsafe();
    if (!registry.bots.some((b) => b.id === id)) {
      throw new Error(`Bot not found: ${id}`);
    }
    registry.defaultBotId = id;
    await writeBotRegistry(registry);
    return registry;
  });
}

/**
 * Read registry without migration-on-read side effects (for use inside the
 * config lock to avoid recursive lock acquisition).
 */
async function readBotRegistryUnsafe(): Promise<BotRegistry> {
  const path = getTelegramConfigPath();
  if (!existsSync(path)) return emptyRegistry();
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await sleep(25);
    value = JSON.parse(await readFile(path, "utf8"));
  }
  if (value && typeof value === "object" && (value as { version?: unknown }).version === 3) {
    const rawRegistry = value as BotRegistry;
    return {
      version: 3,
      bots: Array.isArray(rawRegistry.bots) ? rawRegistry.bots : [],
      ...(rawRegistry.defaultBotId === undefined ? {} : { defaultBotId: rawRegistry.defaultBotId }),
    };
  }
  // If still v2/legacy inside the lock, migrate in-place without writing back.
  return migrateToV3(value);
}