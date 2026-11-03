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

describe("describedText redaction of raw text", () => {
  it("masks a secret containing & and < before escaping, in text, markdown and code", () => {
    const secret = "a&b<c";
    const redact = (value: string) => value.split(secret).join("***");
    const tree: N = {
      k: "col",
      c: [text(`token ${secret} here`), { k: "md", p: { text: `markdown ${secret} here` } }, { k: "code", p: { text: `x=${secret}` } }],
    };
    const html = describedText(tree as never, redact, owner).html;

    expect(html).not.toContain("a&amp;b");
    expect(html).not.toContain("&lt;c");
    expect(html).toContain("token *** here");
    expect(html).toContain("markdown *** here");
    expect(html).toContain("<pre>x=***</pre>");
  });
});

describe("renderDialog questionnaire progress", () => {
  const CTX = { sessionId: "s1", generation: 1 };
  const question = (id: string, answered: boolean) => ({
    id,
    prompt: `Pick for ${id}`,
    items: [{ key: "option:0", label: "red" }, { key: "option:1", label: "green", current: true }],
    multi: false,
    allowCustom: true,
    answered,
  });
  const buttonTexts = (rows: { text: string }[][]) => rows.flat().map((button) => button.text);

  it("a single question shows no progress line and no Question 1/1 switch button", () => {
    const rendered = renderDialog({ kind: "questionnaire", title: "Ask", questions: [question("q", false)], active: 0, canSubmit: false }, CTX);
    expect(rendered.text).not.toContain("Question 1");
    expect(rendered.text).not.toContain("▸");
    expect(buttonTexts(rendered.rows).some((text) => text.includes("Question 1/1"))).toBe(false);
    expect(buttonTexts(rendered.rows)).toContain("✏️ Type an answer");
  });

  it("two questions show the position and how many are answered", () => {
    const rendered = renderDialog({ kind: "questionnaire", title: "Ask", questions: [question("a", false), question("b", false)], active: 0, canSubmit: false }, CTX);
    expect(rendered.text).toContain("Question 1 of 2 · answered: 0");
    expect(buttonTexts(rendered.rows)).toContain("Question 1/2");
  });
});

describe("describedText lists, meters and nested components (OMP panels)", () => {
  // Shapes from OMP 18.14.1: SelectList describes `col(omp.select) > list > item`; /context describes
  // a `meter` with `parts` and `marks`, and a selectable `list` whose items carry spans.
  const marketplace = (): N => ({
    k: "col",
    p: { role: "omp.select" },
    c: [
      {
        k: "list",
        key: "list",
        p: { selected: "__empty__", empty: "No items", max: { lines: 1 } },
        c: [
          {
            k: "item",
            key: "__empty__",
            p: {
              label: [{ t: "No plugins available" }],
              detail: [{ t: "Add a marketplace first: /marketplace add <source>", s: "muted" }],
              disabled: true,
            },
          },
        ],
      },
    ],
  });

  it("writes a disabled item and its detail under it, not an empty body", () => {
    const result = describedText(marketplace() as never, identity, owner);

    expect(result.html).toContain("No plugins available");
    expect(result.html).toContain("Add a marketplace first: /marketplace add &lt;source&gt;");
    expect(result.actions).toEqual([]);
  });

  it("writes the list's empty text when it holds no items", () => {
    const tree: N = { k: "list", p: { selected: null, empty: "No items" }, c: [] };
    expect(describedText(tree as never, identity, owner).html).toBe("No items");
  });

  it("writes every meter part and mark on its own line instead of a percentage", () => {
    const tree: N = {
      k: "meter",
      p: {
        value: 0.039,
        style: "bar",
        parts: [
          { value: 0.0156, token: "accent", label: "System Prompt (excluding Skills) · 3.1K tokens (1.6%)" },
          { value: 0.811, token: "track", label: "Free space · 162K tokens (81.1%)" },
        ],
        marks: [{ at: 0.85, tone: "warning", title: "Auto-compaction at 85% · 170K tokens" }],
      },
    };
    expect(describedText(tree as never, identity, owner).html).toBe(
      "System Prompt (excluding Skills) · 3.1K tokens (1.6%)\nFree space · 162K tokens (81.1%)\nAuto-compaction at 85% · 170K tokens",
    );
  });

  it("makes the items of a selectable list buttons that send an activate event for the item", () => {
    const tree: N = {
      k: "col",
      c: [
        {
          k: "col",
          key: "overview",
          c: [
            {
              k: "list",
              key: "categories",
              p: { selected: "system-prompt", actions: { click: "select", dblclick: "activate" } },
              c: [
                { k: "item", key: "system-prompt", p: { label: [{ t: "■ ", s: "accent" }, { t: "System Prompt", s: "accent strong" }], value: [{ t: "3.1K · 1.6%" }] } },
                { k: "item", key: "skills", p: { label: [{ t: "■ ", s: "success" }, { t: "Skills" }], value: "0 · 0.0%" } },
              ],
            },
          ],
        },
      ],
    };
    const { actions, html } = describedText(tree as never, identity, owner);

    expect(actions.map((action) => [action.label, action.act, action.keypath, action.item])).toEqual([
      ["System Prompt", "activate", "overview/categories", "system-prompt"],
      ["Skills", "activate", "overview/categories", "skills"],
    ]);
    expect(html).toContain("■ Skills — 0 · 0.0%");
  });

  it("gives no button to a disabled item of a selectable list", () => {
    const tree: N = {
      k: "list",
      key: "categories",
      p: { actions: { click: "select", dblclick: "activate" } },
      c: [{ k: "item", key: "gone", p: { label: "Gone", disabled: true } }],
    };
    expect(describedText(tree as never, identity, owner).actions).toEqual([]);
  });

  it("stops describing nested components below six levels", () => {
    let leaf: object = { describe: () => ({ k: "text", p: { text: "deepest" } }), handleNativeEvent: () => undefined };
    for (let level = 0; level < 9; level += 1) {
      const inner = leaf;
      leaf = {
        describe: () => ({ k: "col", c: [{ k: "text", p: { text: `level ${level}` } }, inner] }),
        handleNativeEvent: () => undefined,
      };
    }
    const html = describedText({ k: "col", c: [leaf] } as never, identity, owner).html;

    expect(html).toContain("level 8");
    expect(html).not.toContain("level 0");
    expect(html).not.toContain("deepest");
  });

  it("reads a component that contains itself once", () => {
    const self: object & { describe: () => N; handleNativeEvent: () => void } = {
      describe: () => ({ k: "col", c: [{ k: "text", p: { text: "loop" } }, self] }),
      handleNativeEvent: () => undefined,
    };
    const html = describedText({ k: "col", c: [self] } as never, identity, owner).html;

    expect(html.split("loop").length - 1).toBe(1);
  });

  it("writes a QR code as its link and never as its symbol block", () => {
    const qr: N = {
      k: "col",
      p: { role: "omp.collab.qrcode" },
      c: [
        { k: "text", p: { spans: [{ t: "collab.example.test/join/abc", s: "accent link", href: "https://collab.example.test/join/abc" }], wrap: "none" } },
        { k: "code", p: { text: "█▀█▀█\n▀▀▀▀▀", lang: "text", wrap: false } },
      ],
    };
    const result = describedText({ k: "col", c: [qr] } as never, identity, owner);

    expect(result.html).toBe("https://collab.example.test/join/abc");
    expect(result.html).not.toContain("█");
  });
});

describe("describedText badges and native-owned lists", () => {
  it("writes a badge as bracketed text on the line it sits in", () => {
    const tree: N = { k: "row", c: [text("gpt-x"), { k: "badge", p: { text: "shadowed" } }] };
    expect(describedText(tree as never, identity, owner).html).toBe("gpt-x [shadowed]");
  });

  it("makes the enabled items of a list buttons when the owner takes native events, even without list actions", () => {
    const nativeOwner = { handleNativeEvent: () => undefined };
    const tree: N = {
      k: "col",
      p: { role: "omp.select" },
      c: [
        {
          k: "list",
          key: "list",
          p: { selected: "a", empty: "No items" },
          c: [
            { k: "item", key: "a", p: { label: "Alpha" } },
            { k: "item", key: "b", p: { label: "Beta", disabled: true } },
          ],
        },
      ],
    };
    const { actions } = describedText(tree as never, identity, nativeOwner);

    expect(actions.map((action) => [action.label, action.act, action.keypath, action.item])).toEqual([
      ["Alpha", "activate", "list", "a"],
    ]);
    expect(actions[0]!.owner).toBe(nativeOwner);
  });
});

describe("describedText context drill-down (OMP context viewer entries)", () => {
  // /context > Built-in Tools, from OMP 18.14.1: the list's children are rows and columns, not items.
  // Each entry is a column with its own actions (click select-entry, dblclick open-entry), keyed by its id.
  const entry = (id: string, name: string, tokens: string, hint: boolean): N => ({
    k: "col",
    p: { gap: "none", actions: { click: "select-entry", dblclick: "open-entry" } },
    key: id,
    c: [
      { k: "text", key: "head", p: { wrap: "word", lines: 1, spans: [{ t: "[", s: "dim" }, { t: name, s: "warning strong" }, { t: `] ${tokens} tokens`, s: "dim" }] } },
      { k: "text", key: "preview", p: { wrap: "word", spans: [{ t: `builtin · <builtin:${name}>`, s: "dim" }, { t: `\n  ${name}\n  Use it.`, s: "dim" }] } },
      ...(hint ? [{ k: "text", key: "hint", p: { wrap: "word", lines: 1, spans: [{ t: "  … more · ", s: "dim" }, { t: "⏎ View Content", s: "accent" }] } }] : []),
    ],
  });
  const drill = (): N => ({
    k: "col",
    p: { role: "omp.context" },
    c: [drillList()],
  });
  const drillList = (): N => ({
    k: "list",
    key: "entries",
    p: { grow: 1, max: { lines: 46 } },
    c: [
      {
        k: "row",
        key: "content",
        p: { gap: "none", align: "start" },
        c: [
          { k: "spacer", key: "gutter", p: { grow: 0 } },
          {
            k: "col",
            key: "list",
            p: { grow: 1, gap: "none" },
            c: [entry("built-in-tools/0", "read", "631", true), { k: "text", key: "separator-0", p: { wrap: "none", text: " " } }, entry("built-in-tools/1", "bash", "361", false)],
          },
        ],
      },
    ],
  });

  it("writes each entry's heading and preview, and no terminal key hint", () => {
    const { html } = describedText(drill() as never, identity, owner);

    expect(html).toContain("[read] 631 tokens");
    expect(html).toContain("builtin · &lt;builtin:read&gt;");
    expect(html).toContain("[bash] 361 tokens");
    expect(html).not.toContain("View Content");
  });

  it("separates the entries by a blank line", () => {
    const { html } = describedText(drill() as never, identity, owner);
    expect(html.indexOf("[bash] 361 tokens")).toBeGreaterThan(html.indexOf("Use it.") + 1);
    expect(html).toMatch(/Use it\.\n\n\[bash\]/);
  });

  it("makes each entry a button that opens it, labelled by its first line, keyed by its keypath", () => {
    const nativeOwner = { handleNativeEvent: () => undefined };
    const { actions } = describedText(drill() as never, identity, nativeOwner);

    expect(actions.map((action) => [action.label, action.act, action.keypath, action.item])).toEqual([
      ["[read] 631 tokens", "open-entry", "entries/content/list/built-in-tools/0", undefined],
      ["[bash] 361 tokens", "open-entry", "entries/content/list/built-in-tools/1", undefined],
    ]);
    expect(actions[0]!.owner).toBe(nativeOwner);
  });
});
