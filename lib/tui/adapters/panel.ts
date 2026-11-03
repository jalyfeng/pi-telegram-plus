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
import { isCancelOnlyLoader, isReadOnlyPanel } from "../find-shape.ts";
import { actionKeys, describedText, withoutLeadingTitle, type DescribedAction, type DescribedText } from "../describe-text.ts";
import { contentHtml } from "../output.ts";
import { describableChild, describesDialog, describesLoginSheet, describeTree, tspText, type NativeNodeLike } from "./tsp.ts";

type Describable = object & { handleNativeEvent(event: unknown): unknown };

/**
 * The title the host gave its own panel: the `nativeOverlay.head` a report carries (OMP's
 * `ReportPanel`), else the panel's own `title`. Undefined when it gave none.
 */
function hostTitle(component: object): string | undefined {
  const record = component as Record<string, unknown>;
  const overlay = record.nativeOverlay;
  const head = overlay && typeof overlay === "object" ? tspText((overlay as Record<string, unknown>).head).trim() : "";
  if (head !== "") return head;
  return typeof record.title === "string" && record.title.trim() !== "" ? record.title.trim() : undefined;
}

/**
 * A read-only panel's title, in order: the entry's, the host's own, the first heading its tree
 * shows, then the command that opened it. Undefined only when none of them exists.
 */
function panelTitle(component: object, ctx: AdapterContext, treeTitle?: string): string | undefined {
  return ctx.entry?.title ?? hostTitle(component) ?? treeTitle ?? ctx.commandName;
}

/** The first head a described tree shows at its root (a card's `head`), if any. */
function describedHead(component: object): string | undefined {
  const root = describeTree(component);
  if (!root || typeof root.p !== "object" || root.p === null) return undefined;
  const head = tspText((root.p as Record<string, unknown>).head).trim();
  return head === "" ? undefined : head;
}

/** Whether a child slot of the described tree is a component with no `describe` of its own (only a `render`). */
function undescribedIn(node: NativeNodeLike, depth: number): boolean {
  if (depth > 12) return false;
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (typeof child !== "object" || child === null) continue;
    if (describableChild(child)) continue;
    if (typeof (child as Record<string, unknown>).render === "function") return true;
    if (undescribedIn(child as NativeNodeLike, depth + 1)) return true;
  }
  return false;
}

/**
 * What an unreadable panel is called in its notice: the entry's method, else the title the host gave
 * it, else its class name. When a nested component has no description, the notice says so, so a
 * reader knows why nothing of the panel was written.
 */
function unreadableWhat(component: object, ctx: AdapterContext): string {
  const base = ctx.entry?.method ?? hostTitle(component) ?? describedHead(component) ?? "unknown dialog";
  const root = describeTree(component);
  return root !== undefined && undescribedIn(root, 0) ? `${base} (nested component without a description)` : base;
}

/** The panel as it is described right now (live tree, not a snapshot), redacted per run. */
function liveText(component: object, redact: (text: string) => string): DescribedText | undefined {
  const root = describeTree(component);
  if (!root) return undefined;
  return describedText(root, redact, component);
}

/**
 * Whether Escape does more than close the view: a function that stops the work, or a waiting box that
 * Escape aborts through (its shape is read in `isCancelOnlyLoader`, shared with the focus rule).
 */
const cancellable = (component: object): boolean => {
  const record = component as Record<string, unknown>;
  if (["cancel", "stop", "abort"].some((name) => typeof record[name] === "function")) return true;
  return isCancelOnlyLoader(component);
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
    return isReadOnlyPanel(component) || isCancelOnlyLoader(component);
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
      if (described.html) return { kind: "info", title: panelTitle(component, ctx, described.title), text: described.html, html: true, closable: true };
    }
    const message = loaderMessage(component);
    if (message !== undefined && message.trim() !== "") {
      return { kind: "info", title: panelTitle(component, ctx), text: redact(message).trim(), closable: true };
    }
    const html = contentHtml(component as Record<string, unknown>, redact);
    if (html) return { kind: "info", title: panelTitle(component, ctx), text: html, html: true, closable: true };
    // Nothing readable: name the panel, never mirror a frame (plan v8 §0.0).
    return { kind: "unsupported", title: ctx.entry?.title, what: unreadableWhat(component, ctx) };
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
/**
 * Whether a host component is an OMP text panel the described-panel adapter
 * owns: it describes itself, takes native events, is not a spinner (Escape
 * cancels it), and is not a picker, prefs page or login sheet. Focus uses the
 * same rule, so a focused panel is a dialog before any adapter reads it.
 */
export function isDescribedPanel(component: object): boolean {
  if (cancellable(component)) return false;
  if (describesDialog(component) || describesLoginSheet(component)) return false;
  if (describeTree(component) === undefined) return false;
  if (typeof (component as Partial<Describable>).handleNativeEvent === "function") return true;
  // An overlay without native events of its own (OMP's /debug) is a panel when a nested component
  // that takes them holds a list to press.
  return nestedAnswers(component, 0, new Set<object>([component]));
}

/** Nested component levels searched for a list that can be pressed (as OMP's tsp adapters search them). */
const MAX_NESTED_LEVELS = 4;

/** Whether a component below `component` takes native events and holds an enabled, keyed list item. */
function nestedAnswers(component: object, level: number, visited: Set<object>): boolean {
  if (level >= MAX_NESTED_LEVELS) return false;
  const root = describeTree(component);
  return root !== undefined && nestedIn(root, level, visited);
}

function nestedIn(node: NativeNodeLike, level: number, visited: Set<object>): boolean {
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  for (const child of children) {
    if (typeof child !== "object" || child === null) continue;
    const nested = describableChild(child);
    if (nested) {
      if (visited.has(nested)) continue;
      visited.add(nested);
      if (typeof (nested as Partial<Describable>).handleNativeEvent === "function" && hasPressableList(nested)) return true;
      if (nestedAnswers(nested, level + 1, visited)) return true;
      continue;
    }
    if (nestedIn(child as NativeNodeLike, level, visited)) return true;
  }
  return false;
}

/** Whether the component's own tree (not its nested components) has a list with an enabled, keyed item. */
function hasPressableList(component: object): boolean {
  const root = describeTree(component);
  return root !== undefined && listIn(root, 0);
}

function listIn(node: NativeNodeLike, depth: number): boolean {
  if (depth > 12) return false;
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  if (node.k === "list") {
    const enabled = children.some((child) => {
      if (typeof child !== "object" || child === null) return false;
      const item = child as NativeNodeLike;
      const props = typeof item.p === "object" && item.p !== null ? (item.p as Record<string, unknown>) : {};
      return item.k === "item" && props.disabled !== true && item.key !== undefined;
    });
    if (enabled) return true;
  }
  for (const child of children) {
    if (typeof child !== "object" || child === null || describableChild(child)) continue;
    if (listIn(child as NativeNodeLike, depth + 1)) return true;
  }
  return false;
}

export const describedPanelAdapter: DialogAdapter = {
  id: "described-panel",

  detect(component, ctx) {
    if (ctx.host !== "omp" || ctx.entry?.race) return false;
    return isDescribedPanel(component);
  },

  read(component, ctx): DialogModel {
    const described = liveText(component, ctx.redact ?? ((text) => text));
    const actions = described?.actions ?? [];
    const keys = actionKeys(actions);
    // A close button of the panel is the way out; no second Close is added.
    const hasClose = actions.some((action) => action.act === "close");
    const title = panelTitle(component, ctx, described?.title);
    return {
      kind: "info",
      title,
      // The title is the message header already; the body does not repeat it on its first lines.
      text: withoutLeadingTitle(described?.html ?? "", title),
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
  // A list item replays as the list's own activate event (as the picker adapter sends it).
  const event =
    target.item !== undefined
      ? { type: "activate", key: target.keypath, item: target.item }
      : { type: "action", key: target.keypath, act: target.act, ...(target.value !== undefined ? { value: target.value } : {}), mods: [] };
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
    return { kind: "unsupported", title: ctx.entry?.title, what: unreadableWhat(component, ctx) };
  },

  act(_component, action, ctx) {
    // Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};
