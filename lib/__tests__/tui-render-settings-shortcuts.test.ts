import { describe, expect, it } from "vitest";
import { renderDialog, type RenderContext } from "../tui/render-telegram.ts";
import type { DialogModel } from "../tui/model.ts";

const CTX: RenderContext = { sessionId: "s1", generation: 1 };

type SettingsModel = Extract<DialogModel, { kind: "settings" }>;

/** Twelve setting rows plus ten page switches, the way OMP's settings page reports them. */
function settingsWithPages(): SettingsModel {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    key: `row${index}`,
    label: `Row ${index}`,
    value: "On",
    values: ["On", "Off"],
  }));
  const shortcuts = Array.from({ length: 10 }, (_, index) => ({
    key: `page:p${index}`,
    label: `📄 Page ${index}`,
    hasSubmenu: true,
    shortcut: true,
  }));
  return { kind: "settings", title: "Settings", subtitle: "General", items: [...rows, ...shortcuts] };
}

/** The button texts of each keyboard row, in order. */
function labels(rows: { text: string }[][]): string[][] {
  return rows.map((row) => row.map((button) => button.text));
}

describe("settings page switches as a compact block", () => {
  it("starts page 1 with the first row and counts only the rows", () => {
    const rendered = renderDialog(settingsWithPages(), { ...CTX, page: 0 });
    expect(rendered.pages).toBe(2);
    expect(rendered.text).toContain("Page 1/2 · 12 items");
    expect(labels(rendered.rows)[0]).toEqual(["◉ Row 0: On"]);
  });

  it("keeps the page switches below the nav row and above Cancel, three per row", () => {
    const flat = labels(renderDialog(settingsWithPages(), { ...CTX, page: 0 }).rows);
    const cancel = flat.length - 1;
    expect(flat[cancel]).toEqual(["Cancel"]);
    const block = flat.slice(cancel - 4, cancel);
    expect(block.map((row) => row.length)).toEqual([3, 3, 3, 1]);
    expect(block.flat()).toEqual(Array.from({ length: 10 }, (_, index) => `📄 Page ${index}`));
    // The nav row (1/2 and Next) comes right before the block.
    expect(flat[cancel - 5].map((text) => text.trim())).toContain("Next ▶");
    // A page switch is not drawn as a row (no submenu marker).
    expect(block.flat().some((text) => text.startsWith("▸"))).toBe(false);
  });

  it("does not list the page switches in the message body", () => {
    const text = renderDialog(settingsWithPages(), { ...CTX, page: 0 }).text;
    expect(text).not.toContain("Page 0");
    expect(text).toContain("Row 0");
  });

  it("shows the same page-switch block on page 2", () => {
    const rendered = renderDialog(settingsWithPages(), { ...CTX, page: 1 });
    expect(rendered.text).toContain("Page 2/2 · 12 items");
    expect(labels(rendered.rows)[0]).toEqual(["◉ Row 10: On"]);
    const flat = labels(rendered.rows).flat();
    for (let index = 0; index < 10; index++) expect(flat).toContain(`📄 Page ${index}`);
  });

  it("maps each page-switch button to its page key through a keyMap arg outside the row args", () => {
    const rendered = renderDialog(settingsWithPages(), { ...CTX, page: 0 });
    expect(rendered.keyMap.get("g0")).toBe("page:p0");
    expect(rendered.keyMap.get("g9")).toBe("page:p9");
    expect(rendered.keyMap.get("0.0.0")).toBe("row0=On");
  });
});
