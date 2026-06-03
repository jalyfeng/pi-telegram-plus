import type { CommandRegistry } from "./register.ts";
import type { CapturedAgentSession } from "../types.ts";

// ── Types ───────────────────────────────────────────────────────────────

type AuthType = "oauth" | "api_key";

type ProviderOption = {
  id: string;
  name: string;
  authType: AuthType;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Get the auth status label for a provider (shown on button labels).
 * Aligns with p-tui OAuthSelectorComponent.formatStatusIndicator().
 */
function getProviderStatusLabel(
  session: CapturedAgentSession,
  providerId: string,
  authType: AuthType,
): string {
  const authStorage = session.modelRegistry.authStorage;
  const cred = authStorage.get(providerId);

  if (authType === "oauth") {
    if (cred?.type === "oauth") return "✓ configured";
    return "";
  }

  // API key
  if (cred?.type === "api_key") return "✓ configured";
  const status = session.modelRegistry.getProviderAuthStatus(providerId);
  if (status.configured) {
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

/** Format as a select option label (name + status). */
function formatLabel(option: ProviderOption, session: CapturedAgentSession): string {
  const status = getProviderStatusLabel(session, option.id, option.authType);
  return status ? `${option.name} ${status}` : option.name;
}

/**
 * Collect OAuth providers from AuthStorage.getOAuthProviders().
 * Aligns with p-tui's OAuth section in getLoginProviderOptions().
 */
function collectOAuthProviders(session: CapturedAgentSession): ProviderOption[] {
  return session.modelRegistry.authStorage.getOAuthProviders().map((p) => ({
    id: p.id,
    name: p.name,
    authType: "oauth" as AuthType,
  }));
}

/**
 * Collect API key providers from ModelRegistry's unique provider list.
 * Excludes provider IDs already present in the OAuth list (OAuth-only providers
 * should not appear twice). Aligns with p-tui's API key section in
 * getLoginProviderOptions() + isApiKeyLoginProvider().
 */
function collectApiKeyProviders(session: CapturedAgentSession): ProviderOption[] {
  const authStorage = session.modelRegistry.authStorage;
  const oauthIds = new Set(authStorage.getOAuthProviders().map((p) => p.id));
  const modelProviderIds = [
    ...new Set(session.modelRegistry.getAll().map((m) => m.provider)),
  ];

  return modelProviderIds
    .filter((id) => !oauthIds.has(id))
    .map((id) => ({
      id,
      name: session.modelRegistry.getProviderDisplayName(id),
      authType: "api_key" as AuthType,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run the OAuth login flow (Telegram-specific mode).
 *
 * Unlike p-tui, Telegram cannot auto-open a browser. This uses a
 * "show URL → user manually pastes back" flow:
 * 1. Bot sends the auth URL as inline text (copyable)
 * 2. User completes OAuth in their browser
 * 3. User replies with the redirect URL
 * 4. onManualCodeInput captures the URL and finishes auth
 */
async function runOAuthLogin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ui: any,
  session: CapturedAgentSession,
  provider: ProviderOption,
): Promise<boolean> {
  const authStorage = session.modelRegistry.authStorage;
  const oauthProviders = authStorage.getOAuthProviders();
  const oauthProvider = oauthProviders.find((p) => p.id === provider.id);
  if (!oauthProvider) {
    ui.notify(`OAuth provider not found: ${provider.id}`, "error");
    return false;
  }

  try {
    await authStorage.login(provider.id, {
      onAuth: (info: { url: string; instructions?: string }) => {
        const lines = [
          `🔗 Open this URL in your browser to authenticate <b>${provider.name}</b>:`,
          ``,
          info.url,
        ];
        if (info.instructions) {
          lines.push(``, info.instructions);
        }
        lines.push(``, `Then reply with the redirect URL or authorization code.`);
        ui.notify(lines.join("\n"), "info");
      },
      onDeviceCode: (info: {
        verificationUri: string;
        userCode: string;
        expiresInSeconds?: number;
      }) => {
        const lines = [
          `🔗 Open this URL in your browser:`,
          info.verificationUri,
          ``,
          `Code: <b>${info.userCode}</b>`,
        ];
        if (info.expiresInSeconds) {
          lines.push(`Expires in ${info.expiresInSeconds}s`);
        }
        lines.push(``, `Then reply with the redirect URL after authorization.`);
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
        const value = await ui.input(
          "Paste the redirect URL or authorization code after completing authentication in your browser",
        );
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
    session.modelRegistry.refresh();
    ui.notify(`✅ OAuth login complete: ${provider.name}`, "info");
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg !== "Login cancelled") {
      ui.notify(`OAuth login failed: ${msg}`, "error");
    }
    return false;
  }
}

/**
 * Run the API key login flow.
 * Uses inputSecret when available; the user's message is auto-deleted
 * to protect the sensitive key.
 */
async function runApiKeyLogin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ui: any,
  session: CapturedAgentSession,
  provider: ProviderOption,
): Promise<boolean> {
  const authStorage = session.modelRegistry.authStorage;

  const apiKey = await (ui.inputSecret?.(`API key for ${provider.name}`, "sk-...") ??
    ui.input(`API key for ${provider.name}`, "sk-..."));
  if (!apiKey) {
    ui.notify("Login cancelled.", "info");
    return false;
  }

  authStorage.set(provider.id, { type: "api_key", key: apiKey.trim() });
  session.modelRegistry.refresh();
  ui.notify(
    `✅ API key set for ${provider.name}. The message with your API key has been deleted for safety.`,
    "info",
  );
  return true;
}

// ── Register commands ───────────────────────────────────────────────────

export function registerAuthCommands(
  registry: CommandRegistry,
  deps: { getSession: () => CapturedAgentSession | undefined },
): void {
  // ── /login ────────────────────────────────────────────────────────────
  registry.registerCommand("login", {
    description: "Set API key or run OAuth login for a provider",
    handler: async (args, ctx) => {
      const ui = ctx.ui as typeof ctx.ui & {
        inputSecret?: (
          title: string,
          placeholder?: string,
        ) => Promise<string | undefined>;
      };
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      // ── Quick arg: pass a provider ID to jump straight to input ────
      // e.g. /login anthropic              → API key prompt (Anthropic)
      //      /login anthropic-subscription  → OAuth flow
      const directId = args.trim();
      if (directId) {
        const oauthProviders =
          session.modelRegistry.authStorage.getOAuthProviders();
        const oauthProvider = oauthProviders.find((p) => p.id === directId);
        if (oauthProvider) {
          await runOAuthLogin(ui, session, {
            id: directId,
            name: oauthProvider.name,
            authType: "oauth",
          });
        } else {
          await runApiKeyLogin(ui, session, {
            id: directId,
            name: session.modelRegistry.getProviderDisplayName(directId),
            authType: "api_key",
          });
        }
        return;
      }

      // ═════════════════════════════════════════════════════════════════
      // Phase 1: Select auth type (aligns with p-tui showLoginAuthTypeSelector)
      // ═════════════════════════════════════════════════════════════════
      const SUBSCRIPTION_LABEL = "Use a subscription";
      const API_KEY_LABEL = "Use an API key";
      const authTypeChoice = await ui.select("Select authentication method:", [
        SUBSCRIPTION_LABEL,
        API_KEY_LABEL,
      ]);
      if (!authTypeChoice) return;

      const authType: AuthType =
        authTypeChoice === SUBSCRIPTION_LABEL ? "oauth" : "api_key";

      // ═════════════════════════════════════════════════════════════════
      // Phase 2: Select provider (filtered by authType + status + back nav)
      // Aligns with p-tui showLoginProviderSelector(authType)
      // ═════════════════════════════════════════════════════════════════
      const providers: ProviderOption[] =
        authType === "oauth"
          ? collectOAuthProviders(session).sort((a, b) =>
              a.name.localeCompare(b.name),
            )
          : collectApiKeyProviders(session);

      const typeLabel = authType === "oauth" ? "subscription" : "API key";
      if (providers.length === 0) {
        ui.notify(`No ${typeLabel} providers available.`, "warning");
        return;
      }

      const BACK_LABEL = "← Back";
      const labels = [
        BACK_LABEL,
        ...providers.map((p) => formatLabel(p, session)),
      ];
      const choice = await ui.select(`Select provider (${typeLabel}):`, labels);
      if (!choice || choice === BACK_LABEL) return;

      const idx = labels.indexOf(choice) - 1;
      const provider = providers[idx];
      if (!provider) return;

      // ═════════════════════════════════════════════════════════════════
      // Phase 3: Execute login
      // ═════════════════════════════════════════════════════════════════
      if (provider.authType === "oauth") {
        await runOAuthLogin(ui, session, provider);
      } else {
        await runApiKeyLogin(ui, session, provider);
      }
    },
  });

  // ── /logout ───────────────────────────────────────────────────────────
  // Improvement: shows each provider's auth type (subscription / API key)
  registry.registerCommand("logout", {
    description: "Remove stored credentials for a provider",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      const stored = session.modelRegistry.authStorage.list();
      if (stored.length === 0) {
        ui.notify("No stored credentials to remove.", "info");
        return;
      }

      // Show auth type context
      const oauthIds = new Set(
        session.modelRegistry.authStorage
          .getOAuthProviders()
          .map((p) => p.id),
      );
      const labels = stored.map((id) => {
        const name = session.modelRegistry.getProviderDisplayName(id);
        const typeLabel = oauthIds.has(id) ? "subscription" : "API key";
        return `${name} (${typeLabel})`;
      });

      const choice = await ui.select("Remove credentials for:", labels);
      if (!choice) return;
      const idx = labels.indexOf(choice);
      if (idx < 0) return;
      const providerId = stored[idx];

      const confirmed = await ui.confirm(
        "Logout",
        `Remove stored credentials for ${session.modelRegistry.getProviderDisplayName(providerId)}?`,
      );
      if (!confirmed) return;

      session.modelRegistry.authStorage.logout(providerId);
      session.modelRegistry.refresh();
      ui.notify(
        `Logged out from ${session.modelRegistry.getProviderDisplayName(providerId)}.`,
        "info",
      );
    },
  });
}
