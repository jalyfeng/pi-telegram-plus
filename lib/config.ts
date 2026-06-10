import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramConfigStore, TelegramWorkspaceConfig } from "./types.ts";

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

export function getTelegramConfigPath(): string {
  return join(getAgentDir(), "tg.json");
}

function emptyStore(): TelegramConfigStore {
  return { version: 2, global: {}, workspaces: [] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTelegramConfigLock<T>(run: () => Promise<T>): Promise<T> {
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
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

function assertV2Store(value: unknown): TelegramConfigStore {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) {
    throw new Error("Unsupported Telegram config format. Please recreate ~/.pi/agent/tg.json as version 2 or run /tg-global-setup.");
  }
  const store = value as TelegramConfigStore;
  return {
    version: 2,
    global: store.global ?? {},
    workspaces: Array.isArray(store.workspaces) ? store.workspaces : [],
  };
}

export async function readTelegramConfigStore(): Promise<TelegramConfigStore> {
  const path = getTelegramConfigPath();
  if (!existsSync(path)) return emptyStore();
  return assertV2Store(JSON.parse(await readFile(path, "utf8")));
}

export async function writeTelegramConfigStore(store: TelegramConfigStore): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const path = getTelegramConfigPath();
  const normalized: TelegramConfigStore = {
    version: 2,
    global: store.global ?? {},
    workspaces: store.workspaces ?? [],
  };
  await writeFile(path, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

export function resolveTelegramConfigStore(store: TelegramConfigStore, cwd: string): ResolvedTelegramConfig {
  const normalizedCwd = normalizePath(cwd);
  const workspaces = store.workspaces ?? [];
  const match = workspaces
    .map((workspace) => ({ ...workspace, path: normalizePath(workspace.path) }))
    .filter((workspace) => isPathInsideOrEqual(normalizedCwd, workspace.path))
    .sort((a, b) => b.path.length - a.path.length)[0];

  if (match) {
    return { store, scope: "workspace", workspacePath: match.path, config: match.config ?? {} };
  }
  return { store, scope: "global", config: store.global ?? {} };
}

export async function readResolvedTelegramConfig(cwd: string): Promise<ResolvedTelegramConfig> {
  return resolveTelegramConfigStore(await readTelegramConfigStore(), cwd);
}

function mergeTelegramConfigForWrite(existing: TelegramConfig | undefined, incoming: TelegramConfig): TelegramConfig {
  const next = { ...(incoming ?? {}) };
  const existingOffset = existing?.lastUpdateId;
  const incomingOffset = incoming.lastUpdateId;
  if (typeof existingOffset === "number" || typeof incomingOffset === "number") {
    next.lastUpdateId = Math.max(
      typeof existingOffset === "number" ? existingOffset : -1,
      typeof incomingOffset === "number" ? incomingOffset : -1,
    );
  }
  return next;
}

export async function writeResolvedTelegramConfig(resolved: ResolvedTelegramConfig, config: TelegramConfig): Promise<ResolvedTelegramConfig> {
  return await withTelegramConfigLock(async () => {
    // Re-read the store while holding the lock. Multiple pi instances / workspace
    // bots can persist polling offsets and active chats concurrently; writing the
    // stale session_start snapshot would overwrite other bots' newer workspace config.
    // Preserve lastUpdateId monotonically so stale async handlers cannot regress
    // the durable Telegram offset after polling has advanced it.
    const store = await readTelegramConfigStore();
    if (resolved.scope === "workspace" && resolved.workspacePath) {
      const workspacePath = normalizePath(resolved.workspacePath);
      const workspaces = store.workspaces ?? [];
      const index = workspaces.findIndex((workspace) => normalizePath(workspace.path) === workspacePath);
      const existing = index >= 0 ? workspaces[index].config : undefined;
      const nextConfig = mergeTelegramConfigForWrite(existing, config);
      if (index >= 0) workspaces[index] = { path: workspacePath, config: nextConfig };
      else workspaces.push({ path: workspacePath, config: nextConfig });
      store.workspaces = workspaces;
    } else {
      store.global = mergeTelegramConfigForWrite(store.global, config);
    }
    await writeTelegramConfigStore(store);
    return resolveTelegramConfigStore(store, resolved.workspacePath ?? process.cwd());
  });
}

export async function bindWorkspaceTelegramConfig(cwd: string, config: TelegramConfig): Promise<ResolvedTelegramConfig> {
  return await withTelegramConfigLock(async () => {
    const store = await readTelegramConfigStore();
    const workspacePath = normalizePath(cwd);
    const workspaces = store.workspaces ?? [];
    const index = workspaces.findIndex((workspace) => normalizePath(workspace.path) === workspacePath);
    const entry: TelegramWorkspaceConfig = { path: workspacePath, config };
    if (index >= 0) workspaces[index] = entry;
    else workspaces.push(entry);
    workspaces.sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)));
    store.workspaces = workspaces;
    await writeTelegramConfigStore(store);
    return resolveTelegramConfigStore(store, workspacePath);
  });
}

export async function unbindWorkspaceTelegramConfig(cwd: string): Promise<ResolvedTelegramConfig> {
  return await withTelegramConfigLock(async () => {
    const store = await readTelegramConfigStore();
    const current = resolveTelegramConfigStore(store, cwd);
    if (current.scope === "workspace" && current.workspacePath) {
      const workspacePath = normalizePath(current.workspacePath);
      store.workspaces = (store.workspaces ?? []).filter((workspace) => normalizePath(workspace.path) !== workspacePath);
      await writeTelegramConfigStore(store);
    }
    return resolveTelegramConfigStore(store, cwd);
  });
}

/**
 * Update only the global section of the Telegram config store.
 * Merges with existing global config and preserves lastUpdateId monotonically.
 */
export async function writeGlobalTelegramConfig(config: TelegramConfig): Promise<void> {
  await withTelegramConfigLock(async () => {
    const store = await readTelegramConfigStore();
    store.global = mergeTelegramConfigForWrite(store.global, config);
    await writeTelegramConfigStore(store);
  });
}
