import { describe, expect, it } from "vitest";
import { renderDialog, type RenderContext } from "../tui/render-telegram.ts";
import type { DialogModel } from "../tui/model.ts";
import { SecretStore } from "../tui/secrets.ts";

const SECRET = "sk-a&b<c>d-12345";
const CHAT = "42:main";

function storeWithSecret(): SecretStore {
  const store = new SecretStore();
  store.remember(CHAT, "flow-1", SECRET);
  return store;
}

function ctx(store: SecretStore): RenderContext {
  return { sessionId: "s1", generation: 7, redact: (text) => store.redact(CHAT, text) };
}

const selectModel: DialogModel = {
  kind: "select",
  title: `Choose the key to use (${SECRET})`,
  items: [
    { key: `key-${SECRET}`, label: `Use ${SECRET}`, description: `Saved ${SECRET}` },
    { key: "other", label: "Do not use" },
  ],
  total: 2,
};

/** A leaked `&`/`<` would break Telegram's HTML parse: no dangling entities, tags balanced. */
function expectHtmlIntact(text: string): void {
  expect(text).not.toMatch(/&(amp|lt|gt|#\d+)[^;]/);
  expect(text.match(/<b>/g)?.length ?? 0).toBe(text.match(/<\/b>/g)?.length ?? 0);
  expect(text.match(/<pre>/g)?.length ?? 0).toBe(text.match(/<\/pre>/g)?.length ?? 0);
}

describe("dialog rendering redacts secrets before HTML (§4.7.4)", () => {
  it("redacts the body and every button label of a select dialog", () => {
    const rendered = renderDialog(selectModel, ctx(storeWithSecret()));

    expect(rendered.text).not.toContain(SECRET);
    expect(rendered.text).toContain("***");
    expectHtmlIntact(rendered.text);

    const labels = rendered.rows.flat().map((button) => button.text);
    expect(labels.some((label) => label.includes("***"))).toBe(true);
    for (const label of labels) expect(label).not.toContain(SECRET);
  });

  it("keeps the key map resolvable against the live model", () => {
    const rendered = renderDialog(selectModel, ctx(storeWithSecret()));

    // Labels are redacted, identity is not: the Broker looks these keys up in
    // the un-redacted model, so a `***` here would silently kill the button.
    expect(rendered.keyMap.get("0.0")).toBe(`key-${SECRET}`);
    expect(rendered.keyMap.get("0.1")).toBe("other");
  });

  it("redacts an input placeholder before it is escaped", () => {
    const model: DialogModel = {
      kind: "input",
      title: "Enter API key",
      placeholder: `Current value: ${SECRET}`,
      secret: true,
    };

    const rendered = renderDialog(model, ctx(storeWithSecret()));

    // `***`, not just "no raw secret": the escaped form `sk-a&amp;b&lt;…` also
    // lacks the raw value, so only the substitution proves pre-escape redaction.
    expect(rendered.text).toContain("***");
    expect(rendered.text).not.toContain(SECRET);
    expect(rendered.text).not.toContain("<pre>");
    expectHtmlIntact(rendered.text);
  });

  it("leaves the model alone when the caller has no secret store", () => {
    const rendered = renderDialog(selectModel, { sessionId: "s1", generation: 7 });

    expect(rendered.text).toContain(SECRET.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  });

  it("does not track values shorter than eight characters", () => {
    const short = "sk-&<>b";
    const store = new SecretStore();
    store.remember(CHAT, "flow-2", short);
    const model: DialogModel = { kind: "info", text: `Value: ${short}`, closable: true };

    const rendered = renderDialog(model, ctx(store));

    expect(rendered.text).toContain(short.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    expect(rendered.text).not.toContain("***");
  });
});
