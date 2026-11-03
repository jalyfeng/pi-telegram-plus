/**
 * OMP's `TextFormField` (pi-tui `components/form.ts`): a single-line field
 * that a host dialog nests inside its own panel. A picker's rename dialog and
 * the MCP add wizard's text steps both hold one, so the picker and input
 * adapters reach it by shape, never by constructor name (production builds
 * minify class names).
 *
 * The field's public members are read and called, never its screen: `input`
 * carries the mask flag and the escape callback, `getValue`/`setValue` read and
 * write the text, `submit` runs the field's own validation and `onSubmit`.
 */
import type { DialogModel } from "../model.ts";

type InputModel = Extract<DialogModel, { kind: "input" }>;

/** The parts of `TextFormField` this adapter uses (`input` is pi-tui `Input`). */
export type TextFormFieldLike = object & {
  input: Record<string, unknown>;
  getValue(): unknown;
  setValue(value: string): unknown;
  submit(): unknown;
};

/** How deep the walk goes from a dialog root: the rename dialog sits about three components down. */
const FORM_FIELD_DEPTH = 6;

/** Duck-typed: a field with its `input` and the three methods the adapters call. */
export function isTextFormField(value: unknown): value is TextFormFieldLike {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.input === "object" && o.input !== null
    && typeof o.getValue === "function"
    && typeof o.setValue === "function"
    && typeof o.submit === "function";
}

/**
 * The title of the nearest ancestor of a found field that shows one (OMP's
 * `OverlayPanel` keeps its title in a public getter), recorded by
 * `findTextFormField` so `textFormFieldModel` can read it from the field alone.
 */
const fieldTitles = new WeakMap<object, string>();

/**
 * The same walk as `findShape` (same depth, same skipped fields, same breadth
 * order), keeping each node's parent so the path back to the root is known.
 */
const WALK_SKIP_FIELDS = new Set([
  "chat", "chatContainer", "messagesContainer", "messages", "transcript",
  "history", "parent", "ui", "tui", "renderer", "theme", "keybindings",
  "session", "agent", "modelRegistry", "settings", "settingsManager",
]);

function walkChildren(node: object): object[] {
  const out: object[] = [];
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    if (WALK_SKIP_FIELDS.has(name) || typeof value === "function") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") out.push(item);
    } else if (value && typeof value === "object") {
      out.push(value);
    }
  }
  return out;
}

/** The first `TextFormField` under a component, walking nested components too. Records its nearest titled ancestor. */
export function findTextFormField(component: object): TextFormFieldLike | undefined {
  const parents = new Map<object, object | undefined>([[component, undefined]]);
  const seen = new Set<object>();
  let frontier: object[] = [component];
  for (let depth = 0; depth <= FORM_FIELD_DEPTH; depth += 1) {
    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (!isTextFormField(node)) continue;
      for (let up = parents.get(node); up !== undefined; up = parents.get(up)) {
        const title = (up as Record<string, unknown>).title;
        if (typeof title === "string" && title.trim() !== "") {
          fieldTitles.set(node, title.trim());
          break;
        }
      }
      return node;
    }
    const next: object[] = [];
    for (const node of frontier) {
      for (const child of walkChildren(node)) {
        if (!parents.has(child)) parents.set(child, node);
        next.push(child);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * The input model for a nested field. Its title is the nearest titled ancestor
 * (see `findTextFormField`), else the generic "Input". The current value is
 * offered as the placeholder, but never for a masked field: it may be a secret.
 */
export function textFormFieldModel(field: TextFormFieldLike): InputModel {
  const secret = field.input.mask === true;
  const current = field.getValue();
  const value = typeof current === "string" ? current : "";
  return {
    kind: "input",
    title: fieldTitles.get(field) ?? "Input",
    ...(!secret && value !== "" ? { placeholder: value } : {}),
    secret,
  };
}

/** Replace the field's text and submit it through the field's own `submit`. */
export function submitTextFormField(field: TextFormFieldLike, text: string): boolean {
  try {
    field.setValue(text);
    field.submit();
    return true;
  } catch {
    return false;
  }
}

/** Cancel the field the way its own Escape key does (`TextFormField` wires `input.onEscape` to `onCancel`). */
export function cancelTextFormField(field: TextFormFieldLike): boolean {
  const onEscape = field.input.onEscape;
  if (typeof onEscape !== "function") return false;
  try {
    onEscape.call(field.input);
    return true;
  } catch {
    return false;
  }
}
