import { describe, expect, it } from "vitest";
import { fitRows, renderDialog } from "../tui/render-telegram.ts";
import type { DialogItem, DialogModel } from "../tui/model.ts";
import type { TelegramButton } from "../types.ts";

const CTX = { sessionId: "s1", generation: 1 };

/** OMP /agents shape: 2 scope + 5 action extras on top of Search/Cancel. */
const extraActions = [
  { label: "● Running", key: "scope:0" },
  { label: "All", key: "scope:2" },
  { label: "Inspect", key: "act:0" },
  { label: "Summarize", key: "act:1" },
  { label: "Stop", key: "act:2" },
  { label: "Restart", key: "act:3" },
  { label: "Mute", key: "act:4" },
  { label: "Export", key: "act:5" },
  { label: "Refresh", key: "act:6" },
];

function selectModel(overrides: Partial<Extract<DialogModel, { kind: "select" }>> = {}): DialogModel {
  return {
    kind: "select",
    title: "Agents",
    items: [
      { key: "a", label: "agent-a" },
      { key: "b", label: "agent-b" },
    ],
    total: 2,
    search: { query: "" },
    extraActions,
    ...overrides,
  };
}

const texts = (rows: TelegramButton[][]) => rows.map((row) => row.map((b) => b.text));

describe("select footer wraps within Telegram's per-row button limit", () => {
  it("splits nine extras into rows of three and keeps Search/Cancel last", () => {
    const rendered = renderDialog(selectModel(), CTX);
    const grid = texts(rendered.rows);

    expect(rendered.rows.every((row) => row.length <= 3)).toBe(true);
    expect(grid.at(-1)).toEqual(["🔍 Search", "Cancel"]);

    // Nothing dropped, nothing shuffled: items first, then every extra in
    // model order, then the fixed footer row.
    const flat = rendered.rows.flat().map((b) => b.text);
    expect(flat).toEqual([
      "agent-a",
      "agent-b",
      ...extraActions.map((extra) => extra.label),
      "🔍 Search",
      "Cancel",
    ]);
  });

  it("keeps Submit in the final row alongside Search and Cancel", () => {
    const rendered = renderDialog(selectModel({ multi: true }), CTX);
    expect(texts(rendered.rows).at(-1)).toEqual(["⏎ Submit", "🔍 Search", "Cancel"]);
  });

  it("re-chunks any row past the eight-button hard limit", () => {
    const long: TelegramButton[] = Array.from({ length: 9 }, (_, i) => ({ text: `b${i + 1}`, value: `v${i + 1}` }));
    const ok: TelegramButton[] = Array.from({ length: 8 }, (_, i) => ({ text: `c${i + 1}`, value: `w${i + 1}` }));
    const fitted = fitRows([long, ok]);

    expect(fitted.every((row) => row.length <= 8)).toBe(true);
    expect(fitted.map((row) => row.length)).toEqual([3, 3, 3, 8]);
    expect(fitted.flat().map((b) => b.text)).toEqual([...long, ...ok].map((b) => b.text));
  });
});

describe("input dialog shows the login body as plain text", () => {
  const URL = "https://example.test/device?x=1&y=2";

  it("renders detail as escaped plain text, not inside <pre>", () => {
    const model: DialogModel = { kind: "input", title: "Waiting for approval", detail: `Sign in.\nCode: AB-12\n${URL}`, secret: false };
    const text = renderDialog(model, CTX).text;
    expect(text).toContain("Sign in.\nCode: AB-12\nhttps://example.test/device?x=1&amp;y=2\n");
    expect(text).not.toContain(`<pre>${URL}`);
    expect(text).not.toMatch(/<pre>[^<]*example\.test/);
  });

  it("renders without detail exactly as before", () => {
    const model: DialogModel = { kind: "input", title: "Paste your API key", placeholder: "sk-...", secret: false };
    expect(renderDialog(model, CTX).text).toBe(
      "<b>Paste your API key</b>\n<pre>sk-...</pre>\nSend a message as the input, or tap Cancel.",
    );
  });
});

describe("progress dialog keeps its lines", () => {
  it("renders each line of a multi-line progress text on its own line", () => {
    const url = "https://platform.deepseek.com/api_keys";
    const text = ["Sign in to DeepSeek", "Create or copy your API key.", url, "Waiting for browser authentication…"].join("\n");
    const rendered = renderDialog({ kind: "progress", text, cancellable: true }, CTX).text;
    expect(rendered).toContain(`Sign in to DeepSeek\nCreate or copy your API key.\n${url}\nWaiting for browser authentication…`);
  });

  it("escapes HTML in progress lines and keeps the whole URL", () => {
    const rendered = renderDialog({ kind: "progress", text: "A & B\nhttps://example.test/a?x=1&y=2", cancellable: true }, CTX).text;
    expect(rendered).toContain("A &amp; B\nhttps://example.test/a?x=1&amp;y=2");
  });
});

describe("host detail shown as message text (Y-2)", () => {
  it("prints the subtitle, the search hint, the notice, each item's badges and note, and section headings", () => {
    const model: DialogModel = {
      kind: "select",
      title: "Models",
      subtitle: "Pick a model",
      items: [
        { key: "a", label: "alpha", note: "Not configured", badges: ["default (Default · thinking)"], group: "Local" },
        { key: "b", label: "beta", group: "Local" },
        { key: "c", label: "gamma", group: "Cloud" },
      ],
      total: 3,
      search: { query: "", placeholder: "Search models…" },
      notice: "Nothing else here.",
    };
    const { text } = renderDialog(model, CTX);
    expect(text).toContain("Pick a model");
    expect(text).toContain("🔍 Search models…");
    expect(text).toContain("Nothing else here.");
    expect(text).toContain("<b>Local</b>");
    expect(text).toContain("alpha [default (Default · thinking)] — Not configured");
    expect(text.split("<b>Local</b>").length).toBe(2);
    expect(text).toContain("<b>Cloud</b>");
  });

  it("escapes host text and truncates a long note", () => {
    const model: DialogModel = {
      kind: "select",
      title: "T",
      items: [{ key: "a", label: "a", note: `<b>${"x".repeat(200)}`, badges: ["a&b"] }],
      total: 1,
    };
    const { text } = renderDialog(model, CTX);
    expect(text).toContain("&lt;b&gt;");
    expect(text).toContain("a&amp;b");
    expect(text).not.toContain("<b>xxx");
    expect(text).toContain("…");
  });

  it("prints the empty-list notice in the body rather than the title", () => {
    const model: DialogModel = { kind: "select", title: "Tree", items: [], total: 0, notice: "14 entries hidden by the filter.", extraActions: [{ label: "All", key: "tab:1" }] };
    const { text, rows } = renderDialog(model, CTX);
    expect(text).toContain("14 entries hidden by the filter.");
    expect(text.split("\n")[0]).toBe("<b>Tree</b>");
    expect(texts(rows)).toContainEqual(["All"]);
  });

  it("shows the settings page label and lead and each row's note", () => {
    const model: DialogModel = {
      kind: "settings",
      title: "Settings",
      subtitle: "Models",
      notice: "Pick the models pi uses.",
      items: [{ key: "think", label: "Thinking", value: "On", values: ["On", "Off"], note: "How hard to think" }],
    };
    const { text } = renderDialog(model, CTX);
    expect(text).toContain("Models");
    expect(text).toContain("Pick the models pi uses.");
    expect(text).toContain("Thinking: On — How hard to think");
  });

  it("marks the current wizard step in the step list", () => {
    const model: DialogModel = {
      kind: "input",
      title: "Name the server",
      secret: false,
      steps: [
        { label: "Name", current: true },
        { label: "Transport", current: false },
      ],
    };
    const { text } = renderDialog(model, CTX);
    expect(text).toContain("<b>Name</b> › Transport");
    expect(text).toContain("Name the server");
  });

  it("uses the host's confirm labels in place of Yes and No", () => {
    const model: DialogModel = { kind: "confirm", title: "Delete it?", confirmLabel: "Delete", cancelLabel: "Keep" };
    const { rows, keyMap } = renderDialog(model, CTX);
    expect(texts(rows)).toEqual([["Delete", "Keep"]]);
    expect(keyMap.size).toBe(0);
  });

  it("keeps Yes and No for a confirm without host labels", () => {
    const { rows } = renderDialog({ kind: "confirm", title: "Sure?" }, CTX);
    expect(texts(rows)).toEqual([["✅ Yes", "❌ No"], ["Cancel"]]);
  });
});

describe("a long page keeps its items inside the message limit (Y-2)", () => {
  it("drops details, not items, when a page's details would not fit", () => {
    const items: DialogItem[] = Array.from({ length: 10 }, (_, index) => ({
      key: `k${index}`,
      label: `item-${index}`,
      note: "n".repeat(100),
      badges: ["b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40), "f".repeat(40), "g".repeat(40)],
    }));
    const { text } = renderDialog({ kind: "select", title: "Long", items, total: 10, notice: "x".repeat(300) }, CTX);
    expect(text.length).toBeLessThan(4096);
    for (let index = 0; index < 10; index += 1) expect(text).toContain(`item-${index}`);
    expect(text).not.toContain("nnnn");
  });

  it("keeps the details when a page fits", () => {
    const items: DialogItem[] = [{ key: "a", label: "alpha", note: "short note" }];
    const { text } = renderDialog({ kind: "select", title: "Short", items, total: 1 }, CTX);
    expect(text).toContain("alpha — short note");
  });
});
