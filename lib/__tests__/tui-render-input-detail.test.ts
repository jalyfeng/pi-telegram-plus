import { describe, expect, it } from "vitest";
import { renderDialog, type RenderContext } from "../tui/render-telegram.ts";
import type { DialogModel } from "../tui/model.ts";

const ctx: RenderContext = { sessionId: "s1", generation: 1 };
const LINK = `https://claude.ai/oauth/authorize?code=true&client_id=client-1&scope=${"user%3Afull+".repeat(50)}`;
/** The HTML form of the link: `&` is escaped, the rest is the same text. */
const LINK_HTML = LINK.replace(/&/g, "&amp;");

function inputModel(detail: string): Extract<DialogModel, { kind: "input" }> {
  return { kind: "input", title: "Login to Anthropic", detail, secret: true };
}

describe("renderInput keeps a detail's link whole (P2-45)", () => {
  it("renders a long link whole, as plain text outside any <pre>", () => {
    const rendered = renderDialog(inputModel(`Complete login in your browser.\n${LINK}\nPaste the code:`), ctx);
    expect(rendered.text).toContain(LINK_HTML);
    expect(rendered.text).not.toContain("<pre>");
    expect(rendered.text).toContain("Complete login in your browser.");
    expect(rendered.text).toContain("Paste the code:");
  });

  it("drops prose lines from the end before it cuts a link, and keeps the link whole", () => {
    const intro = `Intro ${"x".repeat(500)}`;
    const tail = `Tail ${"y".repeat(500)}`;
    const rendered = renderDialog(inputModel(`${intro}\n${LINK}\n${tail}`), ctx);
    expect(rendered.text).toContain(LINK_HTML);
    expect(rendered.text).not.toContain("Tail ");
  });

  it("keeps the short lines that fit beside the link", () => {
    const rendered = renderDialog(inputModel(`Complete login in your browser.\n${LINK}\nPaste the code:`), ctx);
    expect(rendered.text).toContain("Complete login in your browser.");
    expect(rendered.text).toContain("Paste the code:");
  });

  it("keeps the whole message under Telegram's 4096-byte limit", () => {
    const rendered = renderDialog(inputModel(`${"z".repeat(3000)}\n${LINK}`), ctx);
    expect(rendered.text).toContain(LINK_HTML);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(4096);
  });
});
