import type { CommandRegistry } from "./register.ts";
import type { CapturedAgentSession } from "../types.ts";
import {
  commandErrorMessage,
  getLegacyAuthStorage,
  getModelRegistry,
  getRuntimeLoginProviderOptions,
  hasModelRuntimeAuth,
  listRuntimeCredentials,
  refreshModelRegistry,
  refreshModels,
  runtimeLogin,
  runtimeLogout,
  type PiAuthType,
  type PiLegacyAuthStorage,
  type PiModelRegistryCompat,
  type PiRuntimeAuthEvent,
  type PiRuntimeAuthInteraction,
  type PiRuntimeAuthPrompt,
  type PiRuntimeLoginProviderOption,
} from "../pi-compat.ts";

// ── Types ───────────────────────────────────────────────────────────────

type AuthType = PiAuthType;

type TelegramAuthUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
};

type ProviderOption = {
  id: string;
  name: string;
  authType: AuthType;
};

// ── Shared helpers ──────────────────────────────────────────────────────

function formatAuthType(authType: AuthType): string {
  return authType === "oauth" ? "subscription" : "API key";
}

function makeUniqueLabels<T>(items: T[], labelFor: (item: T) => string, disambiguate: (item: T) => string): string[] {
  const baseLabels = items.map(labelFor);
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return items.map((item, index) => {
    const label = baseLabels[index];
    return (counts.get(label) ?? 0) > 1 ? `${label} ${disambiguate(item)}` : label;
  });
}

async function refreshAfterAuth(ctx: unknown, session: CapturedAgentSession, ui: TelegramAuthUi): Promise<void> {
  try {
    await refreshModels(ctx, session);
  } catch (error) {
    ui.notify(`Credentials updated, but model refresh failed: ${commandErrorMessage(error)}`, "warning");
  }
}

function providerNotFound(ui: TelegramAuthUi, providerId: string): void {
  ui.notify(`Login provider not found: ${providerId}`, "error");
}

function labelWithStatus(label: string, status?: string): string {
  return status ? `${label} ${status}` : label;
}

// ── ModelRuntime path (pi 0.80.8+) ──────────────────────────────────────

function runtimeStatusLabel(option: PiRuntimeLoginProviderOption): string {
  const status = option.status;
  if (!status?.configured) return "";
  const source = status.label ?? status.source;
  return source ? `✓ ${source}` : "✓ configured";
}

function formatRuntimeLabel(option: PiRuntimeLoginProviderOption): string {
  return labelWithStatus(option.name, runtimeStatusLabel(option));
}

function findRuntimeProviderOptions(session: CapturedAgentSession, providerRef: string): PiRuntimeLoginProviderOption[] {
  const normalized = providerRef.trim().toLowerCase();
  if (!normalized) return [];
  return getRuntimeLoginProviderOptions(session).filter((provider) =>
    provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
  );
}

async function promptWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("Login cancelled");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(new Error("Login cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function formatRuntimeAuthEvent(event: PiRuntimeAuthEvent): string {
  if (event.type === "auth_url") {
    return [
      "🔗 Open this URL in your browser:",
      "",
      event.url,
      event.instructions ? `\n${event.instructions}` : "",
      "",
      "Then reply with the redirect URL or authorization code if prompted.",
    ].filter(Boolean).join("\n");
  }
  if (event.type === "device_code") {
    const lines = [
      "🔗 Open this URL in your browser:",
      event.verificationUri,
      "",
      `Code: ${event.userCode}`,
    ];
    if (event.expiresInSeconds) lines.push(`Expires in ${event.expiresInSeconds}s`);
    return lines.join("\n");
  }
  if (event.type === "info") {
    const lines = [event.message];
    for (const link of event.links ?? []) {
      lines.push(link.label ? `${link.label}: ${link.url}` : link.url);
    }
    return lines.join("\n");
  }
  return event.message;
}

function createRuntimeAuthInteraction(ui: TelegramAuthUi): PiRuntimeAuthInteraction {
  return {
    async prompt(prompt: PiRuntimeAuthPrompt): Promise<string> {
      let value: string | undefined;
      if (prompt.type === "select") {
        const options = [...(prompt.options ?? [])];
        const labels = options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
        const choice = await promptWithSignal(ui.select(prompt.message, labels), prompt.signal);
        if (choice) value = options[labels.indexOf(choice)]?.id;
      } else if (prompt.type === "secret" || prompt.type === "manual_code") {
        const request = ui.inputSecret?.(prompt.message, prompt.placeholder)
          ?? ui.input(prompt.message, prompt.placeholder);
        value = await promptWithSignal(request, prompt.signal);
      } else {
        value = await promptWithSignal(ui.input(prompt.message, prompt.placeholder), prompt.signal);
      }
      if (!value) throw new Error("Login cancelled");
      return value;
    },
    notify(event: PiRuntimeAuthEvent): void {
      ui.notify(formatRuntimeAuthEvent(event), "info");
    },
  };
}

async function runRuntimeProviderLogin(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
  provider: PiRuntimeLoginProviderOption,
): Promise<void> {
  if (provider.authType === "api_key" && typeof provider.method?.login !== "function") {
    ui.notify(
      `${provider.name} is configured outside pi. Set the required environment variables or credential files, then use /model to select a model.`,
      "info",
    );
    return;
  }

  try {
    await runtimeLogin(session, provider.id, provider.authType, createRuntimeAuthInteraction(ui));
    await refreshAfterAuth(ctx, session, ui);
    ui.notify(`✅ Login complete: ${provider.name}`, "info");
  } catch (error) {
    const message = commandErrorMessage(error);
    if (message === "Login cancelled") ui.notify("Login cancelled.", "info");
    else ui.notify(`Login failed: ${message}`, "error");
  }
}

async function selectRuntimeProviderByAuthType(
  ui: TelegramAuthUi,
  session: CapturedAgentSession,
  authType: AuthType,
): Promise<PiRuntimeLoginProviderOption | undefined> {
  const providers = getRuntimeLoginProviderOptions(session, authType);
  const typeLabel = formatAuthType(authType);
  if (providers.length === 0) {
    ui.notify(`No ${typeLabel} providers available.`, "warning");
    return undefined;
  }
  const labels = makeUniqueLabels(
    providers,
    formatRuntimeLabel,
    (provider) => `(${provider.id}/${provider.authType})`,
  );
  const choice = await ui.select(`Select provider (${typeLabel}):`, labels);
  if (!choice) return undefined;
  return providers[labels.indexOf(choice)];
}

async function runRuntimeLogin(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
  args: string,
): Promise<void> {
  const directRef = args.trim();
  if (directRef) {
    const matches = findRuntimeProviderOptions(session, directRef);
    if (matches.length === 0) {
      providerNotFound(ui, directRef);
      return;
    }
    const provider = matches.length === 1
      ? matches[0]
      : await (async () => {
          const labels = makeUniqueLabels(
            matches,
            (option) => `${option.name} (${formatAuthType(option.authType)})`,
            (option) => `(${option.id}/${option.authType})`,
          );
          const choice = await ui.select(`Select authentication method for ${matches[0].name}:`, labels);
          return choice ? matches[labels.indexOf(choice)] : undefined;
        })();
    if (provider) await runRuntimeProviderLogin(ui, ctx, session, provider);
    return;
  }

  const SUBSCRIPTION_LABEL = "Use a subscription";
  const API_KEY_LABEL = "Use an API key";
  const authTypeChoice = await ui.select("Select authentication method:", [
    SUBSCRIPTION_LABEL,
    API_KEY_LABEL,
  ]);
  if (!authTypeChoice) return;

  const authType: AuthType = authTypeChoice === SUBSCRIPTION_LABEL ? "oauth" : "api_key";
  const provider = await selectRuntimeProviderByAuthType(ui, session, authType);
  if (provider) await runRuntimeProviderLogin(ui, ctx, session, provider);
}

async function runRuntimeLogout(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
): Promise<void> {
  const stored = await listRuntimeCredentials(session);
  if (stored.length === 0) {
    ui.notify("No stored credentials to remove.", "info");
    return;
  }

  const labels = makeUniqueLabels(
    stored,
    (credential) => {
      const name = getRuntimeLoginProviderOptions(session).find((p) => p.id === credential.providerId)?.name
        ?? credential.providerId;
      return `${name} (${formatAuthType(credential.type)})`;
    },
    (credential) => `(${credential.providerId}/${credential.type})`,
  );
  const choice = await ui.select("Remove credentials for:", labels);
  if (!choice) return;
  const credential = stored[labels.indexOf(choice)];
  if (!credential) return;

  const name = getRuntimeLoginProviderOptions(session).find((p) => p.id === credential.providerId)?.name
    ?? credential.providerId;
  const confirmed = await ui.confirm("Logout", `Remove stored credentials for ${name}?`);
  if (!confirmed) return;

  await runtimeLogout(session, credential.providerId);
  await refreshAfterAuth(ctx, session, ui);
  ui.notify(`Logged out from ${name}.`, "info");
}

// ── Legacy ModelRegistry/AuthStorage path (pi <= 0.80.7) ────────────────

function requireLegacyRegistry(ctx: unknown, session: CapturedAgentSession): PiModelRegistryCompat | undefined {
  return getModelRegistry(ctx, session);
}

function requireLegacyAuthStorage(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
): PiLegacyAuthStorage | undefined {
  const authStorage = getLegacyAuthStorage(ctx, session);
  if (!authStorage) {
    ui.notify("This pi version does not expose a compatible authentication API. Use the local TUI /login or update pi-telegram-plus.", "error");
    return undefined;
  }
  return authStorage;
}

/**
 * Get the auth status label for a provider (shown on button labels).
 * Aligns with p-tui OAuthSelectorComponent.formatStatusIndicator().
 */
function getLegacyProviderStatusLabel(
  registry: PiModelRegistryCompat,
  authStorage: PiLegacyAuthStorage,
  providerId: string,
  authType: AuthType,
): string {
  const cred = authStorage.get?.(providerId);

  if (authType === "oauth") {
    if (cred?.type === "oauth") return "✓ configured";
    return "";
  }

  if (cred?.type === "api_key") return "✓ configured";
  const status = registry.getProviderAuthStatus?.(providerId);
  if (status?.configured) {
    switch (status.source) {
      case "environment":
        return "✓ env";
      case "runtime":
        return "✓ runtime";
      case "fallback":
      case "models_json_key":
      case "models_json_command":
        return "✓ configured";
    }
  }
  return "";
}

function formatLegacyLabel(
  option: ProviderOption,
  registry: PiModelRegistryCompat,
  authStorage: PiLegacyAuthStorage,
): string {
  return labelWithStatus(option.name, getLegacyProviderStatusLabel(registry, authStorage, option.id, option.authType));
}

function collectLegacyOAuthProviders(authStorage: PiLegacyAuthStorage): ProviderOption[] {
  return (authStorage.getOAuthProviders?.() ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    authType: "oauth" as AuthType,
  }));
}

function collectLegacyApiKeyProviders(
  registry: PiModelRegistryCompat,
  authStorage: PiLegacyAuthStorage,
): ProviderOption[] {
  const oauthIds = new Set((authStorage.getOAuthProviders?.() ?? []).map((p) => p.id));
  const rawAllModels = registry.getAll?.();
  const allModels = Array.isArray(rawAllModels) ? rawAllModels as Array<{ provider?: unknown }> : [];
  const modelProviderIds = [
    ...new Set(allModels.map((m) => m.provider).filter((id): id is string => typeof id === "string")),
  ];

  return modelProviderIds
    .filter((id) => !oauthIds.has(id))
    .map((id) => ({
      id,
      name: registry.getProviderDisplayName?.(id) ?? id,
      authType: "api_key" as AuthType,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function runLegacyOAuthLogin(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
  provider: ProviderOption,
): Promise<boolean> {
  const authStorage = requireLegacyAuthStorage(ui, ctx, session);
  const registry = requireLegacyRegistry(ctx, session);
  if (!authStorage || !registry) return false;

  const oauthProviders = authStorage.getOAuthProviders?.() ?? [];
  const oauthProvider = oauthProviders.find((p) => p.id === provider.id);
  if (!oauthProvider) {
    ui.notify(`OAuth provider not found: ${provider.id}`, "error");
    return false;
  }
  if (typeof authStorage.login !== "function") {
    ui.notify("OAuth login is not available in this pi version.", "error");
    return false;
  }

  try {
    await authStorage.login(provider.id, {
      onAuth: (info: { url: string; instructions?: string }) => {
        const lines = [
          `🔗 Open this URL in your browser to authenticate ${provider.name}:`,
          "",
          info.url,
        ];
        if (info.instructions) lines.push("", info.instructions);
        lines.push("", "Then reply with the redirect URL or authorization code.");
        ui.notify(lines.join("\n"), "info");
      },
      onDeviceCode: (info: {
        verificationUri: string;
        userCode: string;
        expiresInSeconds?: number;
      }) => {
        const lines = [
          "🔗 Open this URL in your browser:",
          info.verificationUri,
          "",
          `Code: ${info.userCode}`,
        ];
        if (info.expiresInSeconds) lines.push(`Expires in ${info.expiresInSeconds}s`);
        lines.push("", "Then reply with the redirect URL after authorization.");
        ui.notify(lines.join("\n"), "info");
      },
      onPrompt: async (prompt: {
        message: string;
        placeholder?: string;
        allowEmpty?: boolean;
      }) => {
        const value = await ui.input(prompt.message, prompt.placeholder);
        if (!value && !prompt.allowEmpty) throw new Error("Login cancelled");
        return value ?? "";
      },
      onManualCodeInput: async () => {
        const value = await (ui.inputSecret?.(
          "Paste the redirect URL or authorization code after completing authentication in your browser",
        ) ?? ui.input(
          "Paste the redirect URL or authorization code after completing authentication in your browser",
        ));
        if (!value) throw new Error("Login cancelled");
        return value;
      },
      onSelect: async (prompt: {
        message: string;
        options: Array<{ label: string; id: string }>;
      }) => {
        const labels = prompt.options.map((o) => o.label);
        const choice = await ui.select(prompt.message, labels);
        if (!choice) return undefined;
        return prompt.options[labels.indexOf(choice)]?.id;
      },
      onProgress: (message: string) => ui.notify(message, "info"),
    });
    await refreshModelRegistry(registry);
    ui.notify(`✅ OAuth login complete: ${provider.name}`, "info");
    return true;
  } catch (error) {
    const msg = commandErrorMessage(error);
    if (msg !== "Login cancelled") ui.notify(`OAuth login failed: ${msg}`, "error");
    return false;
  }
}

async function runLegacyApiKeyLogin(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
  provider: ProviderOption,
): Promise<boolean> {
  const authStorage = requireLegacyAuthStorage(ui, ctx, session);
  const registry = requireLegacyRegistry(ctx, session);
  if (!authStorage || !registry) return false;
  if (typeof authStorage.set !== "function") {
    ui.notify("API key login is not available in this pi version.", "error");
    return false;
  }

  const apiKey = await (ui.inputSecret?.(`API key for ${provider.name}`, "sk-...")
    ?? ui.input(`API key for ${provider.name}`, "sk-..."));
  if (!apiKey) {
    ui.notify("Login cancelled.", "info");
    return false;
  }

  authStorage.set(provider.id, { type: "api_key", key: apiKey.trim() });
  await refreshModelRegistry(registry);
  ui.notify(
    `✅ API key set for ${provider.name}. The message with your API key has been deleted for safety.`,
    "info",
  );
  return true;
}

async function runLegacyLogin(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
  args: string,
): Promise<void> {
  const registry = requireLegacyRegistry(ctx, session);
  const authStorage = requireLegacyAuthStorage(ui, ctx, session);
  if (!registry || !authStorage) return;

  const directId = args.trim();
  if (directId) {
    const oauthProvider = (authStorage.getOAuthProviders?.() ?? []).find((p) => p.id === directId);
    if (oauthProvider) {
      await runLegacyOAuthLogin(ui, ctx, session, {
        id: directId,
        name: oauthProvider.name,
        authType: "oauth",
      });
    } else {
      await runLegacyApiKeyLogin(ui, ctx, session, {
        id: directId,
        name: registry.getProviderDisplayName?.(directId) ?? directId,
        authType: "api_key",
      });
    }
    return;
  }

  const SUBSCRIPTION_LABEL = "Use a subscription";
  const API_KEY_LABEL = "Use an API key";
  const authTypeChoice = await ui.select("Select authentication method:", [
    SUBSCRIPTION_LABEL,
    API_KEY_LABEL,
  ]);
  if (!authTypeChoice) return;

  const authType: AuthType = authTypeChoice === SUBSCRIPTION_LABEL ? "oauth" : "api_key";
  const providers: ProviderOption[] = authType === "oauth"
    ? collectLegacyOAuthProviders(authStorage).sort((a, b) => a.name.localeCompare(b.name))
    : collectLegacyApiKeyProviders(registry, authStorage);

  const typeLabel = formatAuthType(authType);
  if (providers.length === 0) {
    ui.notify(`No ${typeLabel} providers available.`, "warning");
    return;
  }

  const labels = makeUniqueLabels(
    providers,
    (provider) => formatLegacyLabel(provider, registry, authStorage),
    (provider) => `(${provider.id}/${provider.authType})`,
  );
  const choice = await ui.select(`Select provider (${typeLabel}):`, labels);
  if (!choice) return;

  const provider = providers[labels.indexOf(choice)];
  if (!provider) return;

  if (provider.authType === "oauth") {
    await runLegacyOAuthLogin(ui, ctx, session, provider);
  } else {
    await runLegacyApiKeyLogin(ui, ctx, session, provider);
  }
}

async function runLegacyLogout(
  ui: TelegramAuthUi,
  ctx: unknown,
  session: CapturedAgentSession,
): Promise<void> {
  const registry = requireLegacyRegistry(ctx, session);
  const authStorage = requireLegacyAuthStorage(ui, ctx, session);
  if (!registry || !authStorage) return;
  const stored = authStorage.list?.() ?? [];
  if (stored.length === 0) {
    ui.notify("No stored credentials to remove.", "info");
    return;
  }

  const oauthIds = new Set((authStorage.getOAuthProviders?.() ?? []).map((p) => p.id));
  const labels = makeUniqueLabels(
    stored,
    (id) => {
      const name = registry.getProviderDisplayName?.(id) ?? id;
      const typeLabel = oauthIds.has(id) ? "subscription" : "API key";
      return `${name} (${typeLabel})`;
    },
    (id) => `(${id})`,
  );

  const choice = await ui.select("Remove credentials for:", labels);
  if (!choice) return;
  const providerId = stored[labels.indexOf(choice)];
  if (!providerId) return;

  const providerName = registry.getProviderDisplayName?.(providerId) ?? providerId;
  const confirmed = await ui.confirm(
    "Logout",
    `Remove stored credentials for ${providerName}?`,
  );
  if (!confirmed) return;

  authStorage.logout?.(providerId);
  await refreshModelRegistry(registry);
  ui.notify(`Logged out from ${providerName}.`, "info");
}

// ── Register commands ───────────────────────────────────────────────────

export function registerAuthCommands(
  registry: CommandRegistry,
  deps: { getSession: () => CapturedAgentSession | undefined },
): void {
  registry.registerCommand("login", {
    description: "Set API key or run OAuth login for a provider",
    handler: async (args, ctx) => {
      const ui = ctx.ui as TelegramAuthUi;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (hasModelRuntimeAuth(session)) {
        await runRuntimeLogin(ui, ctx, session, args);
      } else {
        await runLegacyLogin(ui, ctx, session, args);
      }
    },
  });

  registry.registerCommand("logout", {
    description: "Remove stored credentials for a provider",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as TelegramAuthUi;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      if (hasModelRuntimeAuth(session)) {
        await runRuntimeLogout(ui, ctx, session);
      } else {
        await runLegacyLogout(ui, ctx, session);
      }
    },
  });
}
