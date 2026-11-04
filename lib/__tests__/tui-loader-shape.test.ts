/**
 * Waiting boxes are recognised by structure, never by class name: OMP ships minified classes (its
 * BorderedLoader arrives as a name such as "F2"), so a name list misses it on the real host. pi's real
 * BorderedLoader is used here as well, to pin that its reading did not change.
 */
import { describe, expect, it } from "vitest";
import { BorderedLoader as PiBorderedLoader } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/bordered-loader.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { infoPanelAdapter } from "../tui/adapters/index.ts";
import type { AdapterContext } from "../tui/model.ts";

initTheme();

function ctxFor(host: "pi" | "omp"): AdapterContext {
  return { host, sendKey: () => true, requestRender: () => {} };
}

/** OMP's BorderedLoader as the shipped binary has it: minified class name, the `signal` getter, the loader card. */
class Zq {
  render(): string[] {
    return [];
  }
  handleInput(): void {}
  get signal(): AbortSignal {
    return new AbortController().signal;
  }
  describe() {
    return {
      k: "card",
      p: { role: "omp.hook.loader" },
      c: [
        { k: "spinner", p: { style: "starburst", label: [{ t: "Sharing session..." }] } },
        { k: "row", p: { role: "omp.overlay.hints" }, c: [{ k: "text", p: { text: [{ t: "cancel" }] } }] },
      ],
    };
  }
}

/** The same role with no signal: a card that is not a cancellable wait. */
class Yk {
  render(): string[] {
    return [];
  }
  handleInput(): void {}
  describe() {
    return { k: "card", p: { role: "omp.hook.loader" }, c: [{ k: "spinner", p: { label: [{ t: "Sharing session..." }] } }] };
  }
}

const fakeTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("waiting boxes are recognised by structure", () => {
  it("picks the panel adapter for a minified OMP loader and reads it as a cancellable wait", () => {
    const component = new Zq();
    const adapter = pickAdapter(component as unknown as object, ctxFor("omp"));
    expect(adapter?.id).toBe("info-panel");
    expect(adapter?.read(component as unknown as object, ctxFor("omp"))).toEqual({
      kind: "progress",
      text: "Sharing session...",
      cancellable: true,
    });
  });

  it("does not take a loader-role card without a signal as a cancellable wait", () => {
    const component = new Yk();
    expect(infoPanelAdapter.read(component, ctxFor("omp")).kind).not.toBe("progress");
  });

  it("keeps reading pi's real BorderedLoader as a cancellable wait with its message", () => {
    const component = new PiBorderedLoader(fakeTui as never, fakeTheme as never, "Signing in...", { cancellable: true });
    const adapter = pickAdapter(component as unknown as object, ctxFor("pi"));
    expect(adapter?.id).toBe("info-panel");
    expect(adapter?.read(component as unknown as object, ctxFor("pi"))).toEqual({
      kind: "progress",
      text: "Signing in...",
      cancellable: true,
    });
  });
});
