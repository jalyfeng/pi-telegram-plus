import { describe, expect, it, vi } from "vitest";
import { decodeUiCallback } from "../callback-protocol.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import type { TelegramButton, TelegramTransport } from "../types.ts";

const CHAT = 42;

function setup(onMenuMessage?: (messageId: number) => void) {
  let nextId = 100;
  const renders: TelegramButton[][][] = [];
  const transport = {
    sendText: vi.fn(async (_chatId: number, _text: string) => [{ message_id: nextId++ }]),
    sendButtons: vi.fn(async (_chatId: number, _text: string, rows: TelegramButton[][]) => { renders.push(rows); return { message_id: nextId++ }; }),
    editText: vi.fn(async () => undefined),
    editButtons: vi.fn(async (_chatId: number, _messageId: number, _text: string, rows: TelegramButton[][]) => { renders.push(rows); }),
    removeInlineKeyboard: vi.fn(async () => undefined),
  };
  const runtime = createTelegramUiRuntime({ getSession: () => undefined, transport: transport as unknown as TelegramTransport });
  const ui = runtime.create(CHAT, undefined, undefined, onMenuMessage);
  return { transport, runtime, ui, renders };
}

/** Press the button with this label on the given message, as the controller would. */
async function press({ runtime, renders }: ReturnType<typeof setup>, messageId: number, label: string) {
  await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
  const button = renders.at(-1)!.flat().find((b) => b.text === label);
  if (!button) throw new Error(`no button ${label}`);
  const handled = runtime.resolveInput(CHAT, decodeUiCallback(button.value), messageId, true);
  expect(handled.handled).toBe(true);
}

describe("telegram ui confirm()", () => {
  it("offers only Yes and No, reports its message id, and /stop answers it false", async () => {
    const env = setup();
    const reported: number[] = [];
    const ui = env.runtime.create(CHAT, undefined, undefined, undefined, (messageId) => reported.push(messageId));

    const answer = ui.confirm("Run shell command?", "rm -rf x");
    await vi.waitFor(() => expect(env.runtime.hasPendingInput(CHAT)).toBe(true));
    expect(reported).toEqual([100]);
    expect(env.renders.at(-1)!.flat().map((b) => b.text)).toEqual(["Yes", "No"]);

    env.runtime.resolveInput(CHAT, undefined);
    expect(await answer).toBe(false);
  });

  it("the Yes button answers true on the reported message", async () => {
    const env = setup();
    const ui = env.runtime.create(CHAT, undefined, undefined, undefined, () => undefined);

    const answer = ui.confirm("Run shell command?", "ls");
    await press(env, 100, "Yes");
    expect(await answer).toBe(true);
  });
});

describe("telegram ui menu() edit-in-place", () => {
  it("first menu sends, nested menus edit the same message, closeMenu removes the keyboard", async () => {
    const env = setup();
    const { transport, ui } = env;

    const first = ui.menu("Main", ["Bots", "Close"]);
    await press(env, 100, "Bots");
    expect(await first).toBe("Bots");
    expect(transport.removeInlineKeyboard).not.toHaveBeenCalled();

    const second = ui.menu("Bots", ["Add", "Back"]);
    await press(env, 100, "Back");
    expect(await second).toBe("Back");

    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.editButtons).toHaveBeenCalledTimes(1);
    expect(transport.editButtons.mock.calls[0][1]).toBe(100);
    expect(transport.editButtons.mock.calls[0][2]).toContain("Bots");

    await ui.closeMenu();
    expect(transport.removeInlineKeyboard).toHaveBeenCalledWith(CHAT, 100);
  });

  it("another prompt stays on the menu message and the next menu edits it", async () => {
    const env = setup();
    const { transport, ui } = env;

    const first = ui.menu("Main", ["Remove"]);
    await press(env, 100, "Remove");
    await first;

    const confirmed = ui.confirm("Sure?", "really");
    await press(env, 100, "Yes");
    expect(await confirmed).toBe(true);
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);

    const again = ui.menu("Main", ["Remove"]);
    await press(env, 100, "Remove");
    expect(await again).toBe("Remove");
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.removeInlineKeyboard).not.toHaveBeenCalledWith(CHAT, 100);
  });

  it("notify does not release the menu", async () => {
    const env = setup();
    const { transport, ui } = env;
    const first = ui.menu("Main", ["Toggle"]);
    await press(env, 100, "Toggle");
    await first;
    ui.notify("toggled");
    const second = ui.menu("Main", ["Toggle"]);
    await vi.waitFor(() => expect(transport.editButtons).toHaveBeenCalledTimes(2));
    expect(transport.editButtons.mock.calls.every((c) => c[1] === 100)).toBe(true);
    expect(transport.editButtons.mock.calls[0][2]).toContain("toggled");
    await press(env, 100, "Toggle");
    await second;
  });

  it("paginates by editing the menu message", async () => {
    const env = setup();
    const { transport, ui } = env;
    const options = Array.from({ length: 12 }, (_, i) => `opt ${i}`);
    const result = ui.menu("Long", options);
    await press(env, 100, "Next ▶");
    await vi.waitFor(() => expect(transport.editButtons).toHaveBeenCalledTimes(1));
    expect(transport.editButtons.mock.calls[0][2]).toContain("(2/2)");
    await press(env, 100, "opt 11");
    expect(await result).toBe("opt 11");
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
  });

  it("a body sits under the title on the same message, and onMenuMessage reports that message", async () => {
    const reported: number[] = [];
    const env = setup((id) => reported.push(id));
    const { transport, ui } = env;
    const result = ui.menu("Pairing", ["Unpair", "Back"], "Paired user: <42>");
    await press(env, 100, "Back");
    expect(await result).toBe("Back");
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.sendButtons.mock.calls[0][1]).toBe("<b>Pairing</b>\n\nPaired user: &lt;42&gt;");
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(reported).toEqual([100]);
  });

  it("Cancel resolves undefined and removes the keyboard", async () => {
    const env = setup();
    const { transport, ui } = env;
    const result = ui.menu("Main", ["A"]);
    await press(env, 100, "Cancel");
    expect(await result).toBeUndefined();
    expect(transport.removeInlineKeyboard).toHaveBeenCalledWith(CHAT, 100);
    await ui.closeMenu();
    expect(transport.removeInlineKeyboard).toHaveBeenCalledTimes(1);
  });
});

describe("telegram ui notify() without a live menu", () => {
  it("sends the text without a raw level label, with the emoji prefix for warnings and errors", async () => {
    const env = setup();
    const { transport, ui } = env;
    ui.notify("Telegram disconnected for this folder.", "info");
    ui.notify("Bot removed: omp", "warning");
    ui.notify("Must be a number 0-10", "error");
    await vi.waitFor(() => expect(transport.sendText).toHaveBeenCalledTimes(3));
    const texts = transport.sendText.mock.calls.map((c) => c[1]);
    expect(texts).toEqual([
      "Telegram disconnected for this folder.",
      "⚠️ Bot removed: omp",
      "❌ Must be a number 0-10",
    ]);
    expect(texts.some((t) => /<b>(info|warning|error)<\/b>/.test(t))).toBe(false);
  });
});

describe("telegram ui inside a live /tg menu", () => {
  it("prompts, a result and the next menu stay on the one menu message", async () => {
    const env = setup();
    const { transport, ui, runtime } = env;

    const first = ui.menu("🤖 Bots", ["➕ Add bot", "Back"]);
    await press(env, 100, "➕ Add bot");
    expect(await first).toBe("➕ Add bot");

    const name = ui.input("Bot name");
    await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
    runtime.resolveInput(CHAT, "work-bot");
    expect(await name).toBe("work-bot");

    const token = ui.inputSecret!("Telegram bot token");
    await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
    runtime.resolveInput(CHAT, "123456:ABCDEFGH");
    expect(await token).toBe("123456:ABCDEFGH");

    ui.notify("Bot added: work-bot");
    const second = ui.menu("🤖 Bots", ["➕ Add bot", "Back"]);
    await press(env, 100, "Back");
    expect(await second).toBe("Back");

    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(transport.editButtons.mock.calls.every((c) => c[1] === 100)).toBe(true);
    expect(transport.editButtons.mock.calls.at(-1)![2]).toContain("Bot added: work-bot");
    expect(transport.editButtons.mock.calls.at(-1)![2]).not.toContain("Telegram bot token");
  });

  it("an invalid answer shown on the menu message keeps the prompt open and clears once answered", async () => {
    const env = setup();
    const { transport, ui, runtime } = env;
    const first = ui.menu("🔄 Retry", ["Set"]);
    await press(env, 100, "Set");
    await first;

    const answer = ui.input("Retry count (0-10)");
    await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
    ui.notify("Must be a number 0-10", "error");
    await vi.waitFor(() => expect(transport.editButtons.mock.calls.at(-1)![2]).toContain("❌ Must be a number 0-10"));
    runtime.resolveInput(CHAT, "abc");
    expect(await answer).toBe("abc");

    const retry = ui.input("Retry count (0-10)");
    await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
    expect(transport.editButtons.mock.calls.at(-1)![2]).not.toContain("Must be a number");
    runtime.resolveInput(CHAT, "5");
    await retry;
    expect(transport.sendText).not.toHaveBeenCalled();
  });

  it("a confirm on the menu message records the answer under its question", async () => {
    const env = setup();
    const { transport, ui, runtime } = env;
    const first = ui.menu("📁 Project", ["Disconnect"]);
    await press(env, 100, "Disconnect");
    await first;

    const answer = ui.confirm("Disconnect Telegram for this folder?", "Telegram will stop responding.");
    await press(env, 100, "Yes");
    expect(await answer).toBe(true);
    await vi.waitFor(() => expect(transport.editButtons.mock.calls.at(-1)![2]).toContain("✅ Yes"));
    const recorded = transport.editButtons.mock.calls.at(-1)!;
    expect(recorded[2]).toBe("<b>Disconnect Telegram for this folder?</b>\n\nTelegram will stop responding.\n\n✅ Yes");
    expect(recorded[3]).toEqual([]);

    // The notice a flow reports after the answer goes on the same message, under the record.
    ui.notify("Telegram disconnected for this folder.");
    await vi.waitFor(() => expect(transport.editButtons.mock.calls.at(-1)![2]).toContain("✅ Yes\nTelegram disconnected"));
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
  });

  it("a select renders its options on the menu message", async () => {
    const env = setup();
    const { transport, ui, runtime } = env;
    const first = ui.menu("⚙️ Config", ["Tool"]);
    await press(env, 100, "Tool");
    await first;

    const pick = ui.select("Tool rendering", ["  hidden", "● brief", "  full"]);
    await vi.waitFor(() => expect(runtime.hasPendingInput(CHAT)).toBe(true));
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    const button = env.renders.at(-1)!.flat().find((b) => b.text === "  full")!;
    runtime.resolveInput(CHAT, decodeUiCallback(button.value), 100, true);
    expect(await pick).toBe("  full");
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
  });
});
