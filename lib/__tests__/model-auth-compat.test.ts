import { describe, expect, it, vi } from "vitest";
import { registerAuthCommands } from "../commands/auth.ts";
import { registerModelCommands } from "../commands/model.ts";
import { commandErrorMessage } from "../pi-compat.ts";

type CommandMap = Map<string, (args: string, ctx: any) => Promise<void>>;

function createCommandMap(register: (registry: { registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => void }) => void): CommandMap {
  const commands: CommandMap = new Map();
  register({
    registerCommand: (name, options) => commands.set(name, options.handler),
  });
  return commands;
}

describe("model command compatibility", () => {
  it("uses ctx.modelRegistry for /model when session.modelRegistry is absent", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const session = {
      model: undefined,
      setModel: vi.fn(async () => undefined),
    };
    const ctx = {
      modelRegistry: {
        getAvailable: vi.fn(() => [model]),
        getAll: vi.fn(() => [model]),
      },
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerModelCommands(registry as any, { getSession: () => session as any }));

    await commands.get("model")!("", ctx);

    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalled();
    expect(session.setModel).toHaveBeenCalledWith(model);
    expect((session as any).modelRegistry).toBeUndefined();
  });

  it("uses ctx.modelRegistry for /model <query> fallback search", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const session = {
      model: undefined,
      setModel: vi.fn(async () => undefined),
    };
    const ctx = {
      modelRegistry: {
        getAvailable: vi.fn(() => []),
        getAll: vi.fn(() => [model]),
      },
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerModelCommands(registry as any, { getSession: () => session as any }));

    await commands.get("model")!("sonnet", ctx);

    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalled();
    expect(ctx.modelRegistry.getAll).toHaveBeenCalled();
    expect(session.setModel).toHaveBeenCalledWith(model);
  });

  it("uses ctx.modelRegistry for /scoped-models when session.modelRegistry is absent", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const session = {
      model: undefined,
      scopedModels: [],
      setModel: vi.fn(async () => undefined),
      setScopedModels: vi.fn(),
      setThinkingLevel: vi.fn(),
      getAvailableThinkingLevels: vi.fn(() => []),
    };
    const ctx = {
      modelRegistry: {
        getAvailable: vi.fn(() => [model]),
        getAll: vi.fn(() => [model]),
      },
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerModelCommands(registry as any, { getSession: () => session as any }));

    await commands.get("scoped-models")!("", ctx);

    expect(ctx.modelRegistry.getAvailable).toHaveBeenCalled();
    expect(session.setModel).toHaveBeenCalledWith(model);
    expect(session.setScopedModels).toHaveBeenCalledWith([{ model }]);
  });

  it("falls back to modelRuntime.getAvailableSnapshot when no ModelRegistry exists", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const session = {
      model: undefined,
      modelRuntime: {
        getAvailableSnapshot: vi.fn(() => [model]),
      },
      setModel: vi.fn(async () => undefined),
    };
    const ctx = {
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerModelCommands(registry as any, { getSession: () => session as any }));

    await commands.get("model")!("", ctx);

    expect(session.modelRuntime.getAvailableSnapshot).toHaveBeenCalled();
    expect(session.setModel).toHaveBeenCalledWith(model);
  });

  it("falls back to modelRuntime.getModels for /model <query> when no ModelRegistry exists", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const session = {
      model: undefined,
      modelRuntime: {
        getAvailableSnapshot: vi.fn(() => []),
        getModels: vi.fn(() => [model]),
      },
      setModel: vi.fn(async () => undefined),
    };
    const ctx = {
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerModelCommands(registry as any, { getSession: () => session as any }));

    await commands.get("model")!("sonnet", ctx);

    expect(session.modelRuntime.getAvailableSnapshot).toHaveBeenCalled();
    expect(session.modelRuntime.getModels).toHaveBeenCalled();
    expect(session.setModel).toHaveBeenCalledWith(model);
  });
});

describe("pi compat redaction", () => {
  it("redacts common Telegram-visible secret formats while preserving useful labels", () => {
    const message = commandErrorMessage(new Error([
      "API key: AIzaSyDUMMYSECRET1234567890",
      "x-api-key=abcdef1234567890",
      "Authorization: Bearer bearer-secret-1234567890",
      "callback https://example.test/cb?code=abc123456789&access_token=tok123456789&state=ok",
      "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
      "key: short",
      "key: abcdef1234567890",
    ].join("\n")));

    expect(message).toContain("API key: …");
    expect(message).toContain("x-api-key=…");
    expect(message).toContain("Authorization: Bearer …");
    expect(message).toContain("code=…");
    expect(message).toContain("access_token=…");
    expect(message).toContain("state=ok");
    expect(message).toContain("github_pat_…");
    expect(message).toContain("key: short");
    expect(message).toContain("key: …");
    expect(message).not.toContain("AIzaSyDUMMYSECRET1234567890");
    expect(message).not.toContain("bearer-secret-1234567890");
    expect(message).not.toContain("abc123456789");
    expect(message).not.toContain("tok123456789");
  });

  it("redacts JSON and quoted header dump secret formats", () => {
    const message = commandErrorMessage(new Error([
      '{"api_key":"jsonkey1234567890"}',
      '{"access_token":"jsontok1234567890"}',
      '{"authorization":"Bearer bearer-json-secret-1234567890"}',
      "Authorization: Basic dXNlcjpwYXNzMTIzNDU2",
      '{"authorization":"Token tokenvalue1234567890"}',
      'headers: { "x-api-key": "headerkey1234567890" }',
      'headers: { "Proxy-Authorization": "Basic proxysecret1234567890" }',
      "callback https://example.test/cb?code=urlcode123456&access_token=urltoken123456&state=ok",
      '{"url":"https://example.test/cb?state=ok&code=lastcode123456"}',
    ].join("\n")));

    expect(message).toContain('"api_key":"…"');
    expect(message).toContain('"access_token":"…"');
    expect(message).toContain('"authorization":"Bearer …"');
    expect(message).toContain("Authorization: Basic …");
    expect(message).toContain('"authorization":"Token …"');
    expect(message).toContain('"x-api-key": "…"');
    expect(message).toContain('"Proxy-Authorization": "Basic …"');
    expect(message).toContain("code=…");
    expect(message).toContain("access_token=…");
    expect(message).toContain("state=ok");
    expect(message).toContain('{"url":"https://example.test/cb?state=ok&code=…"}');
    expect(message).not.toContain("jsonkey1234567890");
    expect(message).not.toContain("jsontok1234567890");
    expect(message).not.toContain("bearer-json-secret-1234567890");
    expect(message).not.toContain("dXNlcjpwYXNzMTIzNDU2");
    expect(message).not.toContain("tokenvalue1234567890");
    expect(message).not.toContain("headerkey1234567890");
    expect(message).not.toContain("proxysecret1234567890");
    expect(message).not.toContain("urlcode123456");
    expect(message).not.toContain("urltoken123456");
    expect(message).not.toContain("lastcode123456");
  });
});

describe("auth command compatibility", () => {
  it("uses ModelRuntime for API key /login", async () => {
    const login = vi.fn(async (_providerId: string, _authType: string, interaction: any) => {
      const key = await interaction.prompt({ type: "secret", message: "API key", placeholder: "sk-..." });
      expect(key).toBe("sk-test");
      interaction.notify({ type: "progress", message: "Saving credential" });
    });
    const session = {
      modelRuntime: {
        getProviders: () => [{ id: "anthropic", name: "Anthropic", auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } } }],
        getProviderAuthStatus: () => ({ configured: false }),
        login,
        logout: vi.fn(),
        getAvailable: vi.fn(async () => []),
      },
    };
    const ctx = {
      modelRegistry: { refresh: vi.fn(async () => undefined) },
      ui: {
        select: vi.fn(async (title: string, options: string[]) =>
          title.includes("authentication method") ? "Use an API key" : options[0],
        ),
        input: vi.fn(),
        inputSecret: vi.fn(async () => "sk-test"),
        confirm: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerAuthCommands(registry as any, { getSession: () => session as any }));

    await commands.get("login")!("", ctx);

    expect(login).toHaveBeenCalledWith("anthropic", "api_key", expect.any(Object));
    expect(ctx.ui.inputSecret).toHaveBeenCalled();
    expect(ctx.modelRegistry.refresh).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Login complete"), "info");
  });

  it("maps ModelRuntime OAuth device-code, select, and manual-code prompts to Telegram UI", async () => {
    const login = vi.fn(async (_providerId: string, _authType: string, interaction: any) => {
      interaction.notify({ type: "device_code", verificationUri: "https://example.test/device", userCode: "ABC-123" });
      const account = await interaction.prompt({
        type: "select",
        message: "Select account",
        options: [{ id: "github.com", label: "github.com" }],
      });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
      expect(account).toBe("github.com");
      expect(code).toBe("redirect-code");
    });
    const session = {
      modelRuntime: {
        getProviders: () => [{ id: "github-copilot", name: "GitHub Copilot", auth: { oauth: { name: "GitHub Copilot" } } }],
        getProviderAuthStatus: () => ({ configured: false }),
        login,
        logout: vi.fn(),
        getAvailable: vi.fn(async () => []),
      },
    };
    const ctx = {
      modelRegistry: { refresh: vi.fn(async () => undefined) },
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        input: vi.fn(async () => "plain-input-code"),
        inputSecret: vi.fn(async () => "redirect-code"),
        confirm: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerAuthCommands(registry as any, { getSession: () => session as any }));

    await commands.get("login")!("github-copilot", ctx);

    expect(login).toHaveBeenCalledWith("github-copilot", "oauth", expect.any(Object));
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ABC-123"), "info");
    expect(ctx.ui.inputSecret).toHaveBeenCalledWith("Paste code", undefined);
    expect(ctx.ui.input).not.toHaveBeenCalledWith("Paste code", undefined);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Login complete"), "info");
  });

  it("uses ModelRuntime for /logout", async () => {
    const logout = vi.fn(async () => undefined);
    const session = {
      modelRuntime: {
        getProviders: () => [{ id: "anthropic", name: "Anthropic", auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } } }],
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        login: vi.fn(),
        logout,
        listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "api_key" }]),
        getAvailable: vi.fn(async () => []),
      },
    };
    const ctx = {
      modelRegistry: { refresh: vi.fn(async () => undefined) },
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        input: vi.fn(),
        inputSecret: vi.fn(),
        confirm: vi.fn(async () => true),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((registry) => registerAuthCommands(registry as any, { getSession: () => session as any }));

    await commands.get("logout")!("", ctx);

    expect(logout).toHaveBeenCalledWith("anthropic");
    expect(ctx.modelRegistry.refresh).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Logged out"), "info");
  });

  it("falls back to legacy authStorage when ModelRuntime is absent", async () => {
    const authStorage = {
      getOAuthProviders: vi.fn(() => []),
      get: vi.fn(() => undefined),
      set: vi.fn(),
      list: vi.fn(() => []),
      logout: vi.fn(),
    };
    const registry = {
      authStorage,
      getAll: vi.fn(() => [{ provider: "anthropic", id: "claude-sonnet-4" }]),
      getProviderDisplayName: vi.fn((id: string) => id === "anthropic" ? "Anthropic" : id),
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
      refresh: vi.fn(),
    };
    const session = {};
    const ctx = {
      modelRegistry: registry,
      ui: {
        select: vi.fn(),
        input: vi.fn(),
        inputSecret: vi.fn(async () => "sk-legacy"),
        confirm: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((commandRegistry) => registerAuthCommands(commandRegistry as any, { getSession: () => session as any }));

    await commands.get("login")!("anthropic", ctx);

    expect(authStorage.set).toHaveBeenCalledWith("anthropic", { type: "api_key", key: "sk-legacy" });
    expect(registry.refresh).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("API key set"), "info");
  });

  it("uses inputSecret for legacy OAuth manual-code input when available", async () => {
    const authStorage = {
      getOAuthProviders: vi.fn(() => [{ id: "github-copilot", name: "GitHub Copilot" }]),
      login: vi.fn(async (_providerId: string, callbacks: any) => {
        const value = await callbacks.onManualCodeInput();
        expect(value).toBe("legacy-redirect-code");
      }),
    };
    const registry = {
      authStorage,
      refresh: vi.fn(),
    };
    const session = {};
    const ctx = {
      modelRegistry: registry,
      ui: {
        select: vi.fn(),
        input: vi.fn(async () => "plain-input-code"),
        inputSecret: vi.fn(async () => "legacy-redirect-code"),
        confirm: vi.fn(),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((commandRegistry) => registerAuthCommands(commandRegistry as any, { getSession: () => session as any }));

    await commands.get("login")!("github-copilot", ctx);

    expect(authStorage.login).toHaveBeenCalledWith("github-copilot", expect.any(Object));
    expect(ctx.ui.inputSecret).toHaveBeenCalledWith("Paste the redirect URL or authorization code after completing authentication in your browser");
    expect(ctx.ui.input).not.toHaveBeenCalledWith("Paste the redirect URL or authorization code after completing authentication in your browser");
    expect(registry.refresh).toHaveBeenCalled();
  });

  it("falls back to legacy authStorage for /logout when ModelRuntime is absent", async () => {
    const authStorage = {
      getOAuthProviders: vi.fn(() => []),
      list: vi.fn(() => ["anthropic"]),
      logout: vi.fn(),
    };
    const registry = {
      authStorage,
      getProviderDisplayName: vi.fn((id: string) => id === "anthropic" ? "Anthropic" : id),
      refresh: vi.fn(),
    };
    const session = {};
    const ctx = {
      modelRegistry: registry,
      ui: {
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
        input: vi.fn(),
        inputSecret: vi.fn(),
        confirm: vi.fn(async () => true),
        notify: vi.fn(),
      },
    };
    const commands = createCommandMap((commandRegistry) => registerAuthCommands(commandRegistry as any, { getSession: () => session as any }));

    await commands.get("logout")!("", ctx);

    expect(authStorage.list).toHaveBeenCalled();
    expect(authStorage.logout).toHaveBeenCalledWith("anthropic");
    expect(registry.refresh).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Logged out from Anthropic"), "info");
  });
});
