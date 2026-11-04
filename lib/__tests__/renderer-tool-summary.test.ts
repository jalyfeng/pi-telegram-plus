import { describe, expect, it } from "vitest";
import { summarizeToolArgs } from "../renderer.ts";

describe("summarizeToolArgs: pi edit", () => {
  it("shows the file path for a single replacement", () => {
    expect(summarizeToolArgs("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe("src/a.ts");
  });

  it("adds the edit count when there are several replacements", () => {
    expect(
      summarizeToolArgs("edit", {
        path: "src/a.ts",
        edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }, { oldText: "e", newText: "f" }],
      }),
    ).toBe("src/a.ts (3 edits)");
  });

  it("keeps the OMP hashline patch summary when there is no path", () => {
    expect(summarizeToolArgs("edit", { input: "[lib/x.ts#AB]\n+ one" })).toBe("x.ts");
  });
});

describe("summarizeToolArgs: find and ls", () => {
  it("formats find like grep, with and without path", () => {
    expect(summarizeToolArgs("find", { pattern: "*.ts", path: "lib" })).toBe(`"*.ts" in lib`);
    expect(summarizeToolArgs("find", { pattern: "*.ts" })).toBe(`"*.ts"`);
  });

  it("shows the path for ls and nothing without one", () => {
    expect(summarizeToolArgs("ls", { path: "lib" })).toBe("lib");
    expect(summarizeToolArgs("ls", {})).toBe("");
  });
});

describe("summarizeToolArgs: tg_attach", () => {
  it("shows the file name for one path", () => {
    expect(summarizeToolArgs("tg_attach", { paths: ["/work/out/notes.md"] })).toBe("notes.md");
  });

  it("lists up to three file names and counts the rest", () => {
    expect(summarizeToolArgs("tg_attach", { paths: ["/x/a.ts", "/y/b.ts"] })).toBe("a.ts, b.ts");
    expect(
      summarizeToolArgs("tg_attach", { paths: ["/p/a.ts", "/p/b.ts", "/p/c.ts", "/p/d.ts", "/p/e.ts"] }),
    ).toBe("a.ts, b.ts, c.ts (+2 more)");
  });
});

describe("summarizeToolArgs: unknown tools", () => {
  it("falls back to an array of strings made of file names", () => {
    expect(summarizeToolArgs("some_tool", { files: ["/p/a.ts", "/p/b.ts"] })).toBe("a.ts, b.ts");
  });

  it("returns an empty summary instead of JSON when nothing usable is found", () => {
    expect(summarizeToolArgs("some_tool", { count: 3, mixed: ["x", 1] })).toBe("");
  });
});

describe("summarizeToolArgs: todo append", () => {
  it("pluralises the item count", () => {
    expect(summarizeToolArgs("todo", { op: "append", items: [{ text: "x" }] })).toBe("append 1 item");
    expect(summarizeToolArgs("todo", { op: "append", items: [{ text: "x" }, { text: "y" }] })).toBe("append 2 items");
  });
});
