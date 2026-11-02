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
import { findShape } from "../find-shape.ts";

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

/** The first `TextFormField` under a component, walking nested components too. */
export function findTextFormField(component: object): TextFormFieldLike | undefined {
  return findShape(component, isTextFormField, FORM_FIELD_DEPTH);
}

/**
 * The input model for a nested field. The field's label is not exposed on the
 * public surface, so the title is the generic "Input". The current value is
 * offered as the placeholder, but never for a masked field: it may be a secret.
 */
export function textFormFieldModel(field: TextFormFieldLike): InputModel {
  const secret = field.input.mask === true;
  const current = field.getValue();
  const value = typeof current === "string" ? current : "";
  return {
    kind: "input",
    title: "Input",
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
