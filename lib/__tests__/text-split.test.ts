import { describe, expect, it } from "vitest";
import { stripHtml, takeUtf8Prefix, splitTelegramText, splitTelegramHtml } from "../text-split.ts";

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    expect(stripHtml("<b>hello</b>")).toBe("hello");
  });

  it("converts <br> to newline", () => {
    expect(stripHtml("a<br>b")).toBe("a\nb");
    expect(stripHtml("a<br/>b")).toBe("a\nb");
    expect(stripHtml("a<br />b")).toBe("a\nb");
  });

  it("converts </p> to newline", () => {
    expect(stripHtml("a</p>b")).toBe("a\nb");
  });

  it("decodes HTML entities", () => {
    expect(stripHtml("&lt;tag&gt;")).toBe("<tag>");
    expect(stripHtml("&amp;")).toBe("&");
  });

  it("handles mixed content", () => {
    expect(stripHtml("<p>hello &amp; <b>world</b></p>")).toBe("hello & world\n");
  });
});

describe("takeUtf8Prefix", () => {
  it("returns full string when under limit", () => {
    const result = takeUtf8Prefix("hello", 100);
    expect(result).toEqual({ head: "hello", tail: "" });
  });

  it("splits at UTF-8 boundary for ASCII", () => {
    const result = takeUtf8Prefix("abcdefghij", 5);
    expect(result).toEqual({ head: "abcde", tail: "fghij" });
  });

  it("does not split multi-byte UTF-8 characters", () => {
    // é is 2 bytes in UTF-8
    const result = takeUtf8Prefix("aébc", 2);
    expect(result.head).toBe("a");
    expect(result.tail).toBe("ébc");
  });

  it("handles emoji (4-byte UTF-8)", () => {
    // 🎉 is 4 bytes
    const result = takeUtf8Prefix("🎉abc", 4);
    expect(result.head).toBe("🎉");
    expect(result.tail).toBe("abc");
  });

  it("returns empty head when first char exceeds limit", () => {
    const result = takeUtf8Prefix("🎉abc", 1);
    expect(result.head).toBe("");
    expect(result.tail).toBe("🎉abc");
  });
});

describe("splitTelegramText", () => {
  it("returns single chunk for short text", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for text exactly at limit", () => {
    const text = "a".repeat(4096);
    expect(splitTelegramText(text)).toEqual([text]);
  });

  it("splits at newline when possible", () => {
    // Create text > 4096 bytes with a newline in the safe zone
    const prefix = "a".repeat(3000);
    const suffix = "b".repeat(2000);
    const text = `${prefix}\n${suffix}`;
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Reassembly should equal original
    expect(chunks.join("")).toBe(text);
  });

  it("reassembles to original text", () => {
    const text = "x".repeat(8000);
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
  });

  it("handles multi-byte characters safely", () => {
    const text = "é".repeat(3000); // 6000 bytes > 4096
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(4096);
    }
  });
});

describe("splitTelegramHtml", () => {
  const MAX = 200; // small limit to force splitting in tests

  it("returns single chunk when under limit", () => {
    expect(splitTelegramHtml("hello", MAX)).toEqual(["hello"]);
  });

  it("never splits inside a <pre> block — every chunk has balanced <pre>/</pre>", () => {
    // One huge <pre> that must split into multiple COMPLETE <pre> chunks.
    const code = "line\n".repeat(60).trimEnd(); // ~300 bytes
    const html = `<p>intro</p>

<pre>${code}</pre>

<p>outro</p>`.replace(/<p>|\u003c\/p>/g, ""); // plain paragraphs
    const chunks = splitTelegramHtml(`intro\n\n<pre>${code}</pre>\n\noutro`, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre>/g) || []).length;
      const closes = (chunk.match(/<\/pre>/g) || []).length;
      expect(opens).toBe(closes);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(MAX);
    }
  });

  it("keeps <blockquote> balanced across splits", () => {
    const inner = "word ".repeat(80).trim();
    const html = `<blockquote>${inner}</blockquote>`;
    const chunks = splitTelegramHtml(html, MAX);
    for (const chunk of chunks) {
      expect((chunk.match(/<blockquote/g) || []).length)
        .toBe((chunk.match(/<\/blockquote>/g) || []).length);
    }
  });

  it("splits card table between rows and repeats the header", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<b>row${i}</b>  value${i}`).join("\n");
    const html = `<b>H1</b>  <b>H2</b>\n──\n${rows}`;
    const chunks = splitTelegramHtml(html, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must carry the header + separator (table stays readable).
    for (const chunk of chunks) {
      expect(chunk).toContain("<b>H1</b>");
      expect(chunk).toContain("──");
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(MAX);
    }
    // All rows preserved across chunks
    const joined = chunks.join("\n");
    for (let i = 0; i < 30; i++) expect(joined).toContain(`row${i}`);
  });

  it("preserves all content across chunks (reassembly invariant)", () => {
    const html = [
      "para one with some words here",
      "<blockquote>a quoted block of text that is fairly long so it will need splitting</blockquote>",
      "<pre>line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8</pre>",
      "final paragraph tail",
    ].join("\n\n");
    const chunks = splitTelegramHtml(html, MAX);
    // Every line of content appears somewhere
    for (const needle of ["para one", "quoted block", "line1", "line8", "final paragraph"]) {
      expect(chunks.some((c) => c.includes(needle))).toBe(true);
    }
  });
});