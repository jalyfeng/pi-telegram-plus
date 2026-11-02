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

/** The dynamic content area; its children come and go with the auth step. */
function contentChildren(component: object): unknown[] | undefined {
  const record = component as HostRecord;
  const area = record.contentContainer;
  if (!area || typeof area !== "object") return undefined;
  const container = area as HostRecord;
  return Array.isArray(container.children) ? container.children : undefined;
}

/**
 * Index of the key-hint `Text` that pi prints right after the input, or -1.
 * login-dialog.js `showPrompt` and `showManualInput` add `this.input` and then
 * a `Text` such as "(escape/ctrl+c to cancel, enter to submit)": a terminal
 * key hint, meaningless on Telegram. Found by position next to the input
 * component, not by matching its words. With no input in the area (an
 * information page) nothing is skipped.
 */
function keyHintIndex(component: object, children: unknown[]): number {
  const input = (component as HostRecord).input;
  if (!input || typeof input !== "object") return -1;
  const at = children.indexOf(input);
  if (at < 0) return -1;
  const next = children[at + 1];
  return next && typeof next === "object" && typeof (next as HostRecord).text === "string" ? at + 1 : -1;
}

/**
 * Readable lines of the content area: `Text` text (theme colours stripped),
 * and the bare `url` of an `AuthUrlComponent` (or anything else exposing one).
 * Lines starting with "> " are submitted values the host echoed back -
 * possibly API keys - and are skipped here so no model can carry them out.
 * The key hint after the input is skipped too (see `keyHintIndex`).
 */
function bodyLines(component: object): string[] {
  const children = contentChildren(component);
  if (!children) return [];
  const hint = keyHintIndex(component, children);
  const lines: string[] = [];
  for (const [index, child] of children.entries()) {
    if (index === hint) continue;
    if (!child || typeof child !== "object") continue;
    const record = child as HostRecord;
    if (typeof record.url === "string" && record.url.length > 0) {
      lines.push(record.url);
      continue;
    }
    if (typeof record.text !== "string") continue;
    for (const raw of stripAnsi(record.text).split("\n")) {
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
    const lines = bodyLines(component);
    if (isAwaitingInput(component)) {
      return {
        kind: "input",
        title,
        placeholder: lines.length > 0 ? lines.join("\n") : undefined,
        secret: true,
      };
    }
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
