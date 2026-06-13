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
  it("converts # headings to <b>", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
  });

  it("converts ## headings to <b>", () => {
    expect(markdownToTelegramHtml("## Section")).toBe("<b>Section</b>");
  });

  it("converts code blocks to <pre>", () => {
    const input = "```\nconst x = 1;\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</pre>");
  });

  it("converts inline formatting in paragraphs", () => {
    expect(markdownToTelegramHtml("**bold** text")).toBe("<b>bold</b> text");
  });

  it("preserves newlines between paragraphs", () => {
    expect(markdownToTelegramHtml("line1\nline2")).toBe("line1\nline2");
  });

  it("escapes HTML in code blocks", () => {
    const input = "```\n<div>hello</div>\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("&lt;div&gt;");
  });

  it("converts tables to aligned monospace pre block", () => {
    const result = markdownToTelegramHtml("| Name | Value |\n| --- | --- |\n| Speed | Fast |\n| Memory | Low |");
    expect(result).toContain("<pre>");
    expect(result).toContain("Name  "); // padded for alignment
    expect(result).toContain("-+-");
    expect(result).toContain("Speed");
    expect(result).toContain("Fast");
    expect(result).toContain("Memory");
    expect(result).toContain("Low");
  });

  it("converts ordered and unordered lists to plain text lines", () => {
    expect(markdownToTelegramHtml("1. First\n2. Second\n\n- Alpha\n- Beta")).toBe("1. First\n2. Second\n\n• Alpha\n• Beta");
  });

  it("handles unclosed code block at end", () => {
    const input = "```\nsome code";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("some code");
  });
});
