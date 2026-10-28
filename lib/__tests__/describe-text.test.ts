/**
 * `describedText`: OMP `describe()` text panels become Telegram HTML plus the
 * panel's own buttons (plan v8 §0.2, task N-1). These tests pin the content
 * mapping per node kind, the button extraction, and the redaction order. The
 * tree shapes follow OMP's `native/overlay.ts` (`actionButton`) and
 * `wire/src/tsp.ts`.
 */
import { describe, expect, it } from "vitest";
import { describedText } from "../tui/describe-text.ts";
import { renderDialog } from "../tui/render-telegram.ts";

const identity = (text: string): string => text;

const owner = {};

type N = Record<string, unknown>;

const text = (value: string): N => ({ k: "text", p: { text: value } });
const button = (label: string, act: string): N => ({
  k: "row",
  p: { role: "omp.btn", gap: "xs", actions: { click: act } },
  c: [text(label), { k: "kbd", p: { keys: ["escape"] } }],
});

describe("describedText content mapping", () => {
  it("converts a report-shaped tree: titled markdown body and one Close button", () => {
    const tree: N = {
      k: "col",
      c: [
        { k: "col", key: "body", c: [{ k: "card", p: { head: "Hotkeys" }, c: [{ k: "md", p: { text: "**Ctrl+C** quits" } }] }] },
        { k: "row", p: { role: "omp.actions" }, c: [{ k: "spacer", p: { grow: 1 } }, button("Close", "close")] },
      ],
    };
    const result = describedText(tree as never, identity, owner);

    expect(result.html).toContain("<b>Hotkeys</b>");
    expect(result.html).toContain("<b>Ctrl+C</b> quits");
    expect(result.title).toBe("Hotkeys");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ label: "Close", act: "close", keypath: "1/1", owner });
  });

  it("maps key/value rows to `key: value` lines", () => {
    const tree: N = {
      k: "section",
      p: { head: "Session" },
      c: [{ k: "kv", p: { items: [{ k: "Model", v: "gpt-x" }, { k: "Tokens", v: "1200" }] } }],
    };
    const result = describedText(tree as never, identity, owner);

    expect(result.html).toContain("Model: gpt-x\nTokens: 1200");
  });

  it("renders a usage meter as `label 42%`", () => {
    const tree: N = {
      k: "row",
      c: [text("Context"), { k: "meter", p: { value: 0.42, style: "bar" } }],
    };
    expect(describedText(tree as never, identity, owner).html).toBe("Context 42%");
  });

  it("uses a meter's own label text when it has one", () => {
    const tree: N = { k: "meter", p: { value: null, label: "74%" } };
    expect(describedText(tree as never, identity, owner).html).toBe("74%");
  });

  it("strips ANSI from code and ansi nodes and keeps them in <pre>", () => {
    const tree: N = {
      k: "col",
      c: [
        { k: "code", p: { text: "\u001b[31mred\u001b[0m line" } },
        { k: "ansi", p: { text: "\u001b]8;;https://x\u0007link\u001b]8;;\u0007" } },
      ],
    };
    const html = describedText(tree as never, identity, owner).html;

    expect(html).toBe("<pre>red line</pre>\n<pre>link</pre>");
  });

  it("escapes every text run once", () => {
    const tree: N = { k: "text", p: { text: "a < b & c" } };
    expect(describedText(tree as never, identity, owner).html).toBe("a &lt; b &amp; c");
  });

  it("describes an unknown kind through its children", () => {
    const tree: N = { k: "future-kind", c: [text("kept")] };
    expect(describedText(tree as never, identity, owner).html).toBe("kept");
  });

  it("applies the redactor before any text is converted or escaped", () => {
    const tree: N = {
      k: "col",
      c: [
        text("token hunter2 here"),
        { k: "md", p: { text: "**hunter2**" } },
        { k: "code", p: { text: "x=hunter2" } },
      ],
    };
    const html = describedText(tree as never, (value) => value.replace(/hunter2/g, "***"), owner).html;

    expect(html).not.toContain("hunter2");
    expect(html).toContain("token *** here");
    expect(html).toContain("<pre>x=***</pre>");
  });

  it("skips hidden nodes and spacers", () => {
    const tree: N = {
      k: "col",
      c: [text("visible"), { k: "text", p: { text: "gone", hidden: true } }, { k: "spacer", p: { size: "md" } }],
    };
    expect(describedText(tree as never, identity, owner).html).toBe("visible");
  });
});

describe("describedText actions", () => {
  it("collects every omp.btn node in tree order with its keypath and value", () => {
    const tree: N = {
      k: "col",
      c: [
        { k: "row", key: "pages", c: [{ ...button("Prev", "page"), p: { role: "omp.btn", actions: { click: "page" }, value: "1" } }] },
        button("Close", "close"),
      ],
    };
    const { actions } = describedText(tree as never, identity, owner);

    expect(actions.map((action) => [action.label, action.act, action.keypath, action.value])).toEqual([
      ["Prev", "page", "pages/0", "1"],
      ["Close", "close", "1", undefined],
    ]);
  });

  it("gives a button in a nested component its own owner and keypath", () => {
    const inner = {
      describe: () => ({ k: "col", c: [button("Done", "close")] }),
      handleNativeEvent: () => undefined,
    };
    const tree: N = { k: "col", c: [text("hi"), inner] };
    const { actions } = describedText(tree as never, identity, owner);

    expect(actions[0]).toMatchObject({ label: "Done", act: "close", keypath: "0", owner: inner });
  });
});

describe("renderDialog info model", () => {
  const CTX = { sessionId: "s1", generation: 1 };

  it("sends html text as-is: no <pre>, no second escaping", () => {
    const rendered = renderDialog({ kind: "info", title: "Report", text: "<b>x</b> &lt;", closable: false, html: true }, CTX);

    expect(rendered.text).toContain("<b>x</b> &lt;");
    expect(rendered.text).not.toContain("<pre>");
    expect(rendered.text).not.toContain("&amp;lt;");
  });

  it("keeps escaping plain text in <pre> when html is unset", () => {
    const rendered = renderDialog({ kind: "info", title: "T", text: "<b>x</b>", closable: false }, CTX);

    expect(rendered.text).toContain("<pre>&lt;b&gt;x&lt;/b&gt;</pre>");
  });

  it("renders one button per action and no extra Close when the panel closes itself", () => {
    const rendered = renderDialog(
      { kind: "info", text: "t", closable: false, html: true, actions: [{ label: "Prev", key: "0" }, { label: "Close", key: "1" }] },
      CTX,
    );
    const labels = rendered.rows.flat().map((button) => button.text);

    expect(labels).toEqual(["Prev", "Close"]);
    expect(rendered.keyMap.get("0")).toBe("0");
  });

  it("adds the renderer's Close only when closable", () => {
    const rendered = renderDialog({ kind: "info", text: "t", closable: true, html: true, actions: [{ label: "Prev", key: "0" }] }, CTX);
    expect(rendered.rows.flat().map((button) => button.text)).toEqual(["Prev", "Close"]);
  });
});
