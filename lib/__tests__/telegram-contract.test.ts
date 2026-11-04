import { describe, expect, it } from "vitest";
// The contract checker is plain ESM under scripts/e2e; the test imports it directly.
import { validateTelegramCall } from "../../scripts/e2e/telegram-contract.mjs";

function html(text: string): string[] {
  return validateTelegramCall({ method: "sendMessage", body: { text, parse_mode: "HTML" } });
}

describe("telegram-contract HTML rules for <pre>", () => {
  it("accepts <code> as the direct child of <pre>, with or without a language class", () => {
    expect(html('<pre><code class="language-typescript">const a = 1;</code></pre>')).toEqual([]);
    expect(html("<pre><code>plain</code></pre>")).toEqual([]);
  });

  it("rejects any other tag nested inside <pre>", () => {
    expect(html("<pre><b>x</b></pre>").join("\n")).toMatch(/<b> nested inside <pre>/);
    expect(html("<pre><a href=\"https://example.com\">x</a></pre>").join("\n")).toMatch(/<a> nested inside <pre>/);
  });

  it("rejects <code> inside <code> and anything nested inside the inner code", () => {
    expect(html("<pre><code><code>x</code></code></pre>").join("\n")).toMatch(/<code> nested inside <code>/);
    expect(html("<pre><code><b>x</b></code></pre>").join("\n")).toMatch(/<b> nested inside <code>/);
  });

  it("rejects <code> nested inside pre through another element", () => {
    expect(html("<pre><blockquote><code>x</code></blockquote></pre>").join("\n")).toMatch(/nested inside <pre>/);
  });
});
