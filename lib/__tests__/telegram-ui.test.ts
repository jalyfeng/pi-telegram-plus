import { describe, expect, it, vi } from "vitest";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import { decodeUiCallback } from "../callback-protocol.ts";
import type { TelegramTransport } from "../types.ts";

describe("TelegramUiRuntime standard core UI behaviors", () => {
  const chatId = 12345;

  const mockTransport = () => {
    let messageIdCounter = 100;
    return {
      removeInlineKeyboard: vi.fn(),
      sendText: vi.fn(async () => [{ message_id: messageIdCounter++ }]),
      sendButtons: vi.fn(async () => ({ message_id: messageIdCounter++ })),
      editText: vi.fn(),
      editButtons: vi.fn(),
      answerCallbackQuery: vi.fn(),
      deleteMessage: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
      sendChatAction: vi.fn(),
    };
  };

  it("handles notify with basic level", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    ui.notify("Test Message");
    expect(transport.sendText).toHaveBeenCalledWith(chatId, "<b>info</b>\nTest Message");
  });

  it("handles confirm YES flow", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const confirmPromise = ui.confirm("Confirm Title", "Confirm Message");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const yesBtnValue = sentButtons[0][0].value; // YES button

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(yesBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await confirmPromise;
    expect(result).toBe(true);
  });

  it("handles confirm NO flow", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const confirmPromise = ui.confirm("Confirm Title", "Confirm Message");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const noBtnValue = sentButtons[0][1].value; // NO button

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(noBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  it("handles confirm CANCEL flow", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const confirmPromise = ui.confirm("Confirm Title", "Confirm Message");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const cancelBtnValue = sentButtons[0][2].value; // CANCEL button

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(cancelBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  it("handles input prompt with text reply", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const inputPromise = ui.input("Enter something", "Placeholder text");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const promptMessageId = 100;
    const resolved = runtime.resolveInput(chatId, "My text answer", promptMessageId, false);
    expect(resolved.handled).toBe(true);

    const result = await inputPromise;
    expect(result).toBe("My text answer");
  });

  it("handles input prompt with Cancel callback", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const inputPromise = ui.input("Enter something", "Placeholder text");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const cancelBtnValue = sentButtons[0][0].value;

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(cancelBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await inputPromise;
    expect(result).toBeUndefined();
  });

  it("handles inputSecret prompt and sensitive input check", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const inputSecretPromise = ui.inputSecret?.("Enter PIN", "PIN") ?? Promise.resolve(undefined);

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    // Check isSensitiveInput before resolution
    expect(runtime.isSensitiveInput(chatId, 100)).toBe(true);
    expect(runtime.isSensitiveInput(chatId)).toBe(true);

    const resolved = runtime.resolveInput(chatId, "secret_value", 100, false);
    expect(resolved.handled).toBe(true);

    const result = await inputSecretPromise;
    expect(result).toBe("secret_value");

    // Check isSensitiveInput after resolution
    expect(runtime.isSensitiveInput(chatId, 100)).toBe(false);
    expect(runtime.isSensitiveInput(chatId)).toBe(false);
  });

  it("handles editor prompt", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const editorPromise = ui.editor("Edit something", "Initial draft");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const resolved = runtime.resolveInput(chatId, "Updated code content", 100, false);
    expect(resolved.handled).toBe(true);

    const result = await editorPromise;
    expect(result).toBe("Updated code content");
  });

  it("handles select without options resolving immediately", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const selectPromise = ui.select("Choose empty", []);
    const result = await selectPromise;
    expect(result).toBeUndefined();
    expect(transport.sendButtons).not.toHaveBeenCalled();
  });

  it("handles select within single page", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const selectPromise = ui.select("Choose food", ["Apple", "Orange", "Grape"]);

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    expect(sentButtons).toHaveLength(4); // 3 items + cancel row
    const orangeBtnValue = sentButtons[1][0].value;

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(orangeBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await selectPromise;
    expect(result).toBe("Orange");
  });

  it("handles select pagination next, prev and cancel", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);
    const options = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const selectPromise = ui.select("Choose paginated", options);

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    const page1Buttons = transport.sendButtons.mock.lastCall[2];
    const nextBtnValue = page1Buttons[10][0].value; // Next is first in nav row (row index 10)
    const cancelBtnValue = page1Buttons[10][1].value; // Cancel is second in nav row

    // Click Next
    let resolved = runtime.resolveInput(chatId, decodeUiCallback(nextBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    await vi.waitFor(() => {
      expect(transport.editButtons).toHaveBeenCalled();
    });

    // Verify editButtons call (page 2 options and Back, Cancel navigation)
    const editCall = transport.editButtons.mock.lastCall;
    expect(editCall[1]).toBe(100); // edit message id 100
    expect(editCall[2]).toContain("(2/2)");

    const page2Buttons = editCall[3];
    expect(page2Buttons).toHaveLength(3); // 2 options + nav row
    const prevBtnValue = page2Buttons[2][0].value; // Prev
    
    // Click Prev
    resolved = runtime.resolveInput(chatId, decodeUiCallback(prevBtnValue), 100, true);
    expect(resolved.handled).toBe(true);

    await vi.waitFor(() => {
      expect(transport.editButtons).toHaveBeenCalledTimes(2);
    });

    // Check we edit back to page 1
    expect(transport.editButtons.mock.lastCall[2]).toContain("(1/2)");

    // Let's cancel the select
    const page1ButtonsAgain = transport.editButtons.mock.lastCall[3];
    const cancelBtnValueAgain = page1ButtonsAgain[10][1].value;

    resolved = runtime.resolveInput(chatId, decodeUiCallback(cancelBtnValueAgain), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await selectPromise;
    expect(result).toBeUndefined();
  });

  it("handles pending state verification and dispose lifecycle", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => undefined,
      transport,
    });
    const ui = runtime.create(chatId);

    expect(runtime.hasPendingInput(chatId)).toBe(false);

    const confirmPromise = ui.confirm("Are you there?", "Wait for response");

    await vi.waitFor(() => {
      expect(runtime.hasPendingInput(chatId)).toBe(true);
    });

    expect(runtime.hasPendingInput(chatId)).toBe(true);

    runtime.dispose();

    expect(runtime.hasPendingInput(chatId)).toBe(false);

    const result = await confirmPromise;
    expect(result).toBe(false);
  });
});

describe("TelegramUiRuntime integrated extension prompt behaviors", () => {
  const chatId = 12345;

  const mockTransport = () => {
    let messageIdCounter = 100;
    return {
      removeInlineKeyboard: vi.fn(),
      sendText: vi.fn(async () => [{ message_id: messageIdCounter++ }]),
      sendButtons: vi.fn(async () => ({ message_id: messageIdCounter++ })),
      editText: vi.fn(),
      editButtons: vi.fn(),
      answerCallbackQuery: vi.fn(),
      deleteMessage: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
      sendChatAction: vi.fn(),
    };
  };

  it("handles @juicesharp/rpiv-ask-user-question multi-select questionnaire", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    runtime.setJuicesharpRpivAskUserQuestionData({
      questions: [
        {
          question: "Which features do you want?",
          header: "Header info",
          multiSelect: true,
          options: [
            { label: "Feature A", description: "Desc A" },
            { label: "Feature B", description: "Desc B" },
          ],
        },
      ],
    });

    const ui = runtime.create(chatId);

    // Start custom() flow asynchronously
    const customPromise = ui.custom<any>(() => ({} as any));

    // Wait for buttons to be sent
    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalled();
    });

    // Check parameters of sendButtons
    const lastCall = transport.sendButtons.mock.lastCall;
    const sentText = lastCall[1];
    const sentButtons = lastCall[2];

    expect(sentText).toContain("Which features do you want?");
    // Find the callback values
    const btnAValue = sentButtons[0][0].value; // t:0
    const btnBValue = sentButtons[1][0].value; // t:1
    const doneValue = sentButtons[2][0].value;  // done

    const promptMsgId = 100;

    // Simulate clicking Feature B
    let resolved = runtime.resolveInput(chatId, decodeUiCallback(btnBValue), promptMsgId, true);
    expect(resolved.handled).toBe(true);

    // Wait for the next button rendering (after toggling Feature B)
    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalledTimes(2);
    });

    // Extract next flow buttons
    const nextButtons = transport.sendButtons.mock.lastCall[2];
    const nextDoneValue = nextButtons[2][0].value;

    // Simulate clicking Done
    resolved = runtime.resolveInput(chatId, decodeUiCallback(nextDoneValue), 101, true);
    expect(resolved.handled).toBe(true);

    const result = await customPromise;
    expect(result.cancelled).toBe(false);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].selected).toEqual(["Feature B"]);
  });

  it("handles @juicesharp/rpiv-ask-user-question single-select and text fallback option", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    runtime.setJuicesharpRpivAskUserQuestionData({
      questions: [
        {
          question: "Choose one",
          multiSelect: false,
          options: [
            { label: "Option X" },
            { label: "Option Y" },
          ],
        },
      ],
    });

    const ui = runtime.create(chatId);

    // Test Case: Select Option Y
    const customPromise = ui.custom<any>(() => ({} as any));

    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalled();
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const btnYValue = sentButtons[1][0].value; // o:1

    const promptMsgId = 100;
    const resolved = runtime.resolveInput(chatId, decodeUiCallback(btnYValue), promptMsgId, true);
    expect(resolved.handled).toBe(true);

    const result = await customPromise;
    expect(result.cancelled).toBe(false);
    expect(result.answers[0].answer).toBe("Option Y");
  });

  it("handles @juicesharp/rpiv-ask-user-question text input (other option)", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    runtime.setJuicesharpRpivAskUserQuestionData({
      questions: [
        {
          question: "What is your favorite color?",
          multiSelect: false,
          options: [{ label: "Blue" }],
        },
      ],
    });

    const ui = runtime.create(chatId);
    const customPromise = ui.custom<any>(() => ({} as any));

    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalled();
    });

    const sentButtons = transport.sendButtons.mock.lastCall[2];
    const otherValue = sentButtons[1][0].value; // "other" button is second row, first column

    const promptMsgId = 100;
    // Click "Type something..."
    let resolved = runtime.resolveInput(chatId, decodeUiCallback(otherValue), promptMsgId, true);
    expect(resolved.handled).toBe(true);

    // Wait for the prompt text instructions
    await vi.waitFor(() => {
      // should have sent a new button set with "Cancel"
      expect(transport.sendButtons).toHaveBeenCalledTimes(2);
    });

    const textPromptMsgId = 101;
    // Simulate user typing "Purple"
    resolved = runtime.resolveInput(chatId, "Purple", textPromptMsgId, false);
    expect(resolved.handled).toBe(true);

    const result = await customPromise;
    expect(result.cancelled).toBe(false);
    expect(result.answers[0].answer).toBe("Purple");
  });

  it("handles @aliou/pi-guardrails pathAccess prompt", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    runtime.setAliouPiGuardrailsData({
      feature: "pathAccess",
      action: { path: "/etc/passwd", origin: "cat" },
      context: { toolName: "cat" },
      reason: "Suspected system file access",
    });

    const ui = runtime.create(chatId);
    const customPromise = ui.custom<any>(() => ({} as any));

    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalled();
    });

    const lastCall = transport.sendButtons.mock.lastCall;
    expect(lastCall[1]).toContain("Outside Workspace Access");
    expect(lastCall[1]).toContain("/etc/passwd");

    const sentButtons = lastCall[2];
    const allowFileAlwaysValue = sentButtons[2][0].value; // allow-file-always is index 2

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(allowFileAlwaysValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await customPromise;
    expect(result).toBe("allow-file-always");
  });

  it("handles @aliou/pi-guardrails permissionGate prompt", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    runtime.setAliouPiGuardrailsData({
      feature: "permissionGate",
      action: { command: "rm -rf /" },
      reason: "Destructive command execution",
    });

    const ui = runtime.create(chatId);
    const customPromise = ui.custom<any>(() => ({} as any));

    await vi.waitFor(() => {
      expect(transport.sendButtons).toHaveBeenCalled();
    });

    const lastCall = transport.sendButtons.mock.lastCall;
    expect(lastCall[1]).toContain("Dangerous Command");
    expect(lastCall[1]).toContain("rm -rf /");

    const sentButtons = lastCall[2];
    const denyValue = sentButtons[2][0].value; // deny is index 2

    const resolved = runtime.resolveInput(chatId, decodeUiCallback(denyValue), 100, true);
    expect(resolved.handled).toBe(true);

    const result = await customPromise;
    expect(result).toBe("deny");
  });

  it("handles fallback message for unknown custom calls", async () => {
    const transport = mockTransport() as any;
    const runtime = createTelegramUiRuntime({
      getSession: () => ({
        extensionRunner: {
          getUIContext: () => ({})
        }
      } as any),
      transport,
    });

    const ui = runtime.create(chatId);
    const result = await ui.custom<any>(() => ({} as any));

    expect(result).toBeUndefined();
    expect(transport.sendText).toHaveBeenCalledWith(chatId, "📋 The agent needs input — please respond in the terminal.");
  });
});
