import { describe, expect, it, vi } from "vitest";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import { SecretStore } from "../tui/secrets.ts";
import type { TelegramButton, TelegramTransport } from "../types.ts";

const CHAT = 42;

function setup(secrets = new SecretStore()) {
  let nextId = 100;
  const sentTexts: string[] = [];
  const renders: TelegramButton[][][] = [];
  const transport = {
    sendText: vi.fn(async (_chatId: number, text: string) => { sentTexts.push(text); return [{ message_id: nextId++ }]; }),
    sendButtons: vi.fn(async (_chatId: number, _text: string, rows: TelegramButton[][]) => { renders.push(rows); return { message_id: nextId++ }; }),
    editText: vi.fn(async (_chatId: number, _messageId: number, text: string) => { sentTexts.push(text); }),
    editButtons: vi.fn(async () => undefined),
    removeInlineKeyboard: vi.fn(async () => undefined),
  };
  const runtime = createTelegramUiRuntime({
    getSession: () => undefined,
    transport: transport as unknown as TelegramTransport,
    secrets,
  });
  const ui = runtime.create(CHAT);
  return { transport, runtime, ui, renders, sentTexts, secrets };
}

/** Reply to the open secret prompt with typed text, as the controller would. */
async function answer(env: ReturnType<typeof setup>, promptMessageId: number, value: string) {
  await vi.waitFor(() => expect(env.runtime.hasPendingInput(CHAT)).toBe(true));
  expect(env.runtime.isSensitiveInput(CHAT, promptMessageId)).toBe(true);
  const handled = env.runtime.resolveInput(CHAT, value, promptMessageId);
  expect(handled.handled).toBe(true);
}

describe("plugin secret prompts feed the SecretStore", () => {
  it("inputSecret registers the value so a later notify() sends only ***", async () => {
    const env = setup();
    const prompt = env.ui.inputSecret!("Bot token");
    await answer(env, 100, "sk-test-123456");
    expect(await prompt).toBe("sk-test-123456");

    env.ui.notify("key is sk-test-123456");
    await vi.waitFor(() => expect(env.sentTexts).toHaveLength(1));
    expect(env.sentTexts[0]).toContain("key is ***");
    expect(env.sentTexts[0]).not.toContain("sk-test-123456");
  });

  it("values under 8 characters are not registered", async () => {
    const env = setup();
    const prompt = env.ui.inputSecret!("Short code");
    await answer(env, 100, "abc1234");
    expect(await prompt).toBe("abc1234");

    env.ui.notify("code abc1234 ok");
    await vi.waitFor(() => expect(env.sentTexts).toHaveLength(1));
    expect(env.sentTexts[0]).toContain("abc1234");
  });

  it("a secret with HTML metacharacters is redacted and the remaining text stays escaped", async () => {
    const env = setup();
    const secret = "s&c<x>de123";
    const prompt = env.ui.inputSecret!("Bot token");
    await answer(env, 100, secret);
    expect(await prompt).toBe(secret);

    env.ui.notify(`value <b>${secret}</b> & done`);
    await vi.waitFor(() => expect(env.sentTexts).toHaveLength(1));
    // Redaction runs before escaping: the secret is gone in raw and escaped
    // form, surrounding markup is still HTML-escaped.
    expect(env.sentTexts[0]).toBe("value &lt;b&gt;***&lt;/b&gt; &amp; done");
  });

  it("clearAll() stops redaction for previously registered secrets", async () => {
    const env = setup();
    const prompt = env.ui.inputSecret!("Bot token");
    await answer(env, 100, "sk-test-123456");
    await prompt;

    env.secrets.clearAll();
    env.ui.notify("key is sk-test-123456");
    await vi.waitFor(() => expect(env.sentTexts).toHaveLength(1));
    expect(env.sentTexts[0]).toContain("sk-test-123456");
    expect(env.sentTexts[0]).not.toContain("***");
  });
});
