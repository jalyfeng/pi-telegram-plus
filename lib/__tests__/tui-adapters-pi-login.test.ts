/**
 * Adapter P5: pi's `/login` (`LoginDialogComponent`, §4.6.4). The whole file
 * drives the real pi 1.4.0 component (imported from its dist path, theme
 * initialised headlessly) through `read`/`act` with keys delivered to the
 * component's own `handleInput`, like the Broker: a host upgrade that renames
 * `contentContainer`/`inputResolver` or re-points a key fails here. The
 * secret rule is the point - after submit the component keeps a
 * "> <value>" line in its children, and no model may carry it out.
 */
import { describe, expect, it } from "vitest";
import { LoginDialogComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/login-dialog.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { piLoginAdapter } from "../tui/adapters/pi-login.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext } from "../tui/model.ts";

/** pi's theme is a module singleton; the system theme works without a TTY. */
initTheme();

/** pi's `private` is compile-time only; tests reach the runtime fields. */
const fields = (component: object): Record<string, unknown> => component as unknown as Record<string, unknown>;

function loginHarness() {
  const completions: { ok: boolean; message?: string }[] = [];
  const tui = { requestRender: () => {} };
  const dialog = new LoginDialogComponent(
    tui as never,
    "acme",
    (ok: boolean, message?: string) => completions.push({ ok, message }),
  );
  const ctx: AdapterContext = { host: "pi", sendKey: (name) => sendKeyTo(dialog, name), requestRender: () => {} };
  return { dialog, ctx, completions };
}

/** Every string `text` currently sitting in the content area, secrets included. */
function contentTexts(dialog: LoginDialogComponent): string {
  const area = fields(dialog).contentContainer;
  if (!area || typeof area !== "object") return "";
  const children = fields(area).children;
  if (!Array.isArray(children)) return "";
  return children
    .map((child) => (child && typeof child === "object" ? fields(child) : {}))
    .map((record) => (typeof record.text === "string" ? record.text : ""))
    .join("\n");
}

describe("piLoginAdapter detect", () => {
  it("claims LoginDialogComponent on the pi host only", () => {
    const { dialog, ctx } = loginHarness();
    expect(piLoginAdapter.detect(dialog, ctx)).toBe(true);
    expect(piLoginAdapter.detect(dialog, { ...ctx, host: "omp" })).toBe(false);
    // Same shape, wrong class: constructor whitelist, not duck typing.
    expect(piLoginAdapter.detect({ contentContainer: { children: [] } }, ctx)).toBe(false);
  });

  it("wins the registry pick on pi", () => {
    const { dialog, ctx } = loginHarness();
    expect(pickAdapter(dialog, ctx)?.id).toBe("pi-login");
  });
});

describe("piLoginAdapter read", () => {
  it("models a waiting prompt as an input and always as a secret", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showPrompt("Paste your API key", "sk-...");
    const model = piLoginAdapter.read(dialog, ctx);
    expect(model.kind).toBe("input");
    if (model.kind !== "input") return;
    expect(model.secret).toBe(true);
    expect(model.title).toBe("Login to acme");
    expect(model.placeholder).toContain("Paste your API key");
  });

  it("models the OAuth URL step as closable info carrying the link", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showAuth("https://acme.example/auth", "Open this URL to sign in");
    const model = piLoginAdapter.read(dialog, ctx);
    expect(model.kind).toBe("info");
    if (model.kind !== "info") return;
    expect(model.closable).toBe(true);
    expect(model.title).toBe("Login to acme");
    expect(model.text).toContain("https://acme.example/auth");
    expect(model.text).toContain("Open this URL to sign in");
  });
});

describe("piLoginAdapter act", () => {
  it("types the answer, submits it to the host, and keeps the echoed secret out of every model", async () => {
    const { dialog, ctx } = loginHarness();
    const answer = dialog.showPrompt("Paste your API key");
    const before = piLoginAdapter.read(dialog, ctx);
    expect(before.kind).toBe("input");

    expect(piLoginAdapter.act(dialog, { type: "submit", text: "sk-test-123" }, ctx)).toBe(true);
    // The host's own promise resolved with the typed value.
    expect(await answer).toBe("sk-test-123");
    // The component now echoes "> sk-test-123" in place of the input...
    expect(contentTexts(dialog)).toContain("> sk-test-123");
    // ...and neither the pre-submit nor the post-submit model may leak it.
    const after = piLoginAdapter.read(dialog, ctx);
    expect(after.kind).toBe("info");
    expect(JSON.stringify(before)).not.toContain("sk-test-123");
    expect(JSON.stringify(after)).not.toContain("sk-test-123");
  });

  it("refuses to submit while nothing waits for input", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showWaiting("Waiting for the browser...");
    expect(piLoginAdapter.act(dialog, { type: "submit", text: "sk-test-123" }, ctx)).toBe(false);
    expect(piLoginAdapter.act(dialog, { type: "submit" }, ctx)).toBe(false);
    expect(piLoginAdapter.act(dialog, { type: "choose", key: "0:x" }, ctx)).toBe(false);
    // Nothing was typed into the idle dialog.
    // pi-tui's `Input` holds whatever was typed; the test reaches the runtime field.
    const input = fields(dialog).input as { getValue(): string };
    expect(input.getValue()).toBe("");
  });

  it("cancel sends esc and the component aborts the login", async () => {
    const { dialog, ctx, completions } = loginHarness();
    const answer = dialog.showPrompt("Paste your API key");
    const outcome = answer.then(() => "resolved", () => "rejected");
    expect(piLoginAdapter.act(dialog, { type: "cancel" }, ctx)).toBe(true);
    expect(await outcome).toBe("rejected");
    expect(completions).toEqual([{ ok: false, message: "Login cancelled" }]);
  });
});

describe("piLoginAdapter read: terminal key hints stay off the body", () => {
  it("drops the key hint pi prints right after a prompt's input", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showPrompt("Paste your API key");
    const model = piLoginAdapter.read(dialog, ctx);
    expect(model.kind).toBe("input");
    if (model.kind !== "input") return;
    // Only the message is body; "(escape/ctrl+c to cancel ...)" is a key hint.
    expect(model.placeholder).toBe("Paste your API key");
  });

  it("keeps the example line, drops the key hint, under a prompt with a placeholder", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showPrompt("Paste your API key", "sk-...");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.placeholder).toBe("Paste your API key\ne.g., sk-...");
  });

  it("drops the key hint under a manual input as well", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showManualInput("Paste the redirect URL");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.placeholder).toBe("Paste the redirect URL");
  });

  it("keeps every line of an information page, its last line included", () => {
    const { dialog, ctx } = loginHarness();
    // No input component in the content area: nothing is skipped.
    dialog.showWaiting("Waiting for the browser...");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    const lines = model.text.split("\n");
    expect(lines[0]).toBe("Waiting for the browser...");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("to cancel");
  });
});
