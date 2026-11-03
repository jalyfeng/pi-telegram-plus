/**
 * OMP's tool-approval dialog without a race handle (P2-38, P2-39).
 *
 * The fixture is the shape `ApprovalDialogComponent.describe()` returns in OMP
 * 18.14.1 (`packages/tui/src/overlays/approval-dialog.ts`): a title, the detail
 * rows, a `list` of choices keyed by their answer (`once`, `session`, `deny`,
 * grants, the remember toggle), and an action bar with Details / Deny / Approve.
 * Choices are replayed as `activate` events on the list, Details as an `action`
 * event; nothing is answered with keys.
 */
import { describe, expect, it, vi } from "vitest";
import { pickAdapter } from "../tui/adapters/index.ts";
import { renderDialog } from "../tui/render-telegram.ts";
import { approvalAdapter } from "../tui/adapters/approval.ts";
import type { AdapterContext, DialogModel, EntryInfo } from "../tui/model.ts";

type N = Record<string, unknown>;

const text = (value: string): N => ({ k: "text", p: { text: value } });
const item = (key: string, label: string): N => ({ k: "item", key, p: { label, role: "omp.approval.choice" } });
const button = (label: string, act: string): N => ({
  k: "row",
  p: { role: "omp.btn", actions: { click: act }, title: label },
  c: [text(label)],
});

/** The dialog as the host describes it while the call waits (`Approve bash for this session` offered). */
function approvalTree(options?: { session?: boolean; grants?: boolean }): N {
  const choices: N[] = [];
  if (options?.grants) {
    choices.push(item("remember", "☐ Remember across sessions"));
    choices.push(item("grant0", "Approve Directory: /repo"));
  }
  choices.push(item("once", options?.grants ? "Approve Once" : "Approve"));
  if (options?.session !== false) choices.push(item("session", "Approve bash for this session"));
  choices.push(item("deny", "Deny"));
  return {
    k: "col",
    p: { role: "omp.editor.ask.approval", gap: "md" },
    c: [
      { k: "text", key: "title", p: { text: "Allow tool: bash", role: "omp.approval.title", tone: "accent" } },
      { k: "col", key: "details", p: { role: "omp.approval.details" }, c: [text("Command: touch denied.txt")] },
      { k: "list", key: "choices", p: { selected: "once", role: "omp.approval.choices" }, c: choices },
      {
        k: "row",
        key: "bar",
        c: [button("Details", "expand"), button("Deny", "deny"), button("Approve", "approve")],
      },
    ],
  };
}

function dialog(tree: N = approvalTree()) {
  const events: unknown[] = [];
  const handleNativeEvent = vi.fn((event: unknown) => {
    events.push(event);
  });
  const component = { describe: vi.fn(() => tree), handleNativeEvent, render: vi.fn(() => ["screen"]) };
  return { component, events };
}

function ctxFor(host: "pi" | "omp" = "omp", entry?: EntryInfo) {
  const sendKey = vi.fn(() => true);
  const requestRender = vi.fn();
  const ctx: AdapterContext = {
    host,
    entry: entry ?? { kind: "approval", source: "omp", title: "Tool approval", approval: { full: "Allow tool: bash" } },
    sendKey,
    requestRender,
  };
  return { ctx, sendKey, requestRender };
}

function modelOf(component: object, ctx: AdapterContext) {
  const model = approvalAdapter.read(component, ctx);
  if (model.kind !== "approval") throw new Error(`expected an approval model, got ${model.kind}`);
  return model;
}

describe("approvalAdapter without a race handle (described dialog)", () => {
  it("claims the host's described tool approval on OMP", () => {
    const { component } = dialog();
    const { ctx } = ctxFor();
    expect(approvalAdapter.detect(component, ctx)).toBe(true);
  });

  it("does not claim a described panel that has no choices list, nor anything on pi", () => {
    const panelTree: N = { k: "col", c: [text("Hotkeys")] };
    const { component } = dialog(panelTree);
    expect(approvalAdapter.detect(component, ctxFor().ctx)).toBe(false);
    const { component: approval } = dialog();
    expect(approvalAdapter.detect(approval, ctxFor("pi").ctx)).toBe(false);
  });

  it("offers every host choice in the host's order, with Details last", () => {
    const { component } = dialog();
    const model = modelOf(component, ctxFor().ctx);
    expect(model.options).toEqual([
      { key: "once", label: "Approve" },
      { key: "session", label: "Approve bash for this session" },
      { key: "deny", label: "Deny" },
      { key: "expand", label: "Details" },
    ]);
  });

  it("keeps the host's grant choices, the remember toggle first", () => {
    const { component } = dialog(approvalTree({ grants: true }));
    const model = modelOf(component, ctxFor().ctx);
    expect(model.options.map((option) => option.key)).toEqual(["remember", "grant0", "once", "session", "deny", "expand"]);
    expect(model.options[2]?.label).toBe("Approve Once");
  });

  it("omits the session choice when the host offers none", () => {
    const { component } = dialog(approvalTree({ session: false }));
    const model = modelOf(component, ctxFor().ctx);
    expect(model.options.map((option) => option.key)).toEqual(["once", "deny", "expand"]);
  });

  it("reads the title and the detail rows, with the prompt's first line first", () => {
    const { component } = dialog();
    const model = modelOf(component, ctxFor().ctx);
    expect(model.title).toBe("Tool approval");
    expect(model.detail).toBe("Allow tool: bash\nCommand: touch denied.txt");
  });

  it("answers a choice by replaying it on the list, without keys", () => {
    for (const answer of ["once", "session", "deny"]) {
      const { component, events } = dialog();
      const { ctx, sendKey, requestRender } = ctxFor();
      expect(approvalAdapter.act(component, { type: "approve", key: answer }, ctx)).toBe(true);
      expect(events).toEqual([{ type: "activate", key: "choices", item: answer }]);
      expect(sendKey).not.toHaveBeenCalled();
      expect(requestRender).toHaveBeenCalled();
    }
  });

  it("Details replays the expand button of the action bar", () => {
    const { component, events } = dialog();
    const { ctx, sendKey } = ctxFor();
    expect(approvalAdapter.act(component, { type: "approve", key: "expand" }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "action", key: "bar/0", act: "expand", mods: [] }]);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with the host's deny choice", () => {
    const { component, events } = dialog();
    const { ctx, sendKey } = ctxFor();
    expect(approvalAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(events).toEqual([{ type: "activate", key: "choices", item: "deny" }]);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an answer the host no longer offers is refused, not sent", () => {
    const { component, events } = dialog(approvalTree({ session: false }));
    const { ctx } = ctxFor();
    expect(approvalAdapter.act(component, { type: "approve", key: "session" }, ctx)).toBe(false);
    expect(events).toEqual([]);
  });

  it("a session answer is the host's own choice, so the host records the grant", () => {
    // The host turns `session` into the grant itself (approval-dialog #take -> options.session.onApprove);
    // the adapter only has to name the choice, never mirror the grant on its side.
    const { component, events } = dialog();
    approvalAdapter.act(component, { type: "approve", key: "session" }, ctxFor().ctx);
    expect(events).toEqual([{ type: "activate", key: "choices", item: "session" }]);
  });

  it("is the adapter that claims the dialog, ahead of the described-panel fallback", () => {
    const { component } = dialog();
    const adapter = pickAdapter(component, ctxFor().ctx);
    expect(adapter?.id).toBe("omp-approval");
  });

  it("sends typed text to the host composer as its native send, never as keys", () => {
    const { component, events } = dialog();
    const sendText = vi.fn(() => true);
    const { ctx, sendKey } = ctxFor();
    expect(approvalAdapter.act(component, { type: "submit", text: "change course" }, { ...ctx, sendText })).toBe(true);
    expect(sendText).toHaveBeenCalledWith("change course");
    expect(events).toEqual([]);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("refuses typed text when the composer cannot take it", () => {
    const { component } = dialog();
    const { ctx, sendKey } = ctxFor();
    expect(approvalAdapter.act(component, { type: "submit", text: "change course" }, { ...ctx, sendText: () => false })).toBe(false);
    expect(approvalAdapter.act(component, { type: "submit", text: "change course" }, ctx)).toBe(false);
    expect(sendKey).not.toHaveBeenCalled();
  });
});

describe("approval card in Telegram", () => {
  const CTX = { sessionId: "s1", generation: 1 };
  const HINT = "Send a message to deny and give new instructions.";

  it("offers the host's choices as buttons, with no second Close or Cancel beside Deny", () => {
    const model: DialogModel = {
      kind: "approval",
      title: "Tool approval",
      detail: "Allow tool: bash\nCommand: touch denied.txt",
      options: [
        { key: "once", label: "Approve" },
        { key: "session", label: "Approve bash for this session" },
        { key: "deny", label: "Deny" },
        { key: "expand", label: "Details" },
      ],
    };
    const shown = renderDialog(model, CTX);
    const labels = shown.rows.flat().map((button) => button.text);
    expect(labels).toEqual(["Approve", "Approve bash for this session", "Deny", "Details"]);
    expect(shown.text).toContain(HINT);
  });

  it("keeps a Cancel row only when the model offers no deny answer", () => {
    const model: DialogModel = { kind: "approval", title: "Tool approval", options: [{ key: "once", label: "Allow once" }] };
    const labels = renderDialog(model, CTX).rows.flat().map((button) => button.text);
    expect(labels).toEqual(["Allow once", "Cancel"]);
  });
});
