import { describe, expect, it } from "vitest";
import { hasGfmTable } from "../markdown.ts";
import { escapeRichMarkdown, richMarkdownForTables, TELEGRAM_RICH_TEXT_LIMIT } from "../rich-message.ts";

const TABLE = [
  "| Project | Status | Count |",
  "| --- | :---: | ---: |",
  "| dsh-im plugin | Installed | 1 |",
  "| Current branch | master | 1 |",
].join("\n");

describe("hasGfmTable", () => {
  it("detects a real GFM pipe table", () => {
    expect(hasGfmTable(TABLE)).toBe(true);
    expect(hasGfmTable(`intro\n\n${TABLE}\n\noutro`)).toBe(true);
  });

  it("ignores pipe text that is not a table", () => {
    expect(hasGfmTable("a | b\nc | d")).toBe(false);
    expect(hasGfmTable("| a | b |\n| c | d |")).toBe(false);
    expect(hasGfmTable("---")).toBe(false);
  });

  it("ignores tables inside fenced code blocks", () => {
    expect(hasGfmTable(`\`\`\`md\n${TABLE}\n\`\`\``)).toBe(false);
  });
});

describe("escapeRichMarkdown", () => {
  it("escapes ampersands and angle brackets that could become markup", () => {
    expect(escapeRichMarkdown('<tg-spoiler>a & b')).toBe("&lt;tg-spoiler>a &amp; b");
  });

  it("leaves `>` alone so blockquotes keep working", () => {
    expect(escapeRichMarkdown("> quoted")).toBe("> quoted");
  });

  it("escapes plain prose as before", () => {
    expect(escapeRichMarkdown("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("keeps fenced code blocks verbatim and escapes the prose around them", () => {
    const text = "a < b\n```ts\nfunction f() { return x < 2 && x > 0; }\n```\nc & d";
    expect(escapeRichMarkdown(text)).toBe(
      "a &lt; b\n```ts\nfunction f() { return x < 2 && x > 0; }\n```\nc &amp; d",
    );
  });

  it("keeps tilde fences and indented fences verbatim", () => {
    expect(escapeRichMarkdown("~~~\na<b&c\n~~~")).toBe("~~~\na<b&c\n~~~");
    expect(escapeRichMarkdown("  ```\n  a<b\n  ```")).toBe("  ```\n  a<b\n  ```");
  });

  it("closes a fence only with the same character and at least the same length", () => {
    const text = "````\n<x>\n```\n&\n~~~~\n````\n<";
    expect(escapeRichMarkdown(text)).toBe("````\n<x>\n```\n&\n~~~~\n````\n&lt;");
  });

  it("keeps an unclosed fence verbatim to the end, as CommonMark does", () => {
    expect(escapeRichMarkdown("a < b\n```\nx < y")).toBe("a &lt; b\n```\nx < y");
  });

  it("keeps inline code spans verbatim and escapes the text outside them on the same line", () => {
    expect(escapeRichMarkdown("use `a<b` and <tag> & `c&d`")).toBe(
      "use `a<b` and &lt;tag> &amp; `c&d`",
    );
  });

  it("matches inline code delimiters by run length", () => {
    expect(escapeRichMarkdown("``a`b<c``")).toBe("``a`b<c``");
    expect(escapeRichMarkdown("``a`b`` <c")).toBe("``a`b`` &lt;c");
  });

  it("treats an unclosed backtick run as literal text", () => {
    expect(escapeRichMarkdown("a `b < c")).toBe("a `b &lt; c");
    expect(escapeRichMarkdown("`a` and `b<c")).toBe("`a` and `b&lt;c");
  });

  it("does not let a code span cross a blank line", () => {
    expect(escapeRichMarkdown("a `b\n\nc < d` e")).toBe("a `b\n\nc &lt; d` e");
  });
});

describe("richMarkdownForTables", () => {
  it("returns the table markdown unchanged", () => {
    expect(richMarkdownForTables(TABLE)).toBe(TABLE);
  });

  it("returns undefined when the answer has no real table", () => {
    expect(richMarkdownForTables("just prose")).toBeUndefined();
    expect(richMarkdownForTables("| pseudo | table |\n| no | separator |")).toBeUndefined();
  });

  it("fences pseudo-tables so they keep monospace alignment", () => {
    const source = `${TABLE}\n\n\`ls -la\` style output:\n\naaa | bbb | ccc\n111 | 222 | 333`;
    const rich = richMarkdownForTables(source);
    expect(rich).toContain(TABLE);
    expect(rich).toContain("```\naaa | bbb | ccc\n111 | 222 | 333\n```");
  });

  it("escapes raw HTML in the body", () => {
    const rich = richMarkdownForTables(`${TABLE}\n\n<script>alert(1)</script>`);
    expect(rich).toContain("&lt;script>alert(1)&lt;/script>");
    expect(rich).not.toContain("<script>");
  });

  it("keeps code inside fences and inline code unescaped in the rich payload", () => {
    const source = `${TABLE}\n\n\`\`\`ts\nfunction f() { return x < 2 && y; }\n\`\`\`\n\nuse \`a<b\` or a < b & c`;
    const rich = richMarkdownForTables(source);
    expect(rich).toContain("function f() { return x < 2 && y; }");
    expect(rich).toContain("`a<b`");
    expect(rich).toContain("or a &lt; b &amp; c");
  });

  it("falls back to HTML for an unterminated code fence", () => {
    expect(richMarkdownForTables(`${TABLE}\n\n\`\`\`ts\nconst a = 1;`)).toBeUndefined();
  });

  it("falls back to HTML when the answer exceeds one Rich Message", () => {
    const huge = `${TABLE}\n\n${"x".repeat(TELEGRAM_RICH_TEXT_LIMIT)}`;
    expect(richMarkdownForTables(huge)).toBeUndefined();
    expect(richMarkdownForTables(huge.slice(0, TELEGRAM_RICH_TEXT_LIMIT - 100))).toBeDefined();
  });
});
