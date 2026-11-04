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
import { drainDesktopLaunches } from "./_desktop-guard.ts";
import { LoginDialogComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/login-dialog.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { renderDialog } from "../tui/render-telegram.ts";
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
    expect(model.detail).toBe("Paste your API key");
    expect(model.placeholder).toBe("e.g., sk-...");
  });

  it("models the OAuth URL step as closable info carrying the link", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showAuth("https://acme.example/auth", "Open this URL to sign in");
    expect(drainDesktopLaunches()).toHaveLength(1); // the browser open is expected here, and nothing started
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

  it("drops the key hint that stays behind the echoed answer once the prompt is submitted", () => {
    const { dialog, ctx } = loginHarness();
    const answer = dialog.showPrompt("Paste your API key");
    expect(piLoginAdapter.act(dialog, { type: "submit", text: "sk-test-123" }, ctx)).toBe(true);
    void answer;
    // The input is gone; the page is the message plus the key hint pi left behind the echo.
    const after = piLoginAdapter.read(dialog, ctx);
    if (after.kind !== "info") throw new Error(`expected an info model, got ${after.kind}`);
    expect(after.text).toBe("Paste your API key");
    expect(JSON.stringify(after)).not.toContain("to submit");
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
    expect(model.detail).toBe("Paste your API key");
    expect(model.placeholder).toBeUndefined();
  });

  it("keeps the example line, drops the key hint, under a prompt with a placeholder", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showPrompt("Paste your API key", "sk-...");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.detail).toBe("Paste your API key");
    expect(model.placeholder).toBe("e.g., sk-...");
  });

  it("drops the key hint under a manual input as well", () => {
    const { dialog, ctx } = loginHarness();
    void dialog.showManualInput("Paste the redirect URL");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.detail).toBe("Paste the redirect URL");
    expect(model.placeholder).toBeUndefined();
  });

  it("keeps every body line of an information page and drops only its close hint", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showInfo("Sign-in finished.", [{ label: "Docs", url: "https://acme.example/docs" }], true);
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    expect(model.text.split("\n")).toEqual(["Sign-in finished.", "Docs: https://acme.example/docs"]);
  });

  it("drops the cancel hint from a waiting page, keeping the message", () => {
    const { dialog, ctx } = loginHarness();
    // No input component in the content area: the only hint is the Text pi adds after the message.
    dialog.showWaiting("Waiting for the browser...");
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    expect(model.text).toBe("Waiting for the browser...");
    expect(JSON.stringify(model)).not.toContain("to cancel");
  });

  it("drops the close hint from an information page without links", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showInfo("Sign-in finished.", [], true);
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    expect(model.text).toBe("Sign-in finished.");
  });

  it("keeps body text that only shares words with a hint", () => {
    const { dialog, ctx } = loginHarness();
    // Exact match against the host's own hint string, not a word or substring check.
    dialog.showInfo("Use the window button to close it, then continue to the next step.", [], false);
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    expect(model.text).toBe("Use the window button to close it, then continue to the next step.");
  });
});

describe("piLoginAdapter read: the OAuth link step keeps its link and its lines", () => {
  const url = `https://claude.ai/oauth/authorize?code=true&client_id=client-1&scope=${"user%3Afull+".repeat(50)}`;
  const instructions = "Complete login in your browser, then copy the code Anthropic shows and paste it here.";
  const prompt = "Paste the code Anthropic shows after you sign in:";

  function oauthCodeStep() {
    const harness = loginHarness();
    harness.dialog.showAuth(url, instructions);
    drainDesktopLaunches(); // the browser open is expected here; the guard started nothing
    void harness.dialog.showManualInput(prompt);
    return harness;
  }

  it("puts the whole link and both lines in the detail, with no placeholder", () => {
    const { dialog, ctx } = oauthCodeStep();
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.secret).toBe(true);
    expect(model.detail).toContain(url);
    expect(model.detail).toContain(instructions);
    expect(model.detail).toContain(prompt);
    expect(model.placeholder).toBeUndefined();
  });

  it("leaves out the terminal click and copy hint that rides on the link", () => {
    const { dialog, ctx } = oauthCodeStep();
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);
    expect(model.detail).not.toMatch(/click to open|to copy/i);
  });

  it("renders the link whole and as plain text, not inside a <pre>", () => {
    const { dialog, ctx } = oauthCodeStep();
    const rendered = renderDialog(piLoginAdapter.read(dialog, ctx), { sessionId: "s1", generation: 1 });
    expect(rendered.text).toContain(url.replace(/&/g, "&amp;"));
    expect(rendered.text).not.toContain("<pre>");
    expect(rendered.text).toContain(instructions);
    expect(rendered.text).toContain(prompt);
  });
});

describe("piLoginAdapter read: the device-code page keeps its link and code, not the terminal click hint", () => {
  it("drops the Cmd/Ctrl+click line under the link and keeps the link and the code", () => {
    const { dialog, ctx } = loginHarness();
    dialog.showDeviceCode({ verificationUri: "https://github.com/login/device", userCode: "MOCK-1234", expiresIn: 900 } as never);
    const model = piLoginAdapter.read(dialog, ctx);
    if (model.kind !== "info") throw new Error(`expected an info model, got ${model.kind}`);
    expect(model.text).toContain("https://github.com/login/device");
    expect(model.text).toContain("Enter code: MOCK-1234");
    expect(model.text).not.toMatch(/click to open/i);
  });
});

describe("the desktop guard: showAuth asks for a browser but never starts one", () => {
  it("records the open call and starts no process", () => {
    const { dialog } = loginHarness();
    const target = "https://acme.example/auth?state=guard";
    dialog.showAuth(target, "Open this URL to sign in");
    expect(drainDesktopLaunches()).toEqual([{ api: "spawn", program: "open", args: ["open", [target], expect.any(Object)] }]);
  });
});
