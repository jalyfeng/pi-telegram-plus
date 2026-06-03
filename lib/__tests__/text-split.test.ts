import { describe, expect, it } from "vitest";
import { stripHtml, takeUtf8Prefix, splitTelegramText } from "../text-split.ts";

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