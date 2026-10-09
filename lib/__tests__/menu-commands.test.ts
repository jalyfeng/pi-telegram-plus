import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import { buildTelegramMenuCommands } from "../menu-commands.ts";

describe("Telegram command menu", () => {
    it("exposes tg-switch with a Telegram-compatible command name", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [],
        } as any);

        expect(commands).toContainEqual({
            command: "tg_switch",
            description: "Switch the active local pi instance",
        });
    });

    it("routes the Telegram menu command to the tg-switch handler", async () => {
        const handler = vi.fn(async () => undefined);
        const telegramCommands = new Map([["tg-switch", handler]]);
        let currentUi: unknown;
        const session = {
            extensionRunner: {
                getUIContext: () => currentUi,
                setUIContext: (ui: unknown) => { currentUi = ui; },
                getCommand: () => undefined,
                createCommandContext: () => ({}),
            },
        } as any;
        const controller = createTelegramController({
            getSession: () => session,
            transport: {} as any,
            ui: {
                create: () => ({}) as any,
                resolveInput: () => ({ handled: false }),
                isSensitiveInput: () => false,
                hasPendingInput: () => false,
                dispose: () => undefined,
            },
            authorizeUser: async () => true,
            setActiveChatId: async () => undefined,
            getBotUsername: () => "test_bot",
            telegramCommands,
            getActiveTurn: () => undefined,
            beginTelegramTurn: () => undefined,
            endTelegramTurn: () => undefined,
        });

        await controller.handleMessage({
            message_id: 1,
            chat: { id: 42 },
            from: { id: 7 },
            text: "/tg_switch current",
        });

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith("current", expect.anything());
        });
    });
});
