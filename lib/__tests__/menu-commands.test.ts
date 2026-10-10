import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import { buildTelegramMenuCommands } from "../menu-commands.ts";

describe("Telegram command menu", () => {
    it("exposes /tg as the consolidated management menu command", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [],
        } as any);

        expect(commands).toContainEqual({
            command: "tg",
            description: "Open the Telegram management menu",
        });
    });

    it("excludes flat /tg-* commands from the bot menu", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [
                { name: "tg-bot-add", description: "Add" },
                { name: "tg-bot-list", description: "List" },
                { name: "tg-bot-update", description: "Update" },
                { name: "tg-bot-remove", description: "Remove" },
                { name: "tg-bot-default", description: "Default" },
                { name: "tg-config", description: "Config" },
                { name: "tg-switch", description: "Switch" },
                { name: "tg-list", description: "List binding" },
                { name: "tg-bind-cwd", description: "Bind" },
                { name: "tg-unbind-cwd", description: "Unbind" },
                { name: "tg-cwd-connect", description: "Connect" },
                { name: "tg-cwd-disconnect", description: "Disconnect" },
            ],
        } as any);

        const names = commands.map((c) => c.command);
        expect(names).not.toContain("tg_bot_add");
        expect(names).not.toContain("tg_bot_list");
        expect(names).not.toContain("tg_bot_update");
        expect(names).not.toContain("tg_bot_remove");
        expect(names).not.toContain("tg_bot_default");
        expect(names).not.toContain("tg_config");
        expect(names).not.toContain("tg_switch");
        expect(names).not.toContain("tg_list");
        expect(names).not.toContain("tg_bind_cwd");
        expect(names).not.toContain("tg_unbind_cwd");
        expect(names).not.toContain("tg_cwd_connect");
        expect(names).not.toContain("tg_cwd_disconnect");
        // But /tg IS included
        expect(names).toContain("tg");
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
