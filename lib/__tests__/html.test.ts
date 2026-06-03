import { describe, expect, it } from "vitest";
import { escapeHtml } from "../html.ts";

describe("escapeHtml", () => {
  it("escapes &, <, >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("escapes multiple ampersands", () => {
    expect(escapeHtml("a=1&b=2&c=3")).toBe("a=1&amp;b=2&amp;c=3");
  });

  it("escapes all & before < and >", () => {
    // Order matters: & must be escaped first
    expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("handles already-escaped entities", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});