import { describe, expect, it } from "vitest";
import { extractToolResultParts, extractOversizedCodeBlocks, extractOversizedTables } from "../renderer.ts";

describe("extractToolResultParts", () => {
  it("extracts text content parts joined by blank lines", () => {
    const result = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    };
    const parts = extractToolResultParts(result);
    expect(parts.body).toBe("line one\n\nline two");
    expect(parts.images).toEqual([]);
  });

  it("extracts image parts", () => {
    const result = {
      content: [
        { type: "text", text: "see image" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    const parts = extractToolResultParts(result);
    expect(parts.body).toBe("see image");
    expect(parts.images).toEqual([{ data: "base64data", mimeType: "image/png" }]);
  });

  it("ignores non-text/image parts", () => {
    const result = {
      content: [
        { type: "text", text: "ok" },
        { type: "unknown", foo: "bar" } as unknown,
        { type: "image", data: "d" },
      ],
    };
    const parts = extractToolResultParts(result);
    expect(parts.body).toBe("ok");
    expect(parts.images).toHaveLength(1);
  });

  it("returns empty body for results without content array", () => {
    const parts = extractToolResultParts({ details: { foo: "bar" } });
    expect(parts.body).toBe("");
    expect(parts.images).toEqual([]);
  });

  it("handles a bare string result", () => {
    const parts = extractToolResultParts("raw string output");
    expect(parts.body).toBe("raw string output");
  });

  it("drops empty text parts", () => {
    const result = {
      content: [
        { type: "text", text: "" },
        { type: "text", text: "kept" },
      ],
    };
    const parts = extractToolResultParts(result);
    expect(parts.body).toBe("kept");
  });

  it("preserves multi-line tool output (e.g. bash ls result)", () => {
    const result = {
      content: [{ type: "text", text: "total 0\ndrwxr-xr-x  2 me  staff  64 Jun 19 a\ndrwxr-xr-x  2 me  staff  64 Jun 19 b" }],
    };
    const parts = extractToolResultParts(result);
    expect(parts.body).toContain("total 0");
    expect(parts.body).toContain("drwxr-xr-x  2 me  staff  64 Jun 19 a");
    // Newlines inside a single text part are preserved verbatim
    expect(parts.body.split("\n")).toHaveLength(3);
  });
});

describe("extractOversizedCodeBlocks", () => {
  const big = "x".repeat(4001); // > OVERSIZED_CODE_BYTES (4000)
  const fence = (lang: string, content: string) => "```" + lang + "\n" + content + "\n```";

  it("leaves small code blocks inline", () => {
    const body = "intro\n\n" + fence("ts", "const x = 1;") + "\n";
    const { body: out, blocks } = extractOversizedCodeBlocks(body);
    expect(blocks).toEqual([]);
    expect(out).toBe(body);
  });

  it("extracts oversized code blocks and replaces with a notice", () => {
    const body = "intro\n\n" + fence("ts", big) + "\n";
    const { body: out, blocks } = extractOversizedCodeBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("ts");
    expect(blocks[0].content).toBe(big);
    expect(blocks[0].fileName).toBe("code-1.ts");
    expect(out).not.toContain("```");
    expect(out).toContain("attached: code-1.ts");
    expect(out).toContain("intro");
  });

  it("maps language to file extension", () => {
    const { blocks } = extractOversizedCodeBlocks(fence("python", big));
    expect(blocks[0].fileName).toBe("code-1.py");
  });

  it("defaults unknown language to .txt", () => {
    const { blocks } = extractOversizedCodeBlocks(fence("", big));
    expect(blocks[0].lang).toBe("");
    expect(blocks[0].fileName).toBe("code-1.txt");
  });

  it("handles multiple oversized blocks", () => {
    const body = fence("js", big) + "\n\ntext\n\n" + fence("py", big);
    const { body: out, blocks } = extractOversizedCodeBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].fileName).toBe("code-1.js");
    expect(blocks[1].fileName).toBe("code-2.py");
    expect(out).toContain("text");
  });

  it("counts lines in the notice", () => {
    const content = "a\nb\nc\n" + big;
    const { body: out } = extractOversizedCodeBlocks(fence("ts", content));
    expect(out).toContain("4 lines");
  });
});

describe("extractOversizedTables", () => {
  it("leaves small tables inline", () => {
    const body = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const { body: out, blocks } = extractOversizedTables(body);
    expect(blocks).toEqual([]);
    expect(out).toBe(body);
  });

  it("extracts tables whose rendered HTML exceeds one message", () => {
    // ~80 rows × 3 cols → rendered card HTML > 3600 bytes
    const rows = Array.from({ length: 80 }, (_, i) => `| r${i} | ${"v".repeat(20)}${i} | ${"x".repeat(20)}${i} |`).join("\n");
    const body = `| H1 | H2 | H3 |\n| --- | --- | --- |\n${rows}`;
    const { body: out, blocks } = extractOversizedTables(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fileName).toBe("table-1.md");
    expect(blocks[0].cols).toBe(3);
    expect(blocks[0].rows).toBe(80);
    expect(out).toContain("attached: table-1.md");
    // original table markdown removed from body
    expect(out).not.toContain("| H1 |");
  });

  it("extracts a table with a huge single cell (transpose oversized)", () => {
    const huge = "z".repeat(4000);
    const body = `| K | V |\n| --- | --- |\n| a | ${huge} |`;
    const { body: out, blocks } = extractOversizedTables(body);
    expect(blocks).toHaveLength(1);
    expect(out).toContain("attached: table-1.md");
  });

  it("handles multiple oversized tables with incrementing names", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| r${i} | ${"v".repeat(30)} |`).join("\n");
    const body = `# t1\n\n| A | B |\n| --- | --- |\n${rows}\n\n# t2\n\n| C | D |\n| --- | --- |\n${rows}`;
    const { blocks } = extractOversizedTables(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].fileName).toBe("table-1.md");
    expect(blocks[1].fileName).toBe("table-2.md");
  });

  it("keeps prose around the table", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| r${i} | ${"v".repeat(30)} |`).join("\n");
    const body = `before text\n\n| A | B |\n| --- | --- |\n${rows}\n\nafter text`;
    const { body: out, blocks } = extractOversizedTables(body);
    expect(blocks).toHaveLength(1);
    expect(out).toContain("before text");
    expect(out).toContain("after text");
  });
});
