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
 * Readable lines of the content area: `Text` text (theme colours stripped),
 * and the bare `url` of an `AuthUrlComponent` (or anything else exposing one).
 * Lines starting with "> " are submitted values the host echoed back -
 * possibly API keys - and are skipped here so no model can carry them out.
 * The key hints after an input or its echo are skipped too (see `keyHintIndexes`).
 */
function bodyLines(component: object): string[] {
  const children = contentChildren(component);
  if (!children) return [];
  const hints = keyHintIndexes(component, children);
  const lines: string[] = [];
  for (const [index, child] of children.entries()) {
    if (hints.has(index)) continue;
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
