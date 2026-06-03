import { describe, expect, it } from "vitest";
import { inlineMarkdownToHtml, markdownToTelegramHtml } from "../markdown.ts";

describe("inlineMarkdownToHtml", () => {
  it("converts **bold** to <b>", () => {
    expect(inlineMarkdownToHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts __bold__ to <b>", () => {
    expect(inlineMarkdownToHtml("__hello__")).toBe("<b>hello</b>");
  });

  it("converts *italic* to <i>", () => {
    expect(inlineMarkdownToHtml("*hello*")).toBe("<i>hello</i>");
  });

  it("converts _italic_ to <i>", () => {
    expect(inlineMarkdownToHtml("_hello_")).toBe("<i>hello</i>");
  });

  it("converts `code` to <code>", () => {
    expect(inlineMarkdownToHtml("`var x`")).toBe("<code>var x</code>");
  });

  it("converts [link](url) to <a>", () => {
    expect(inlineMarkdownToHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it("does not double-escape & in link URLs", () => {
    expect(inlineMarkdownToHtml("[search](https://example.com?a=1&b=2)")).toBe(
      '<a href="https://example.com?a=1&amp;b=2">search</a>',
    );
  });

  it("escapes HTML in link labels", () => {
    expect(inlineMarkdownToHtml("[a<b>c](https://example.com)")).toBe(
      '<a href="https://example.com">a&lt;b&gt;c</a>',
    );
  });

  it("escapes & in link labels", () => {
    expect(inlineMarkdownToHtml("[a&b](https://example.com)")).toBe(
      '<a href="https://example.com">a&amp;b</a>',
    );
  });

  it("escapes & in regular text", () => {
    expect(inlineMarkdownToHtml("a & b")).toBe("a &amp; b");
  });

  it("handles plain text unchanged", () => {
    expect(inlineMarkdownToHtml("hello world")).toBe("hello world");
  });

  it("does not cross newlines for bold", () => {
    expect(inlineMarkdownToHtml("**hel\nlo**")).toBe("**hel\nlo**");
  });

  it("handles multiple formatting elements", () => {
    expect(inlineMarkdownToHtml("**bold** and *italic*")).toBe(
      "<b>bold</b> and <i>italic</i>",
    );
  });
});

describe("markdownToTelegramHtml", () => {
  // ── Headings ──

  it("converts H1 to bold+underline", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b><u>Title</u></b>");
  });

  it("converts H2 to bold", () => {
    expect(markdownToTelegramHtml("## Section")).toBe("<b>Section</b>");
  });

  it("converts H3+ to bold with # prefix", () => {
    // TUI applies the same style to prefix + content, so whole line is bold
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>### Sub</b>");
    expect(markdownToTelegramHtml("#### Deep")).toBe("<b>#### Deep</b>");
  });

  // ── Paragraphs / Inline ──

  it("converts inline formatting in paragraphs", () => {
    expect(markdownToTelegramHtml("**bold** text")).toBe("<b>bold</b> text");
  });

  it("preserves newlines between paragraphs", () => {
    // Paragraphs are separated by single newlines in rendered output
    expect(markdownToTelegramHtml("line1\n\nline2")).toBe("line1\nline2");
  });

  // ── Code Blocks ──

  it("converts code blocks to pre with backtick borders", () => {
    const input = "```\nconst x = 1;\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  it("includes language tag in code block borders", () => {
    const input = "```ts\nconst x: number = 1;\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("```ts");
    expect(result).toContain("const x: number = 1;");
  });

  it("escapes HTML in code blocks", () => {
    const input = "```\n<div>hello</div>\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("&lt;div&gt;");
  });

  it("handles unclosed code block at end", () => {
    const input = "```\nsome code";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("some code");
    expect(result).toContain("```");
  });

  // ── Tables (box-drawing) ──

  it("renders tables with box-drawing chars in pre", () => {
    const result = markdownToTelegramHtml(
      "| Name | Value |\n| --- | --- |\n| Speed | Fast |\n| Memory | Low |",
    );
    expect(result).toContain("<pre>");
    expect(result).toContain("┌─");
    expect(result).toContain("─┬─");
    expect(result).toContain("─┐");
    expect(result).toContain("│");
    expect(result).toContain("├─");
    expect(result).toContain("─┼─");
    expect(result).toContain("─┤");
    expect(result).toContain("└─");
    expect(result).toContain("─┴─");
    expect(result).toContain("─┘");
    expect(result).toContain("<b>Name</b>");
    expect(result).toContain("Speed");
    expect(result).toContain("Memory");
  });

  it("renders table header in bold", () => {
    const result = markdownToTelegramHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(result).toContain("<b>A</b>");
    expect(result).toContain("<b>B</b>");
  });

  it("handles wide characters in tables", () => {
    const result = markdownToTelegramHtml("| Name | Age |\n| --- | --- |\n| Zhang | 28 |");
    expect(result).toContain("┌─");
    expect(result).toContain("Zhang");
  });

  it("handles single-column table", () => {
    const result = markdownToTelegramHtml("| X |\n| --- |\n| 1 |");
    expect(result).toContain("┌─");
    expect(result).toContain("<b>X</b>");
    expect(result).toContain("1");
  });

  // ── Lists ──

  it("converts ordered lists with numbering", () => {
    expect(markdownToTelegramHtml("1. First\n2. Second")).toBe("1. First\n2. Second");
  });

  it("converts unordered lists with dash bullets", () => {
    expect(markdownToTelegramHtml("- Alpha\n- Beta")).toBe("- Alpha\n- Beta");
  });

  it("handles nested lists with indentation", () => {
    const result = markdownToTelegramHtml("- Outer\n  - Inner");
    expect(result).toBe("- Outer\n    - Inner");
  });

  it("renders task list with checkboxes (no HTML <input> leak)", () => {
    const result = markdownToTelegramHtml("- [x] Done\n- [ ] Todo");
    expect(result).not.toContain("<input");
    expect(result).toContain("[x]");
    expect(result).toContain("[ ]");
    expect(result).toContain("Done");
    expect(result).toContain("Todo");
  });

  // ── Blockquotes ──

  it("wraps blockquotes with italic", () => {
    const result = markdownToTelegramHtml("> A wise quote");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("<i>");
    expect(result).toContain("A wise quote");
    expect(result).toContain("</i>");
    expect(result).toContain("</blockquote>");
  });

  // ── Horizontal Rule ──

  it("renders horizontal rule as pre dashes", () => {
    const result = markdownToTelegramHtml("---");
    expect(result).toContain("<pre>");
    expect(result).toContain("─");
    expect(result).toContain("</pre>");
  });

  // ── Mixed Content ──

  it("handles mixed heading + paragraph + table", () => {
    const md = "# Report\n\nStats:\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b><u>Report</u></b>");
    expect(result).toContain("Stats:");
    expect(result).toContain("┌─");
  });
});
