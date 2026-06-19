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

  it("converts H1 to bold (no underline, no # prefix)", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
  });

  it("converts H2 to bold", () => {
    expect(markdownToTelegramHtml("## Section")).toBe("<b>Section</b>");
  });

  it("converts H3+ to bold with no # prefix", () => {
    // Uniform <b> + blank line; # prefix is mobile noise and is dropped.
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
    expect(markdownToTelegramHtml("#### Deep")).toBe("<b>Deep</b>");
  });

  // ── Paragraphs / Inline ──

  it("converts inline formatting in paragraphs", () => {
    expect(markdownToTelegramHtml("**bold** text")).toBe("<b>bold</b> text");
  });

  it("preserves newlines between paragraphs", () => {
    // Paragraphs are separated by a blank line for mobile readability
    expect(markdownToTelegramHtml("line1\n\nline2")).toBe("line1\n\nline2");
  });

  // ── Code Blocks ──

  it("converts code blocks to pre with language class", () => {
    const input = "```\nconst x = 1;\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre><code>");
    // No literal ``` fences (visual noise + wasted bytes)
    expect(result).not.toContain("```");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  it("includes language class on code blocks", () => {
    const input = "```ts\nconst x: number = 1;\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('class="language-ts"');
    expect(result).toContain("const x: number = 1;");
    // Language must NOT appear as a literal ```ts fence text
    expect(result).not.toContain("```ts");
  });

  it("sanitizes code-block language to Telegram's allowed charset", () => {
    // Telegram validates class="language-..." against [a-zA-Z][a-zA-Z0-9_-]*
    const input = "```C++\nint main(){}\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('class="language-c"');
    expect(result).not.toContain("++");
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
    // No literal ``` fences emitted
    expect(result).not.toContain("```");
  });

  // ── Tables (PR-1c: three mobile-first strategies) ──

  it("box-drawing for narrow 2-col all-ASCII short table", () => {
    const result = markdownToTelegramHtml(
      "| Name | Value |\n| --- | --- |\n| Speed | Fast |\n| Memory | Low |",
    );
    // Box grid in <pre>
    expect(result).toContain("<pre>");
    expect(result).toContain("┌─");
    expect(result).toContain("─┬─");
    expect(result).toContain("├─");
    expect(result).toContain("─┼─");
    expect(result).toContain("└─");
    expect(result).toContain("─┴─");
    expect(result).toContain("Speed");
    expect(result).toContain("Memory");
    // CRITICAL: <b> must NOT appear inside <pre> — Telegram rejects
    // <pre><b>...</b></pre> and would silently fall back to plain text.
    expect(result).not.toContain("<b>");
  });

  it("card-style for 3-column table (default strategy)", () => {
    const result = markdownToTelegramHtml(
      "| 命令 | 说明 | 备注 |\n| --- | --- | --- |\n| ls | 列目录 | 常用 |\n| ps | 进程 | 调试 |",
    );
    // No <pre> (card wraps naturally); header bold, first column bold
    expect(result).not.toContain("<pre>");
    expect(result).toContain("<b>命令</b>");
    expect(result).toContain("<b>ls</b>");
    expect(result).toContain("<b>ps</b>");
    // Header / row separator
    expect(result).toContain("──");
    expect(result).toContain("列目录");
    expect(result).toContain("进程");
  });

  it("card-style bolds header even for plain ASCII 3-col table", () => {
    const result = markdownToTelegramHtml("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    expect(result).toContain("<b>A</b>");
    expect(result).toContain("<b>B</b>");
    expect(result).toContain("<b>C</b>");
    expect(result).toContain("<b>1</b>");
  });

  it("transpose for wide table (>4 columns)", () => {
    const result = markdownToTelegramHtml(
      "| id | name | type | size | owner | perm |\n| --- | --- | --- | --- | --- | --- |\n| 1 | foo | file | 10 | me | rw |",
    );
    // Transposed: each row becomes a block of `label: value` lines, labels
    // bolded, blocks separated by a blank line. No orphaned title, no indent.
    expect(result).not.toContain("<pre>");
    // First column keeps its label (no bare orphaned value)
    expect(result).toContain("<b>id</b>: 1");
    expect(result).toContain("<b>name</b>: foo");
    expect(result).toContain("<b>owner</b>: me");
    expect(result).toContain("<b>perm</b>: rw");
  });

  it("single-column table renders as card", () => {
    const result = markdownToTelegramHtml("| X |\n| --- |\n| 1 |");
    expect(result).toContain("<b>X</b>");
    expect(result).toContain("<b>1</b>");
    // No box-drawing for a single column
    expect(result).not.toContain("┌─");
  });

  it("long table is NOT folded — all rows visible", () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| k${i} | v${i} |`).join("\n");
    const md = `| Key | Val |\n| --- | --- |\n${rows}`;
    const result = markdownToTelegramHtml(md);
    // No expandable blockquote for non-tool content (completeness rule)
    expect(result).not.toContain("expandable");
    // Every row's first column is present
    for (let i = 0; i < 15; i++) {
      expect(result).toContain(`k${i}`);
      expect(result).toContain(`v${i}`);
    }
  });

  // ── Pseudo-tables (aligned pipe text with no `| --- |` separator) ──

  it("wraps a pseudo-table (no separator row) in <pre> to preserve alignment", () => {
    // Looks like a table but lacks the | --- | separator — marked would
    // otherwise tokenize it as a paragraph and column alignment is lost.
    const md = "| Name | Age |\n| Alice | 30 |\n| Bob | 25 |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    // Pipes preserved verbatim inside the monospace block
    expect(result).toContain("|");
  });

  it("does NOT wrap a real markdown table as pseudo-table", () => {
    // Real table (with separator) must go through the table renderer, not be
    // re-wrapped as a code block. Use 3 columns so it routes to card (bold hdr).
    const md = "| H1 | H2 | H3 |\n| --- | --- | --- |\n| a | b | c |";
    const result = markdownToTelegramHtml(md);
    expect(result).not.toContain("<pre><code>");
    expect(result).toContain("<b>H1</b>");
  });

  it("does not double-wrap pseudo-tables already inside a code fence", () => {
    const md = "```\n| a | b |\n| 1 | 2 |\n```";
    const result = markdownToTelegramHtml(md);
    // Single <pre><code> block, no nested wrapping
    const preCount = (result.match(/<pre><code/g) || []).length;
    expect(preCount).toBe(1);
  });

  it("does not wrap a single line containing pipes", () => {
    // A sentence with pipes is not a table.
    const md = "see a | b | c for details";
    const result = markdownToTelegramHtml(md);
    expect(result).not.toContain("<pre>");
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

  it("caps indent and uses › bullet for depth ≥3 (mobile width)", () => {
    const result = markdownToTelegramHtml("- A\n  - B\n    - C\n      - D");
    // Depth 1 & 2 unchanged (- bullet)
    expect(result).toContain("- A");
    expect(result).toContain("  - B");
    // Depth ≥3 switches to › and doesn't keep growing 2 cols/level
    expect(result).toContain("› C");
    expect(result).toContain("› D");
    // No line should be indented past ~10 cols (was ~12 for D3, ~16 for D4)
    for (const line of result.split("\n")) {
      const leading = line.match(/^ */)?.[0].length ?? 0;
      expect(leading).toBeLessThanOrEqual(10);
    }
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

  it("renders horizontal rule as slim fullwidth dashes", () => {
    const result = markdownToTelegramHtml("---");
    expect(result).toContain("━━━");
    // No heavy <pre> block
    expect(result).not.toContain("<pre>");
  });

  // ── Mixed Content ──

  it("handles mixed heading + paragraph + table", () => {
    const md = "# Report\n\nStats:\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b>Report</b>");
    expect(result).toContain("Stats:");
    expect(result).toContain("┌─");
  });

  // ── Links / HTML / line breaks (PR-1a: previously fell through to marked's
  // default renderers, whose `title=` attr / `<br>` / raw HTML / unescaped
  // `&` in href are rejected by Telegram and force a whole-message plain-text
  // fallback). ──

  it("renders links as <a> without a title attribute", () => {
    const result = markdownToTelegramHtml("see [docs](https://example.com)");
    expect(result).toContain('<a href="https://example.com">docs</a>');
    // `title=` is unsupported by Telegram and must never leak
    expect(result).not.toContain("title=");
  });

  it("escapes & in link hrefs", () => {
    const result = markdownToTelegramHtml("[search](https://example.com?a=1&b=2)");
    expect(result).toContain('href="https://example.com?a=1&amp;b=2"');
  });

  it("renders hard line breaks as \n, not <br>", () => {
    // Two trailing spaces + newline = hard break in markdown
    const result = markdownToTelegramHtml("line one  \nline two");
    expect(result).toContain("line one\nline two");
    expect(result).not.toContain("<br");
  });

  it("escapes raw HTML instead of passing it through", () => {
    const result = markdownToTelegramHtml("text <div>boom</div> end");
    expect(result).toContain("&lt;div&gt;");
    expect(result).not.toContain("<div>");
  });

  it("renders markdown images as clickable links", () => {
    const result = markdownToTelegramHtml("![logo](https://example.com/logo.png)");
    expect(result).toContain('<a href="https://example.com/logo.png">');
    expect(result).toContain("logo");
    expect(result).toContain("🖼");
  });

  it("does not italic-wrap a blockquote that starts with <b>", () => {
    // <blockquote><i>...<b>...</b>...</i></blockquote> is rejected by Telegram;
    // content starting with <b> must skip the <i> wrapper.
    const result = markdownToTelegramHtml("> **bold first**");
    expect(result).toContain("<blockquote><b>bold first</b></blockquote>");
    // No wrapping <i> around the bold content
    expect(result).not.toMatch(/<blockquote><i>/);
  });
});
