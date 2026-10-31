import { describe, expect, it } from "vitest";
import { richMessageToPlainText } from "../rich-text-plain.ts";

describe("richMessageToPlainText", () => {
  it("returns empty text for missing or malformed input", () => {
    expect(richMessageToPlainText(undefined)).toBe("");
    expect(richMessageToPlainText(null as any)).toBe("");
    expect(richMessageToPlainText({} as any)).toBe("");
    expect(richMessageToPlainText({ blocks: "nope" } as any)).toBe("");
    expect(richMessageToPlainText({ blocks: [null, 3, "x"] } as any)).toBe("");
  });

  it("joins paragraph and heading blocks with newlines", () => {
    expect(richMessageToPlainText({
      blocks: [
        { type: "heading", text: "Report", size: 2 },
        { type: "paragraph", text: "First line" },
      ],
    } as any)).toBe("Report\nFirst line");
  });

  it("prefixes list items with labels and checkboxes", () => {
    expect(richMessageToPlainText({
      blocks: [{
        type: "list",
        items: [
          { label: "1.", blocks: [{ type: "paragraph", text: "Plain item" }] },
          { label: "", blocks: [{ type: "paragraph", text: "Unlabelled" }] },
          { label: "•", has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "Done" }] },
          { label: "•", has_checkbox: true, is_checked: false, blocks: [{ type: "paragraph", text: "Open" }] },
        ],
      }],
    } as any)).toBe("1. Plain item\n- Unlabelled\n• [x] Done\n• [ ] Open");
  });

  it("renders table rows with cells joined by pipes, header row included", () => {
    expect(richMessageToPlainText({
      blocks: [{
        type: "table",
        cells: [
          [{ text: "Name", is_header: true, align: "left", valign: "top" }, { text: "Score", is_header: true, align: "left", valign: "top" }],
          [{ text: "alice", align: "left", valign: "top" }, { text: { type: "bold", text: "9" }, align: "right", valign: "top" }],
        ],
        caption: "Scores",
      }],
    } as any)).toBe("Scores\nName | Score\nalice | 9");
  });

  it("flattens nested blockquotes", () => {
    expect(richMessageToPlainText({
      blocks: [{
        type: "blockquote",
        blocks: [
          { type: "paragraph", text: "outer" },
          { type: "blockquote", blocks: [{ type: "paragraph", text: "inner" }] },
        ],
      }],
    } as any)).toBe("outer\ninner");
  });

  it("keeps photo captions and adds a placeholder", () => {
    expect(richMessageToPlainText({
      blocks: [{ type: "photo", caption: { text: "A chart" } }, { type: "photo" }],
    } as any)).toBe("[photo] A chart\n[photo]");
  });

  it("skips dividers and anchors, and renders math expressions", () => {
    expect(richMessageToPlainText({
      blocks: [
        { type: "paragraph", text: "before" },
        { type: "divider" },
        { type: "anchor", name: "top" },
        { type: "mathematical_expression", expression: "x^2" },
      ],
    } as any)).toBe("before\nx^2");
  });

  it("reads RichText arrays and nested bold objects", () => {
    expect(richMessageToPlainText({
      blocks: [{
        type: "paragraph",
        text: ["Hello ", { type: "bold", text: ["big ", { type: "italic", text: "world" }] }, "!"],
      }],
    } as any)).toBe("Hello big world!");
  });

  it("does not throw on unknown block types and uses their text or nested blocks", () => {
    expect(richMessageToPlainText({
      blocks: [
        { type: "future_block", text: "from text" },
        { type: "future_container", blocks: [{ type: "paragraph", text: "from blocks" }] },
        { type: "future_empty" },
      ],
    } as any)).toBe("from text\nfrom blocks");
  });

  it("stops at the nesting limit instead of recursing forever", () => {
    let block: Record<string, unknown> = { type: "paragraph", text: "deep" };
    for (let i = 0; i < 100; i++) block = { type: "blockquote", blocks: [block] };
    expect(() => richMessageToPlainText({ blocks: [block] } as any)).not.toThrow();
    expect(richMessageToPlainText({ blocks: [block] } as any)).toBe("");
  });
});
