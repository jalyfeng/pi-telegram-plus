/**
 * Key names -> terminal byte sequences, and the only two ways we deliver
 * input to a host component (§4.1.3): the host input pipeline, or the focused
 * component's own `handleInput`.
 */
import { log } from "../logger.ts";
import { findShape, isInteractiveShape } from "./find-shape.ts";

const keysLog = log.child("tui-keys");

export const KEY_SEQUENCES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  space: " ",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  backspace: "\x7f",
  // The host's own legends advertise ⌃C to leave a dialog.
  "ctrl-c": "\x03",
};

export function keySequence(name: string): string | undefined {
  const key = name.toLowerCase();
  const mapped = KEY_SEQUENCES[key];
  if (mapped !== undefined) return mapped;
  if (/^ctrl-[a-z]$/.test(key)) return String.fromCharCode(key.charCodeAt(5) - 96);
  if (/^alt-[a-z]$/.test(key)) return `\x1b${key[4]}`;
  if (key.length === 1) return key;
  return undefined;
}

/**
 * Where a keystroke goes. A wrapper (`ThemeSelector`, `ShowImagesSelector`) can
 * own focus while having no `handleInput` of its own, with the real handler on
 * the list it wraps; a key sent to the wrapper would land nowhere. Falling
 * through to the contained input is the same delegation the terminal does.
 */
export function inputTargetOf(component: unknown): Record<string, unknown> | undefined {
  if (!component || typeof component !== "object") return undefined;
  const record = component as Record<string, unknown>;
  if (typeof record.handleInput === "function") return record;
  return findShape(record, isInteractiveShape, 2);
}

/** Deliver one named key to the component, or to the input it wraps. */
export function sendKeyTo(component: unknown, name: string): boolean {
  const sequence = keySequence(name);
  if (sequence === undefined) return false;
  const target = inputTargetOf(component);
  return target !== undefined && writeTextTo(target, sequence);
}

/** Deliver raw text (one character at a time is fine) to a component. */
export function writeTextTo(component: unknown, text: string): boolean {
  const handleInput = (component as Record<string, unknown> | undefined)?.handleInput;
  if (typeof handleInput !== "function") return false;
  try {
    handleInput.call(component, text);
    return true;
  } catch (err) {
    // The host's own handler threw on this key: the key did not land. Say so, so a refused
    // tap can be told apart from a key the component ignored.
    keysLog.debug("host handleInput threw", { err, ctor: (component as object).constructor?.name ?? "" });
    return false;
  }
}

/**
 * Replace the contents of a host `Input`: clear with ctrl+u, then type.
 * Returns false when nothing inside the component can be typed into.
 */
export function setInputValue(component: unknown, value: string): boolean {
  const target = inputTargetOf(component);
  if (!target) return false;
  if (!writeTextTo(target, "\x15")) return false; // ctrl+u
  for (const ch of value) {
    if (!writeTextTo(target, ch)) return false;
  }
  return true;
}
