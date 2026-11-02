import { describe, expect, it, vi } from "vitest";
import { decodeUiCallback } from "../callback-protocol.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import type { TelegramButton, TelegramTransport } from "../types.ts";

const CHAT = 42;

function setup(onMenuMessage?: (messageId: number) => void) {
  let nextId = 100;
  const renders: TelegramButton[][][] = [];
  const transport = {
    sendText: vi.fn(async () => [{ message_id: nextId++ }]),
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

  it("another prompt releases the menu so the next menu renders as a new message", async () => {
    const env = setup();
    const { transport, ui } = env;

    const first = ui.menu("Main", ["Remove"]);
    await press(env, 100, "Remove");
    await first;

    const confirmed = ui.confirm("Sure?", "really");
    expect(transport.removeInlineKeyboard).toHaveBeenCalledWith(CHAT, 100);
    await press(env, 101, "Yes");
    expect(await confirmed).toBe(true);

    const again = ui.menu("Main", ["Remove"]);
    await vi.waitFor(() => expect(transport.sendButtons).toHaveBeenCalledTimes(3));
    expect(transport.editButtons).not.toHaveBeenCalled();
    await press(env, 102, "Remove");
    await again;
  });

  it("notify does not release the menu", async () => {
    const env = setup();
    const { transport, ui } = env;
    const first = ui.menu("Main", ["Toggle"]);
    await press(env, 100, "Toggle");
    await first;
    ui.notify("toggled");
    const second = ui.menu("Main", ["Toggle"]);
    await vi.waitFor(() => expect(transport.editButtons).toHaveBeenCalledTimes(1));
    expect(transport.editButtons.mock.calls[0][1]).toBe(100);
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
