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

describe("a new Telegram prompt supersedes a finished command's idle window", () => {
  function trackerWithEditor() {
    const tracker = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => "",
      writeDraft: () => true,
    });
    return tracker;
  }

  it("ends a scope whose submit completed, with reason superseded", () => {
    const tracker = trackerWithEditor();
    const scope = tracker.begin(origin, "agents", "/agents", "");
    tracker.markSubmitDone(scope);
    expect(tracker.supersede()).toBe(true);
    expect(scope.ended).toBe(true);
    expect(scope.endReason).toBe("superseded");
    expect(tracker.active()).toBeUndefined();
  });

  it("leaves a scope whose command is still running", () => {
    const tracker = trackerWithEditor();
    const scope = tracker.begin(origin, "goal", "/goal", "");
    expect(tracker.supersede()).toBe(false);
    expect(scope.ended).toBe(false);
    expect(tracker.active()).toBe(scope);
    tracker.dispose();
  });

  it("does nothing when no scope is active", () => {
    const tracker = trackerWithEditor();
    expect(tracker.supersede()).toBe(false);
  });
});

describe("a Telegram command's draft is restored when the host has taken the command (#59)", () => {
  it("restores the draft right after the submit completes, not when the scope ends", () => {
    let editor = "my draft";
    const writeDraft = vi.fn((text: string) => {
      editor = text;
      return true;
    });
    const tracker = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => editor,
      writeDraft,
    });
    const scope = tracker.begin(origin, "plan", "/plan", "my draft");
    // The host takes the command text from the editor on submit.
    editor = "/plan";
    tracker.markSubmitDone(scope);
    expect(writeDraft).toHaveBeenCalledWith("my draft");
    expect(editor).toBe("my draft");
    expect(scope.ended).toBe(false);
    tracker.dispose();
  });

  it("keeps a shell (!) scope's restore at scope end, as #17 requires", () => {
    let editor = "my draft";
    const writeDraft = vi.fn((text: string) => {
      editor = text;
      return true;
    });
    const tracker = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => editor,
      writeDraft,
    });
    const scope = tracker.begin(origin, "!", commandText, "my draft");
    editor = commandText;
    tracker.markSubmitDone(scope);
    expect(writeDraft).not.toHaveBeenCalled();
    tracker.end(scope, "idle");
    expect(writeDraft).toHaveBeenCalledWith("my draft");
  });
});
