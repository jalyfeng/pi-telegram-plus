/**
 * Stage 0 probe extension. Loaded with `-e` next to the plugin so the host
 * creates extension dialogs that the plugin's probe can observe.
 *
 * It is intentionally untyped: it runs under both pi 1.4.0 and OMP 18.12.5,
 * whose extension APIs share the `select/confirm/input/editor/custom` shape but
 * differ around it.
 */
type ProbeUi = {
  select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
  confirm?: (title: string, message: string, opts?: unknown) => Promise<boolean>;
  input?: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string, opts?: unknown) => Promise<string | undefined>;
  custom?: (factory: (...args: unknown[]) => unknown, options?: unknown) => Promise<unknown>;
  notify?: (message: string, type?: string) => void;
  setStatus?: (key: string, text: string | undefined) => void;
  [key: string]: unknown;
};

type ProbeCtx = { ui: ProbeUi; hasUI?: boolean };

function probe(): { record?: (kind: string, data: Record<string, unknown>) => void; describe?: (value: unknown, depth?: number) => unknown } | undefined {
  return (globalThis as Record<string, unknown>).__ptpProbe as
    | { record?: (kind: string, data: Record<string, unknown>) => void; describe?: (value: unknown, depth?: number) => unknown }
    | undefined;
}

function record(kind: string, data: Record<string, unknown>): void {
  try {
    probe()?.record?.(kind, data);
  } catch {
    // never break the host
  }
}

function describe(value: unknown, depth = 2): unknown {
  try {
    return probe()?.describe?.(value, depth) ?? typeof value;
  } catch {
    return typeof value;
  }
}

function uiSnapshot(ui: ProbeUi): Record<string, unknown> {
  const methods: string[] = [];
  let current: unknown = ui;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === "constructor" || methods.includes(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      methods.push(`${name}:${descriptor?.get || descriptor?.set ? "accessor" : typeof descriptor?.value}`);
    }
    current = Object.getPrototypeOf(current);
  }
  return {
    ctor: (ui as { constructor?: { name?: string } }).constructor?.name,
    ownKeys: Object.keys(ui),
    methods,
    sources: Object.fromEntries(
      ["select", "confirm", "input", "editor", "custom", "askDialog", "approve", "notify"]
        .map((name) => {
          const value = (ui as Record<string, unknown>)[name];
          return [name, typeof value === "function" ? String(value).slice(0, 900) : String(value)];
        }),
    ),
    has: {
      select: typeof ui.select,
      confirm: typeof ui.confirm,
      input: typeof ui.input,
      inputSecret: typeof ui.inputSecret,
      editor: typeof ui.editor,
      custom: typeof ui.custom,
      askDialog: typeof ui.askDialog,
      approve: typeof ui.approve,
      notify: typeof ui.notify,
      setStatus: typeof ui.setStatus,
      getEditorText: typeof ui.getEditorText,
      setEditorText: typeof ui.setEditorText,
    },
  };
}

function makeCustomComponent(done: (value: unknown) => void): Record<string, unknown> {
  // Deliberately mirrors pi-goal's component: closure state, no public fields.
  const options = ["alpha", "beta", "gamma"];
  let selectedIndex = 0;
  let inputMode = false;
  let text = "";
  const answers = new Map<string, string>();
  return {
    render(_width: number): string[] {
      return [
        "PROBE CUSTOM DIALOG",
        `state: ${inputMode ? "input" : "options"} selected=${selectedIndex} answers=${answers.size} text=${text}`,
        ...options.map((option, index) => `${index === selectedIndex ? "> " : "  "}${index + 1}. ${option}`),
        "Enter select • Tab input • Esc cancel",
      ];
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (data === "\x1b") {
        done({ cancelled: true });
        return;
      }
      if (data === "\t") {
        inputMode = !inputMode;
        return;
      }
      if (inputMode && data !== "\r") {
        text += data;
        return;
      }
      if (inputMode && data === "\r") {
        answers.set("text", text);
        done({ answer: text, answers: [...answers.entries()] });
        return;
      }
      if (data === "\x1b[B") selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
      else if (data === "\x1b[A") selectedIndex = Math.max(0, selectedIndex - 1);
      else if (data === "\r") {
        answers.set("choice", options[selectedIndex]);
        done({ answer: options[selectedIndex], answers: [...answers.entries()] });
      }
      // Keep the closure variables referenced so the probe's render text shows state.
      void text;
    },
  };
}

/**
 * A component no adapter recognises (T4.6): it has `render`/`handleInput`/
 * `invalidate`, so it is a real focused dialog, but it is neither a goal frame,
 * a list, an input, an editor, nor a read-only panel. The plugin must announce
 * it and offer one way out, never mirror its text.
 */
function makeUnknownComponent(done: (value: unknown) => void): Record<string, unknown> {
  return {
    render(_width: number): string[] {
      return ["PROBE UNKNOWN WIDGET", "press Esc to close"];
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (data === "\x1b") done({ cancelled: true });
    },
  };
}

let editorTimer: ReturnType<typeof setInterval> | undefined;

export default function probeExtension(pi: {
  registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ProbeCtx) => Promise<void> }) => void;
  on?: (event: string, handler: (event: unknown, ctx: ProbeCtx) => void) => void;
}): void {
  // Records what the editor holds, so E2E can tell whether a submitted command left text behind.
  if (pi.on) {
    pi.on("session_start", (_event: unknown, ctx: ProbeCtx) => {
      try {
        if (editorTimer) clearInterval(editorTimer);
        const ui = ctx.ui as { getEditorText?: () => unknown };
        let last: string | undefined;
        editorTimer = setInterval(() => {
          try {
            const text = ui.getEditorText?.();
            if (typeof text !== "string" || text === last) return;
            last = text;
            record("editor-text", { text });
          } catch {
            // never break the host
          }
        }, 150);
        (editorTimer as { unref?: () => void }).unref?.();
      } catch {
        // never break the host
      }
    });
  }

  const register = (name: string, run: (ctx: ProbeCtx) => Promise<void>): void => {
    pi.registerCommand(name, {
      description: `stage 0 probe: ${name}`,
      handler: async (_args, ctx) => {
        record("extension-command", { name, ui: uiSnapshot(ctx.ui) });
        try {
          await run(ctx);
        } catch (error) {
          record("extension-command-error", { name, error: describe(error) });
        }
      },
    });
  };

  register("probe-ui", async (ctx) => {
    record("extension-ui", {
      hasUI: ctx.hasUI,
      ui: uiSnapshot(ctx.ui),
      globalProbe: Boolean(probe()),
    });
  });

  register("probe-select", async (ctx) => {
    const value = await ctx.ui.select?.("PROBE_SELECT_TITLE", ["alpha", "beta", "gamma"]);
    record("extension-result", { name: "select", value: describe(value) });
  });

  register("probe-confirm", async (ctx) => {
    const value = await ctx.ui.confirm?.("PROBE_CONFIRM_TITLE", "PROBE_CONFIRM_MESSAGE");
    record("extension-result", { name: "confirm", value: describe(value) });
  });

  register("probe-input", async (ctx) => {
    const value = await ctx.ui.input?.("PROBE_INPUT_TITLE", "PROBE_PLACEHOLDER");
    record("extension-result", { name: "input", value: describe(value) });
  });

  register("probe-input-secret", async (ctx) => {
    const secret = ctx.ui.inputSecret as ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined;
    const value = typeof secret === "function"
      ? await secret("PROBE_SECRET_TITLE", "PROBE_SECRET_PLACEHOLDER")
      : await ctx.ui.input?.("PROBE_SECRET_TITLE", "PROBE_SECRET_PLACEHOLDER");
    record("extension-result", { name: "inputSecret", value: describe(value) });
  });

  register("probe-editor", async (ctx) => {
    const value = await ctx.ui.editor?.("PROBE_EDITOR_TITLE", "PROBE_EDITOR_PREFILL");
    record("extension-result", { name: "editor", value: describe(value) });
  });

  register("probe-custom", async (ctx) => {
    const value = await ctx.ui.custom?.((tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => {
      record("extension-custom-factory", {
        tui: describe(tui),
        theme: describe(theme),
        keybindings: describe(keybindings),
      });
      return makeCustomComponent(done);
    }, { overlay: true });
    record("extension-result", { name: "custom", value: describe(value) });
  });

  register("probe-custom-unknown", async (ctx) => {
    const value = await ctx.ui.custom?.(
      (_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: unknown) => void) => makeUnknownComponent(done),
      { overlay: true },
    );
    record("extension-result", { name: "custom-unknown", value: describe(value) });
  });

  // OMP's `ask` dialog: two questions, one recommended, one multi-select, so the
  // captured component is in its richest form (T3.0 needs the row structure).
  register("probe-ask", async (ctx) => {
    const ask = ctx.ui.askDialog as ((questions: unknown[], options?: unknown) => Promise<unknown>) | undefined;
    if (typeof ask !== "function") {
      record("extension-result", { name: "askDialog", value: { type: "undefined" } });
      return;
    }
    const value = await ask([
      { id: "colour", question: "PROBE_ASK_Q1", options: [{ label: "red" }, { label: "green", description: "PROBE_ASK_RECOMMENDED" }, { label: "blue" }], recommended: 1 },
      { id: "topping", question: "PROBE_ASK_Q2", options: [{ label: "cheese" }, { label: "mushroom" }], multi: true },
    ]);
    record("extension-result", { name: "askDialog", value: describe(value) });
  });

  register("probe-notify", async (ctx) => {
    ctx.ui.notify?.("PROBE_NOTIFY_INFO", "info");
    ctx.ui.notify?.("PROBE_NOTIFY_WARNING", "warning");
    ctx.ui.notify?.("PROBE_NOTIFY_ERROR", "error");
    ctx.ui.setStatus?.("probe", "PROBE_STATUS");
  });
}
