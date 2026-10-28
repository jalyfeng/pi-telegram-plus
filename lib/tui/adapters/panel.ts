/**
 * Adapters #12/#13 — everything that is not a dialog (§4.6.4).
 *
 * A *panel* is read-only: it renders text and owns focus, so nothing can be
 * typed while it is up (a loader, a history view, a debug view). It gets an
 * info model: the text plus one way out.
 *
 * *Unsupported* is the last resort for anything interactive we cannot parse:
 * the Telegram message says plainly that the dialog needs the terminal, and
 * Escape is the only key that ever goes in. We never mirror the screen —
 * arrow keys over an unparsed frame guess at what the dialog meant (§4.6.5 #13,
 * decision 47).
 */
import type { AdapterContext, DialogAdapter, DialogModel } from "../model.ts";
import { isReadOnlyPanel } from "../find-shape.ts";
import { actionKeys, describedText, type DescribedAction, type DescribedText } from "../describe-text.ts";
import { contentHtml } from "../output.ts";
import { describesDialog, describesLoginSheet, describeTree, tspText, type NativeNodeLike } from "./tsp.ts";
import { constructorName } from "./utils.ts";

type Describable = object & { handleNativeEvent(event: unknown): unknown };

/** The panel as it is described right now (live tree, not a snapshot), redacted per run. */
function liveText(component: object, redact: (text: string) => string): DescribedText | undefined {
  const root = describeTree(component);
  if (!root) return undefined;
  return describedText(root, redact, component);
}

/**
 * Whether Escape does more than close the view. pi's `BorderedLoader` keeps no
 * stop method: it carries the host's own `cancellable` flag plus an AbortSignal
 * that Escape aborts through, so both shapes count.
 */
const cancellable = (component: object): boolean => {
  const record = component as Record<string, unknown>;
  if (["cancel", "stop", "abort"].some((name) => typeof record[name] === "function")) return true;
  return record.cancellable === true && "signal" in record;
};

/** The text a pi loader keeps: `Loader.message`, or a BorderedLoader's `loader.message`. */
function loaderMessage(component: object): string | undefined {
  const record = component as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  const inner = record.loader;
  if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).message === "string") {
    return (inner as Record<string, unknown>).message as string;
  }
  return undefined;
}

/** The first spinner or progress label of a described tree, plain text (never a render). */
function describedLabel(node: NativeNodeLike, depth = 0): string | undefined {
  if (depth > 12 || typeof node !== "object" || node === null) return undefined;
  if (node.k === "spinner" || node.k === "progress") {
    const label = tspText((node.p as Record<string, unknown> | undefined)?.label);
    if (label.trim() !== "") return label.trim();
  }
  const children = Array.isArray(node.c) ? (node.c as NativeNodeLike[]) : [];
  for (const child of children) {
    const label = describedLabel(child, depth + 1);
    if (label !== undefined) return label;
  }
  return undefined;
}

export const infoPanelAdapter: DialogAdapter = {
  id: "info-panel",

  detect(component, ctx) {
    if (ctx.entry?.kind === "panel") return true;
    return isReadOnlyPanel(component);
  },

  read(component, ctx): DialogModel {
    const redact = ctx.redact ?? ((text: string) => text);
    const root = describeTree(component);
    if (cancellable(component)) {
      // A spinner's label, else the loader's own message; never the screen.
      const label = (root ? describedLabel(root) : undefined) ?? loaderMessage(component) ?? "";
      return { kind: "progress", text: redact(label).trim(), cancellable: true };
    }
    if (root) {
      const described = describedText(root, redact, component);
      if (described.html) return { kind: "info", title: ctx.entry?.title, text: described.html, html: true, closable: true };
    }
    const message = loaderMessage(component);
    if (message !== undefined && message.trim() !== "") {
      return { kind: "info", title: ctx.entry?.title, text: redact(message).trim(), closable: true };
    }
    const html = contentHtml(component as Record<string, unknown>, redact);
    if (html) return { kind: "info", title: ctx.entry?.title, text: html, html: true, closable: true };
    // Nothing readable: name the panel, never mirror a frame (plan v8 §0.0).
    const what = ctx.entry?.method ?? (constructorName(component) || "unknown");
    return { kind: "unsupported", title: ctx.entry?.title, what };
  },

  act(_component, action, ctx) {
    // Read-only means read-only: Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};

/**
 * OMP text panels (reports, `/session`, `/usage`, `/jobs`, `/btw`): their
 * `describe()` tree becomes Telegram text, and the panel's own buttons become
 * Telegram buttons. Trees that hold a picker, a settings page or a text prompt
 * belong to the tsp adapters, which run before this one.
 */
export const describedPanelAdapter: DialogAdapter = {
  id: "described-panel",

  detect(component, ctx) {
    if (ctx.host !== "omp" || ctx.entry?.race) return false;
    if (typeof (component as Partial<Describable>).handleNativeEvent !== "function") return false;
    if (cancellable(component)) return false;
    if (describesDialog(component) || describesLoginSheet(component)) return false;
    return describeTree(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const described = liveText(component, ctx.redact ?? ((text) => text));
    const actions = described?.actions ?? [];
    const keys = actionKeys(actions);
    // A close button of the panel is the way out; no second Close is added.
    const hasClose = actions.some((action) => action.act === "close");
    return {
      kind: "info",
      title: ctx.entry?.title ?? described?.title,
      text: described?.html ?? "",
      html: true,
      closable: !hasClose,
      actions: actions.map((action, index) => ({ label: action.label, key: keys[index] })),
    };
  },

  act(component, action, ctx) {
    // Always the live tree: a button pressed after the panel changed resolves to
    // whatever the same key names now, or is refused - never to another button.
    const live = liveText(component, ctx.redact ?? ((text) => text));
    if (action.type === "cancel") {
      const close = live?.actions.find((entry) => entry.act === "close");
      if (!close) return ctx.sendKey("esc");
      return fire(close, ctx);
    }
    if (action.type !== "choose" || !live) return false;
    const index = actionKeys(live.actions).indexOf(action.key);
    const target = index >= 0 ? live.actions[index] : undefined;
    return target ? fire(target, ctx) : false;
  },
};

/** Replays a described button through its owner's `handleNativeEvent`, then asks for a redraw. */
function fire(target: DescribedAction, ctx: AdapterContext): boolean {
  const handle = (target.owner as Partial<Describable>).handleNativeEvent;
  if (typeof handle !== "function") return false;
  const event = { type: "action", key: target.keypath, act: target.act, ...(target.value !== undefined ? { value: target.value } : {}), mods: [] };
  try {
    handle.call(target.owner, event);
  } catch {
    return false;
  }
  try {
    ctx.requestRender();
  } catch {
    // A host without a live renderer has nothing to redraw; the act landed.
  }
  return true;
}

export const unsupportedAdapter: DialogAdapter = {
  id: "unsupported",
  detect() {
    // Last in the registry: it matches anything, so it must be asked last.
    return true;
  },

  read(component, ctx): DialogModel {
    // No frame is read: there is nothing to mirror, only something to name.
    const what = ctx.entry?.method ?? (constructorName(component) || "unknown");
    return { kind: "unsupported", title: ctx.entry?.title, what };
  },

  act(_component, action, ctx) {
    // Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};
