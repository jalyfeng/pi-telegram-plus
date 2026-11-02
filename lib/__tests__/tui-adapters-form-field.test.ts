/**
 * A `TextFormField` nested in a host panel (OMP's session rename dialog, the
 * MCP add wizard's text steps) is read and answered through its own public
 * members: `getValue`, `setValue`, `submit` and `input`. These fakes carry the
 * same shape; the tests pin what the adapters read and call.
 */
import { describe, expect, it, vi } from "vitest";
import { findTextFormField, isTextFormField } from "../tui/adapters/form-field.ts";
import { tspInputAdapter, tspPickerAdapter } from "../tui/adapters/tsp.ts";
import type { AdapterContext } from "../tui/model.ts";

function ctxFor(): AdapterContext {
  return { host: "omp", sendKey: () => true, requestRender: () => undefined };
}

/** A pi-tui `TextFormField` stand-in: value, `input.mask`, validation-free submit. */
function makeField(value: string, opts: { mask?: boolean } = {}) {
  const field = {
    input: { mask: opts.mask ?? false, onEscape: vi.fn() },
    getValue: vi.fn(() => value),
    setValue: vi.fn((next: string) => { value = next; }),
    submit: vi.fn(),
  };
  return field;
}

/**
 * OMP's session selector while its rename dialog is open: the card describes
 * itself (no picker node), and the rename field sits three components down
 * through the public `children` arrays.
 */
function renameSelector(field: object) {
  const panel = { children: [field] };
  const contentSlot = { children: [panel] };
  return {
    children: [contentSlot],
    describe: () => ({ k: "card", p: { role: "omp.overlay.sessions" } }),
    handleNativeEvent: vi.fn(),
  };
}

describe("TextFormField shape", () => {
  it("recognises the field by its members, not by its class name", () => {
    const field = makeField("x");
    expect(isTextFormField(field)).toBe(true);
    expect(isTextFormField({ getValue: () => "", setValue: () => undefined, submit: () => undefined })).toBe(false);
    expect(isTextFormField({ input: {}, getValue: () => "" })).toBe(false);
  });

  it("finds a field three components down and reports nothing when there is none", () => {
    const field = makeField("old title");
    expect(findTextFormField(renameSelector(field))).toBe(field);
    expect(findTextFormField(renameSelector({ input: {} }))).toBeUndefined();
  });
});

describe("tsp picker with a nested rename field", () => {
  it("reads the field as an input model, offering the current value as the placeholder", () => {
    const field = makeField("old title");
    expect(tspPickerAdapter.read(renameSelector(field), ctxFor())).toEqual({
      kind: "input",
      title: "Input",
      placeholder: "old title",
      secret: false,
    });
  });

  it("never offers a masked field's value as a placeholder", () => {
    const field = makeField("hunter2", { mask: true });
    expect(tspPickerAdapter.read(renameSelector(field), ctxFor())).toEqual({
      kind: "input",
      title: "Input",
      secret: true,
    });
  });

  it("submits the text through the field's setValue and then submit", () => {
    const field = makeField("old title");
    const selector = renameSelector(field);
    const requestRender = vi.fn();
    const ok = tspPickerAdapter.act(selector, { type: "submit", text: "new title" }, { ...ctxFor(), requestRender });
    expect(ok).toBe(true);
    expect(field.setValue).toHaveBeenCalledWith("new title");
    expect(field.submit).toHaveBeenCalledTimes(1);
    expect(field.setValue.mock.invocationCallOrder[0]).toBeLessThan(field.submit.mock.invocationCallOrder[0]);
    expect(requestRender).toHaveBeenCalled();
    expect(selector.handleNativeEvent).not.toHaveBeenCalled();
  });

  it("cancels through the field's own escape callback", () => {
    const field = makeField("old title");
    expect(tspPickerAdapter.act(renameSelector(field), { type: "cancel" }, ctxFor())).toBe(true);
    expect(field.input.onEscape).toHaveBeenCalledTimes(1);
    expect(field.submit).not.toHaveBeenCalled();
  });

  it("keeps the unsupported model when nothing nested is a field", () => {
    const selector = {
      children: [{ children: [{ input: {} }] }],
      describe: () => ({ k: "card", p: { role: "omp.overlay.sessions" } }),
      handleNativeEvent: vi.fn(),
    };
    expect(tspPickerAdapter.read(selector, ctxFor())).toEqual({
      kind: "unsupported",
      what: "OMP picker closed or no longer a picker",
    });
    expect(tspPickerAdapter.act(selector, { type: "submit", text: "x" }, ctxFor())).toBe(false);
  });
});

describe("tsp input wizard step (MCP add)", () => {
  /**
   * The wizard as OMP builds it: the step's TextFormField is private to the
   * wizard (its WizardStep holds it in a private field), so the public `children`
   * walk finds no field. Typing reaches the field through the wizard's own
   * `handleInput`; the footer's `next` button is in the description.
   */
  function wizardRoot(options: { next: boolean }) {
    const events: unknown[] = [];
    let value = "";
    const input = {
      describe: () => ({ k: "input", p: { text: value, placeholder: "localfs" } }),
    };
    const footer = options.next
      ? [{ k: "row", p: { role: "omp.btn", actions: { click: "next" } }, c: [{ k: "text", p: { text: "Next" } }] }]
      : [];
    const step = { debugKind: "WizardStep" };
    return {
      children: [{ children: [step] }],
      describe: () => ({
        k: "overlay",
        c: [
          { k: "text", p: { text: "Name the server", role: "omp.mcpAdd.title" } },
          { k: "col", c: [input] },
          ...footer,
        ],
      }),
      handleInput: (data: string) => {
        if (data === "\x15") value = "";
        else value += data;
      },
      handleNativeEvent: (event: unknown) => {
        events.push(event);
      },
      events,
      value: () => value,
    };
  }

  it("sends next after typing the name, so the wizard submits its field", () => {
    const root = wizardRoot({ next: true });
    expect(tspInputAdapter.act(root, { type: "submit", text: "localfs" }, ctxFor())).toBe(true);
    expect(root.value()).toBe("localfs");
    expect(root.events).toEqual([{ type: "action", key: "", act: "next", mods: [] }]);
  });

  it("keeps the submit event for a dialog without a next button", () => {
    const root = wizardRoot({ next: false });
    expect(tspInputAdapter.act(root, { type: "submit", text: "localfs" }, ctxFor())).toBe(true);
    expect(root.events).toEqual([{ type: "action", key: "", act: "submit", mods: [] }]);
  });

  it("answers through a nested field when one is reachable", () => {
    const field = makeField("");
    const events: unknown[] = [];
    const fieldComponent = Object.assign(field, {
      describe: () => ({ k: "input", p: { text: "", placeholder: "localfs" } }),
    });
    const root = {
      children: [fieldComponent],
      describe: () => ({ k: "frame", c: [{ k: "text", p: { text: "Name the server", role: "omp.mcpAdd.title" } }, fieldComponent] }),
      handleNativeEvent: (event: unknown) => {
        events.push(event);
      },
    };
    expect(tspInputAdapter.act(root, { type: "submit", text: "localfs" }, ctxFor())).toBe(true);
    expect(field.setValue).toHaveBeenCalledWith("localfs");
    expect(field.submit).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });
});
