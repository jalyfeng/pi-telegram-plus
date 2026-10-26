import { describe, expect, it, vi } from "vitest";
import { OriginTracker } from "../tui/origin.ts";

const origin = { chatId: 1 };
const commandText = "!ls -la ptp-bang-marker.txt";

function setup(draft: string, editorAtEnd: string) {
  let editor = "";
  const writeDraft = vi.fn((text: string) => {
    editor = text;
    return true;
  });
  const tracker = new OriginTracker({
    isEditorFocused: () => true,
    readDraft: () => editor,
    writeDraft,
  });
  const scope = tracker.begin(origin, "bang", commandText, draft);
  editor = editorAtEnd;
  tracker.end(scope, "idle");
  return { editor: () => editor, writeDraft };
}

describe("origin draft restore", () => {
  it("restores an empty draft over the command text, leaving the input empty", () => {
    const { editor, writeDraft } = setup("", commandText);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writeDraft).toHaveBeenCalledWith("");
    expect(editor()).toBe("");
  });

  it("restores a non-empty draft over the command text", () => {
    const { editor, writeDraft } = setup("mydraft", commandText);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writeDraft).toHaveBeenCalledWith("mydraft");
    expect(editor()).toBe("mydraft");
  });

  it("keeps text the user typed during the command and does not write the draft", () => {
    let editor = "";
    const writeDraft = vi.fn((text: string) => {
      editor = text;
      return true;
    });
    const tracker = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => editor,
      writeDraft,
    });
    const scope = tracker.begin(origin, "bang", commandText, "");
    editor = "typed while running";
    tracker.end(scope, "idle");
    expect(writeDraft).not.toHaveBeenCalled();
    expect(scope.localEdited).toBe(true);
    expect(editor).toBe("typed while running");
  });

  it("with an already empty input, writes back a non-empty draft", () => {
    const { editor, writeDraft } = setup("mydraft", "");
    expect(writeDraft).toHaveBeenCalledWith("mydraft");
    expect(editor()).toBe("mydraft");
  });

  it("with an already empty input and an empty draft, the input stays empty", () => {
    const { editor } = setup("", "");
    expect(editor()).toBe("");
  });
});
