import { describe, expect, it } from "vitest";
import { authorizeTelegramUser, ensureTelegramPairingCode, extractTelegramPairingCode } from "../pairing.ts";

describe("Telegram pairing", () => {
  it("does not auto-authorize the first user when no allowedUserId is configured", () => {
    const config = { botToken: "token", pairingCode: "123456" };

    const decision = authorizeTelegramUser(config, 42, "hello", "mybot");

    expect(decision.authorized).toBe(false);
    expect(decision.paired).toBe(false);
    expect(decision.config).toBe(config);
    expect(decision.config).not.toHaveProperty("allowedUserId");
  });

  it("authorizes a user with the one-time pairing code and removes the code", () => {
    const decision = authorizeTelegramUser({ botToken: "token", pairingCode: "123456" }, 42, "/pair 123456", "mybot");

    expect(decision.authorized).toBe(true);
    expect(decision.paired).toBe(true);
    expect(decision.config.allowedUserId).toBe(42);
    expect(decision.config.pairingCode).toBeUndefined();
  });

  it("keeps rejecting other users after pairing", () => {
    const config = { botToken: "token", allowedUserId: 42 };

    expect(authorizeTelegramUser(config, 42, "hello", "mybot").authorized).toBe(true);
    expect(authorizeTelegramUser(config, 99, "/pair 123456", "mybot").authorized).toBe(false);
  });

  it("supports bot-addressed pair commands but ignores other bot usernames", () => {
    expect(extractTelegramPairingCode("/pair@MyBot 123456", "mybot")).toBe("123456");
    expect(extractTelegramPairingCode("/pair@OtherBot 123456", "mybot")).toBeUndefined();
  });

  it("generates a pairing code only when no user is paired", () => {
    const withCode = ensureTelegramPairingCode({ botToken: "token" });
    expect(withCode.pairingCode).toMatch(/^\d{6}$/);

    const paired = ensureTelegramPairingCode({ botToken: "token", allowedUserId: 42, pairingCode: "123456" });
    expect(paired).toEqual({ botToken: "token", allowedUserId: 42 });
  });
});
