/**
 * Adapter #10 - OMP's tool-approval dialog (§4.6.4).
 *
 * Two shapes of the same host dialog are read here.
 *
 * With a race handle on the entry (§4.12) the dialog is the built-in tool
 * approval behind a raced `ui.approve` call: the answers are the fixed
 * once/session/deny set the method resolves with, so the adapter never looks
 * at the screen.
 *
 * Without a handle the dialog is read from its own `describe()` tree (OMP
 * 18.14.1, `packages/tui/src/overlays/approval-dialog.ts`): the title, the
 * detail rows, the `omp.approval.choices` list the host offers (Approve, the
 * session grant when there is one, Deny, grants and the remember toggle), and
 * the Details button. Each choice is replayed through the list's own
 * `handleNativeEvent` as an `activate` event, so the host answers exactly as
 * its own row would. Nothing is answered with keys, and nothing is read off the
 * rendered frame.
 *
 * Typed text is not part of either dialog. It goes to the host composer as its
 * own native `send` event (`ctx.sendText`), the composer steers it, and the host
 * denies the waiting call with it. Keys are never simulated for it.
 */
import type { AdapterContext, DialogAdapter, DialogModel } from "../model.ts";
import { describableChild, findDescribedNode, tspText, type DescribedNode, type NativeNodeLike } from "./tsp.ts";

type Option = { key: string; label: string };
type Props = Record<string, unknown>;

const CHOICES_ROLE = "omp.approval.choices";
const DETAILS_ROLE = "omp.approval.details";
const TITLE_ROLE = "omp.approval.title";
const BUTTON_ROLE = "omp.btn";
const EXPAND_ACT = "expand";

const isProps = (value: unknown): value is Props => typeof value === "object" && value !== null;
const roleOf = (node: NativeNodeLike): string | undefined => (isProps(node.p) && typeof node.p.role === "string" ? node.p.role : undefined);

/** The text of a node's own text props, or of its text descendants, one run per line (never a render). */
function textLines(node: NativeNodeLike, depth = 0): string[] {
  if (depth > 12 || !isProps(node.p)) return [];
  if (node.k === "text") {
    const value = tspText(node.p.text) || tspText(node.p.spans);
    return value === "" ? [] : [value];
  }
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : [];
  return children.flatMap((child) => {
    if (!isProps(child) || describableChild(child)) return [];
    return textLines(child as NativeNodeLike, depth + 1);
  });
}

type DescribedChoice = { answer: string; label: string };

/** The dialog as it is described right now: every field the adapter reads, live (never cached). */
type DescribedApproval = {
  title?: string;
  details: string[];
  choices: DescribedChoice[];
  list: DescribedNode;
  expand?: DescribedNode;
  expandLabel: string;
};

function describedApproval(component: object): DescribedApproval | undefined {
  const list = findDescribedNode(component, (node) => node.k === "list" && roleOf(node) === CHOICES_ROLE);
  if (!list) return undefined;
  const items = Array.isArray(list.node.c) ? (list.node.c as unknown[]) : [];
  const choices: DescribedChoice[] = [];
  items.forEach((child, index) => {
    if (!isProps(child) || child.k !== "item" || !isProps(child.p)) return;
    const answer = child.key === undefined ? String(index) : String(child.key);
    const label = tspText(child.p.label).trim();
    if (answer !== "" && label !== "") choices.push({ answer, label });
  });
  const title = findDescribedNode(component, (node) => roleOf(node) === TITLE_ROLE);
  const details = findDescribedNode(component, (node) => roleOf(node) === DETAILS_ROLE);
  const expand = findDescribedNode(
    component,
    (node) => roleOf(node) === BUTTON_ROLE && isProps(node.p) && isProps(node.p.actions) && node.p.actions.click === EXPAND_ACT,
  );
  return {
    title: title ? textLines(title.node).join(" ").trim() || undefined : undefined,
    details: details ? textLines(details.node) : [],
    choices,
    list,
    ...(expand ? { expand } : {}),
    expandLabel: expand ? textLines(expand.node).join(" ").trim() || "Details" : "Details",
  };
}

/** The detail body Telegram shows: the prompt's first line, then the detail rows. */
function detailOf(described: DescribedApproval, redact: (text: string) => string): string | undefined {
  const lines = [described.title, ...described.details].filter((line): line is string => typeof line === "string" && line !== "");
  return lines.length > 0 ? redact(lines.join("\n")) : undefined;
}

/** The detail text of a raced prompt: the longest prompt the entry carried. */
function raceDetailOf(entry: { approval?: { full?: string; compact?: string; session?: string } }): string | undefined {
  const values = [entry.approval?.full, entry.approval?.compact, entry.approval?.session].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return values.length > 0 ? values.sort((a, b) => b.length - a.length).join("\n") : undefined;
}

/** The answers a raced `ui.approve` resolves with; the session row only when the prompt carries one. */
function raceOptions(entry: { approval?: { session?: string } }): Option[] {
  return [
    { key: "once", label: "Allow once" },
    ...(entry.approval?.session ? [{ key: "session", label: entry.approval.session }] : []),
    { key: "deny", label: "Deny" },
  ];
}

/** Replays one described node through its owner's `handleNativeEvent`, then asks for a redraw. */
function replay(owner: object, event: unknown, ctx: AdapterContext): boolean {
  const handle = (owner as { handleNativeEvent?: unknown }).handleNativeEvent;
  if (typeof handle !== "function") return false;
  try {
    handle.call(owner, event);
  } catch {
    return false;
  }
  try {
    ctx.requestRender();
  } catch {
    // A host without a live renderer has nothing to redraw; the answer landed.
  }
  return true;
}

/** The described dialog's answer for a key: a choice of its list, or its Details button. */
function describedAct(component: object, key: string, ctx: AdapterContext): boolean {
  const described = describedApproval(component);
  if (!described) return false;
  if (key === EXPAND_ACT) {
    if (!described.expand) return false;
    return replay(described.expand.owner, { type: "action", key: described.expand.keypath, act: EXPAND_ACT, mods: [] }, ctx);
  }
  const choice = described.choices.find((entry) => entry.answer === key);
  if (!choice) return false;
  return replay(described.list.owner, { type: "activate", key: described.list.keypath, item: choice.answer }, ctx);
}

export const approvalAdapter: DialogAdapter = {
  id: "omp-approval",

  detect(component, ctx) {
    if (ctx.entry?.kind === "approval" && ctx.entry.race !== undefined) return true;
    // Shape only: the choices list is what the host's approval dialog describes itself with.
    if (ctx.host !== "omp") return false;
    return describedApproval(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const entry = ctx.entry;
    const redact = ctx.redact ?? ((text: string) => text);
    if (entry?.race === undefined) {
      const described = describedApproval(component);
      if (!described) return { kind: "unsupported", title: entry?.title, what: entry?.method ?? "approval" };
      return {
        kind: "approval",
        title: entry?.title ?? "Tool approval",
        detail: detailOf(described, redact),
        options: [
          ...described.choices.map((choice) => ({ key: choice.answer, label: redact(choice.label) })),
          ...(described.expand ? [{ key: EXPAND_ACT, label: redact(described.expandLabel) }] : []),
        ],
      };
    }
    return {
      kind: "approval",
      title: entry.title ?? "Tool approval",
      detail: raceDetailOf(entry),
      options: raceOptions(entry),
    };
  },

  act(component, action, ctx) {
    // A typed message denies the call and becomes the next instruction: the host composer takes it as a steer (P2-39).
    if (action.type === "submit") {
      const text = action.text?.trim() ? action.text : undefined;
      return text !== undefined && ctx.sendText !== undefined && ctx.sendText(text);
    }
    const race = ctx.entry?.race;
    if (race === undefined) {
      if (action.type === "cancel") {
        // Escape in the host denies the call; the described Deny choice is that answer.
        return describedAct(component, "deny", ctx);
      }
      if (action.type === "approve") return describedAct(component, action.key, ctx);
      return false;
    }
    if (race.settled) return false;
    if (action.type === "cancel") {
      race.answer("deny");
      return true;
    }
    if (action.type === "approve" && (action.key === "once" || action.key === "session" || action.key === "deny")) {
      race.answer(action.key);
      return true;
    }
    return false;
  },
};
