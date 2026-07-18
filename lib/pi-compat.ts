export type PiModel = {
  provider: string;
  id: string;
  name?: string;
};

export type PiAuthType = "oauth" | "api_key";

export type PiCredentialInfo = {
  providerId: string;
  type: PiAuthType;
};

export type PiProviderAuthStatus = {
  configured: boolean;
  source?: string;
  label?: string;
};

export type PiRuntimeAuthPrompt = {
  type?: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  signal?: AbortSignal;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
};

export type PiRuntimeAuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "info"; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
  | { type: "progress"; message: string };

export type PiRuntimeAuthInteraction = {
  signal?: AbortSignal;
  prompt(prompt: PiRuntimeAuthPrompt): Promise<string>;
  notify(event: PiRuntimeAuthEvent): void;
};

export type PiRuntimeAuthMethod = {
  name?: string;
  loginLabel?: string;
  login?: unknown;
  [key: string]: unknown;
};

export type PiRuntimeProvider = {
  id: string;
  name?: string;
  auth?: {
    oauth?: PiRuntimeAuthMethod;
    apiKey?: PiRuntimeAuthMethod;
    api_key?: PiRuntimeAuthMethod;
  };
  [key: string]: unknown;
};

export type PiRuntimeLoginProviderOption = {
  id: string;
  name: string;
  authType: PiAuthType;
  method?: PiRuntimeAuthMethod;
  status?: PiProviderAuthStatus;
};

export type PiLegacyOAuthProvider = {
  id: string;
  name: string;
};

export type PiLegacyCredential = {
  type?: string;
  key?: string;
  [key: string]: unknown;
};

export type PiLegacyAuthStorage = {
  get?(providerId: string): PiLegacyCredential | undefined;
  set?(providerId: string, credential: PiLegacyCredential): void;
  list?(): string[];
  logout?(providerId: string): void;
  getOAuthProviders?(): PiLegacyOAuthProvider[];
  login?(providerId: string, callbacks: unknown): Promise<void>;
};

export type PiModelRegistryCompat = {
  getAvailable?(): unknown;
  getAll?(): unknown;
  find?(provider: string, modelId: string): unknown;
  refresh?(): void | Promise<void>;
  getProviderAuthStatus?(providerId: string): PiProviderAuthStatus;
  getProviderDisplayName?(providerId: string): string;
  authStorage?: PiLegacyAuthStorage;
  [key: string]: unknown;
};

export type PiModelRuntimeCompat = {
  getProviders?(): readonly PiRuntimeProvider[];
  getProvider?(providerId: string): PiRuntimeProvider | undefined;
  getProviderAuthStatus?(providerId: string): PiProviderAuthStatus;
  getAvailable?(providerId?: string): Promise<readonly unknown[]>;
  getAvailableSnapshot?(): readonly unknown[];
  getModels?(providerId?: string): readonly unknown[];
  getModel?(providerId: string, modelId: string): unknown;
  login?(providerId: string, authType: PiAuthType, interaction: PiRuntimeAuthInteraction): Promise<unknown>;
  logout?(providerId: string): Promise<void>;
  listCredentials?(): Promise<readonly PiCredentialInfo[]>;
  refresh?(options?: unknown): Promise<unknown>;
  reloadConfig?(): Promise<void>;
  [key: string]: unknown;
};

export type PiRunnerCompat = {
  getUIContext?(): unknown;
  setUIContext?(ui?: unknown, mode?: PiExtensionMode): void;
  createContext?(): { mode?: PiExtensionMode };
  mode?: PiExtensionMode;
};

export type PiExtensionMode = "tui" | "rpc" | "json" | "print" | string;

export const TELEGRAM_EXTENSION_MODE: PiExtensionMode = "rpc";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isPiModel(value: unknown): value is PiModel {
  return isObject(value)
    && typeof value.provider === "string"
    && typeof value.id === "string";
}

export function toPiModels(value: unknown): PiModel[] {
  return Array.isArray(value) ? value.filter(isPiModel) : [];
}

export function getModelRegistry(ctx: unknown, session: unknown): PiModelRegistryCompat | undefined {
  const ctxRegistry = isObject(ctx) ? ctx.modelRegistry : undefined;
  if (isObject(ctxRegistry)) return ctxRegistry as PiModelRegistryCompat;
  const sessionRegistry = isObject(session) ? session.modelRegistry : undefined;
  return isObject(sessionRegistry) ? sessionRegistry as PiModelRegistryCompat : undefined;
}

export function getModelRuntime(session: unknown): PiModelRuntimeCompat | undefined {
  const runtime = isObject(session) ? session.modelRuntime : undefined;
  return isObject(runtime) ? runtime as PiModelRuntimeCompat : undefined;
}

export function getAvailableModels(ctx: unknown, session: unknown): PiModel[] {
  const registry = getModelRegistry(ctx, session);
  if (typeof registry?.getAvailable === "function") {
    return toPiModels(registry.getAvailable());
  }
  const runtime = getModelRuntime(session);
  return typeof runtime?.getAvailableSnapshot === "function"
    ? toPiModels(runtime.getAvailableSnapshot())
    : [];
}

export function getAllModels(ctx: unknown, session: unknown): PiModel[] {
  const registry = getModelRegistry(ctx, session);
  if (typeof registry?.getAll === "function") {
    return toPiModels(registry.getAll());
  }
  const runtime = getModelRuntime(session);
  return typeof runtime?.getModels === "function"
    ? toPiModels(runtime.getModels())
    : [];
}

export async function getFreshAvailableModels(ctx: unknown, session: unknown): Promise<PiModel[]> {
  const runtime = getModelRuntime(session);
  if (typeof runtime?.getAvailable === "function") {
    return toPiModels(await runtime.getAvailable());
  }
  return getAvailableModels(ctx, session);
}

export async function refreshModelRegistry(registry: PiModelRegistryCompat | undefined): Promise<void> {
  if (typeof registry?.refresh === "function") {
    await Promise.resolve(registry.refresh());
  }
}

export async function refreshModels(ctx: unknown, session: unknown): Promise<void> {
  const runtime = getModelRuntime(session);
  if (typeof runtime?.getAvailable === "function") {
    await runtime.getAvailable();
  } else if (typeof runtime?.reloadConfig === "function") {
    await runtime.reloadConfig();
  }
  await refreshModelRegistry(getModelRegistry(ctx, session));
}

export function getLegacyAuthStorage(ctx: unknown, session: unknown): PiLegacyAuthStorage | undefined {
  return getModelRegistry(ctx, session)?.authStorage;
}

export function hasLegacyAuthStorage(ctx: unknown, session: unknown): boolean {
  const authStorage = getLegacyAuthStorage(ctx, session);
  return !!authStorage && typeof authStorage.getOAuthProviders === "function";
}

export function hasModelRuntimeAuth(session: unknown): boolean {
  const runtime = getModelRuntime(session);
  return !!runtime
    && typeof runtime.getProviders === "function"
    && typeof runtime.login === "function"
    && typeof runtime.logout === "function";
}

export function getRuntimeProviders(session: unknown): PiRuntimeProvider[] {
  const runtime = getModelRuntime(session);
  const providers = typeof runtime?.getProviders === "function" ? runtime.getProviders() : [];
  return Array.isArray(providers)
    ? providers.filter((provider): provider is PiRuntimeProvider => isObject(provider) && typeof provider.id === "string")
    : [];
}

export function getRuntimeLoginProviderOptions(
  session: unknown,
  authType?: PiAuthType,
): PiRuntimeLoginProviderOption[] {
  const runtime = getModelRuntime(session);
  const options: PiRuntimeLoginProviderOption[] = [];
  for (const provider of getRuntimeProviders(session)) {
    const status = runtime?.getProviderAuthStatus?.(provider.id);
    const name = provider.name ?? provider.id;
    if ((!authType || authType === "oauth") && provider.auth?.oauth) {
      options.push({ id: provider.id, name, authType: "oauth", method: provider.auth.oauth, status });
    }
    const apiKeyMethod = provider.auth?.apiKey ?? provider.auth?.api_key;
    if ((!authType || authType === "api_key") && apiKeyMethod) {
      options.push({ id: provider.id, name, authType: "api_key", method: apiKeyMethod, status });
    }
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

export function getRuntimeProviderDisplayName(session: unknown, providerId: string): string | undefined {
  const runtime = getModelRuntime(session);
  return runtime?.getProvider?.(providerId)?.name;
}

export function getProviderDisplayName(ctx: unknown, session: unknown, providerId: string): string {
  return getRuntimeProviderDisplayName(session, providerId)
    ?? getModelRegistry(ctx, session)?.getProviderDisplayName?.(providerId)
    ?? providerId;
}

export function getProviderAuthStatus(
  ctx: unknown,
  session: unknown,
  providerId: string,
): PiProviderAuthStatus | undefined {
  return getModelRuntime(session)?.getProviderAuthStatus?.(providerId)
    ?? getModelRegistry(ctx, session)?.getProviderAuthStatus?.(providerId);
}

export async function listRuntimeCredentials(session: unknown): Promise<PiCredentialInfo[]> {
  const runtime = getModelRuntime(session);
  if (typeof runtime?.listCredentials !== "function") return [];
  const credentials = await runtime.listCredentials();
  return Array.isArray(credentials)
    ? credentials.filter((credential): credential is PiCredentialInfo =>
        isObject(credential)
        && typeof credential.providerId === "string"
        && (credential.type === "oauth" || credential.type === "api_key"),
      )
    : [];
}

export async function runtimeLogin(
  session: unknown,
  providerId: string,
  authType: PiAuthType,
  interaction: PiRuntimeAuthInteraction,
): Promise<void> {
  const runtime = getModelRuntime(session);
  if (typeof runtime?.login !== "function") throw new Error("ModelRuntime login is not available");
  await runtime.login(providerId, authType, interaction);
}

export async function runtimeLogout(session: unknown, providerId: string): Promise<void> {
  const runtime = getModelRuntime(session);
  if (typeof runtime?.logout !== "function") throw new Error("ModelRuntime logout is not available");
  await runtime.logout(providerId);
}

export function getRunnerMode(runner: PiRunnerCompat | undefined, fallback: PiExtensionMode = "tui"): PiExtensionMode {
  try {
    const mode = runner?.createContext?.().mode;
    if (typeof mode === "string") return mode;
  } catch {
    // Older or disposed runners may throw while creating a context; fall back below.
  }
  return typeof runner?.mode === "string" ? runner.mode : fallback;
}

export function setRunnerUiContext(
  runner: PiRunnerCompat | undefined,
  ui: unknown,
  mode: PiExtensionMode = TELEGRAM_EXTENSION_MODE,
): void {
  if (typeof runner?.setUIContext !== "function") return;
  runner.setUIContext(ui, mode);
}

function redactKnownTokenPrefix(value: string): string {
  if (value.startsWith("sk-")) return "sk-…";
  if (value.startsWith("AIza")) return "AIza…";
  if (value.startsWith("github_pat_")) return "github_pat_…";
  if (/^gh[pousr]_/.test(value)) return `${value.slice(0, 4)}…`;
  if (value.startsWith("hf_")) return "hf_…";
  if (value.startsWith("nvapi-")) return "nvapi-…";
  if (/^xox[abprs]-/.test(value)) return `${value.slice(0, 5)}…`;
  if (value.startsWith("ya29.")) return "ya29.…";
  return "…";
}

function looksSecretLike(value: string): boolean {
  return value.length >= 8 && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

function redactLabeledSecret(
  match: string,
  labelQuote: string,
  label: string,
  separator: string,
  valueQuote: string,
  authScheme: string | undefined,
  value: string,
): string {
  const normalizedLabel = label.toLowerCase().replace(/[\s_-]+/g, "_");
  const isGenericKey = normalizedLabel === "key";
  if (isGenericKey && !looksSecretLike(value)) return match;
  const isAuthorization = normalizedLabel === "authorization" || normalizedLabel === "proxy_authorization";
  const safeScheme = isAuthorization ? authScheme ?? "" : "";
  return `${labelQuote}${label}${labelQuote}${separator}${valueQuote}${safeScheme}…${valueQuote}`;
}

function redactUnschemedLabeledSecret(
  match: string,
  labelQuote: string,
  label: string,
  separator: string,
  valueQuote: string,
  value: string,
): string {
  return redactLabeledSecret(match, labelQuote, label, separator, valueQuote, undefined, value);
}

export function commandErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/([?&](?:code|access_token|refresh_token|token|api[_-]?key|key)=)([^&#\s"'{}]+)/gi, "$1…")
    .replace(
      /(["']?)\b((?:proxy[\s_-]*)?authorization)\b\1(\s*[:=]\s*)(["']?)([A-Za-z][A-Za-z0-9._~-]*\s+)?([^"'\s,;&?#{}]+)\4/gi,
      redactLabeledSecret,
    )
    .replace(
      /(["']?)\b((?:x-)?api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|secret|token|key)\b\1(\s*[:=]\s*)(["']?)([^"'\s,;&?#{}]+)\4/gi,
      redactUnschemedLabeledSecret,
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|github_pat_[0-9A-Za-z_]{8,}|gh[pousr]_[0-9A-Za-z_]{8,}|hf_[0-9A-Za-z]{8,}|nvapi-[0-9A-Za-z_-]{8,}|xox[abprs]-[0-9A-Za-z-]{8,}|ya29\.[0-9A-Za-z._-]{8,})\b/g,
      redactKnownTokenPrefix,
    );
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}
