/**
 * Adapter P5: pi's `/login` dialog (`LoginDialogComponent`, pi 1.4.0). The
 * provider flow alternates between showing an OAuth URL / status text and
 * waiting for a typed value (device codes, and in practice API keys), and the
 * component says which half it is in: `inputResolver` is set only while
 * `showPrompt`/`showManualInput` waits for an answer.
 *
 * Everything the dialog asks for is treated as a secret (§4.6, D4): the
 * answer is likely a credential, so the model is always `secret: true` and
 * the "> <value>" line the host leaves behind after submit is never read
 * back into any model - the submitted text must not reach Telegram.
 */
import { stripAnsi } from "../../ansi.ts";
import { setInputValue } from "../keys.ts";
import type { DialogAdapter, DialogModel } from "../model.ts";
import { constructorName } from "./utils.ts";

type HostRecord = Record<string, unknown>;

/**
 * pi's public `keyHint`, resolved once at extension load (top-level await, as status-footer does) so that
 * `read` can stay synchronous. Under OMP the pi specifier may not load: then this stays undefined, and
 * `read` fails explicitly instead of guessing the hint text.
 */
const hostKeyHint: typeof import("@earendil-works/pi-coding-agent").keyHint | undefined = await import(
  "@earendil-works/pi-coding-agent",
).then(
  (mod) => mod.keyHint,
  () => undefined,
);

/**
 * The exact key-hint lines login-dialog.js prints as their own `Text` (with the outer parentheses), built with
 * the same `keyHint` calls and arguments. `keyHint` reads the live keybindings of this process, which are the
 * ones the host dialog read when it drew the line. Colours are stripped before comparing.
 */
function hostKeyHintLines(): Set<string> {
  if (!hostKeyHint) throw new Error("pi keyHint is unavailable: the login dialog's key hints cannot be matched");
  const cancel = hostKeyHint("tui.select.cancel", "to cancel");
  const cancelToSubmit = `${hostKeyHint("tui.select.cancel", "to cancel,")} ${hostKeyHint("tui.select.confirm", "to submit")}`;
  const close = hostKeyHint("tui.select.cancel", "to close");
  return new Set([`(${cancel})`, `(${cancelToSubmit})`, `(${close})`].map((line) => stripAnsi(line)));
}

/** The dynamic content area; its children come and go with the auth step. */
function contentChildren(component: object): unknown[] | undefined {
  const record = component as HostRecord;
  const area = record.contentContainer;
  if (!area || typeof area !== "object") return undefined;
  const container = area as HostRecord;
  return Array.isArray(container.children) ? container.children : undefined;
}

/** A `Text` pi writes for a submitted value: `replaceInputWithSubmittedText` puts `> value` where the input was. */
function isSubmittedEcho(child: unknown): boolean {
  const record = child as HostRecord | undefined;
  return !!record && typeof record === "object" && typeof record.text === "string" && record.text.startsWith("> ");
}

/**
 * Indexes of the key-hint `Text`s that pi prints right after an input, or after the echo of a submitted
 * input. login-dialog.js `showPrompt` and `showManualInput` add `this.input` and then a `Text` such as
 * "(escape/ctrl+c to cancel, enter to submit)": a terminal key hint, meaningless on Telegram. After a
 * submit the input is replaced by its `> value` echo and the hint stays right behind it. Found by
 * position next to the input or the echo, not by matching its words.
 */
function keyHintIndexes(component: object, children: unknown[]): Set<number> {
  const input = (component as HostRecord).input;
  const hints = new Set<number>();
  for (const [index, child] of children.entries()) {
    const anchored = (input !== undefined && child === input) || isSubmittedEcho(child);
    if (!anchored) continue;
    const next = children[index + 1];
    if (next && typeof next === "object" && typeof (next as HostRecord).text === "string") hints.add(index + 1);
  }
  return hints;
}

/**
 * The example line `showPrompt(message, placeholder)` adds: "e.g., <placeholder>" is a `Text` directly
 * before the input, and the message `Text` sits right before it. Without a placeholder the input follows
 * the message directly, after a Spacer. Found by position, not by matching its words.
 */
function hostPlaceholderIndex(component: object, children: unknown[]): number | undefined {
  const input = (component as HostRecord).input;
  if (input === undefined) return undefined;
  const at = children.indexOf(input);
  if (at < 2) return undefined;
  return isTextChild(children[at - 1]) && isTextChild(children[at - 2]) ? at - 1 : undefined;
}

function isTextChild(child: unknown): boolean {
  const record = child as HostRecord | undefined;
  return !!record && typeof record === "object" && typeof record.text === "string";
}

/**
 * Readable lines of the content area: `Text` text (theme colours stripped),
 * and the bare `url` of an `AuthUrlComponent` (or anything else exposing one).
 * Lines starting with "> " are submitted values the host echoed back -
 * possibly API keys - and are skipped here so no model can carry them out.
 * The key hints after an input or its echo are skipped too (see `keyHintIndexes`),
 * and so is the `skip` child, the host's placeholder line, which is not body.
 */
function bodyLines(component: object, skip?: number): string[] {
  const children = contentChildren(component);
  if (!children) return [];
  const hints = keyHintIndexes(component, children);
  const hintLines = hostKeyHintLines();
  const lines: string[] = [];
  for (const [index, child] of children.entries()) {
    if (hints.has(index) || index === skip) continue;
    if (!child || typeof child !== "object") continue;
    const record = child as HostRecord;
    if (typeof record.url === "string" && record.url.length > 0) {
      lines.push(record.url);
      continue;
    }
    if (typeof record.text !== "string") continue;
    const plainText = stripAnsi(record.text);
    // A Text that is exactly one of pi's own key-hint lines (e.g. "(to cancel)" on a waiting page).
    if (hintLines.has(plainText)) continue;
    for (const raw of plainText.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("> ")) continue;
      lines.push(line);
    }
  }
  return lines;
}

/** children[1] is the title `Text` (children[0] is the border). */
function dialogTitle(component: object): string {
  const record = component as HostRecord;
  const children = Array.isArray(record.children) ? record.children : [];
  const title = children[1];
  const titleText = title && typeof title === "object" ? title as HostRecord : undefined;
  const text = titleText && typeof titleText.text === "string" ? stripAnsi(titleText.text).trim() : "";
  return text.length > 0 ? text : "Login";
}

/** A set `inputResolver` is the component's own "waiting for typed input". */
const isAwaitingInput = (component: object): boolean => {
  const record = component as HostRecord;
  return record.inputResolver !== undefined && record.inputResolver !== null;
};

export const piLoginAdapter: DialogAdapter = {
  id: "pi-login",

  detect(component, ctx) {
    return ctx.host === "pi"
      && constructorName(component) === "LoginDialogComponent"
      && contentChildren(component) !== undefined;
  },

  read(component, _ctx): DialogModel {
    const title = dialogTitle(component);
    if (isAwaitingInput(component)) {
      // The message, the sign-in link and any instruction are the body (detail); only the host's
      // own example line is the placeholder.
      const children = contentChildren(component) ?? [];
      const example = hostPlaceholderIndex(component, children);
      const detail = bodyLines(component, example).join("\n");
      const placeholder = example === undefined ? undefined : stripAnsi(String((children[example] as HostRecord).text)).trim();
      return {
        kind: "input",
        title,
        detail: detail.length > 0 ? detail : undefined,
        placeholder: placeholder || undefined,
        secret: true,
      };
    }
    const lines = bodyLines(component);
    return { kind: "info", title, text: lines.join("\n") || "Continue in the terminal", closable: true };
  },

  act(component, action, ctx): boolean {
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "submit" || !action.text) return false;
    // Answering while nothing waits for an answer would type into a dialog
    // that has already moved on (or echoed the secret and stopped reading).
    if (!isAwaitingInput(component)) return false;
    const record = component as HostRecord;
    const input = record.input;
    if (!setInputValue(input, action.text)) return false;
    return ctx.sendKey("enter");
  },
};
