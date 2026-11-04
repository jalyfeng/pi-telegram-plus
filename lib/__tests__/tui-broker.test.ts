/**
 * DialogBroker behaviour (§4.5).
 *
 * The broker is the only place a Telegram tap or message turns into host input,
 * so these tests drive a hand-built focus view (the `FocusSource` seam) plus a
 * fake Bot API, and check what actually reaches each side: which chat the
 * dialog is mirrored to, which bytes reach `handleInput`, and what happens to
 * the message once somebody has answered.
 */
import { describe, expect, it, vi } from "vitest";
import { DialogBroker, EDIT_THROTTLE_MS, REFRESH_MS, textPurpose } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { DialogAction, DialogAdapter, DialogModel, EntryInfo } from "../tui/model.ts";
import type { TelegramTurn } from "../types.ts";
import type { CommandScope } from "../tui/origin.ts";
import { SecretStore } from "../tui/secrets.ts";

const turn = (chatId: number, sourceMessageId = 7): TelegramTurn => ({
  chatId,
  sourceMessageId,
  queuedAttachments: [],
});

function fakeTransport() {
  const sent: Array<{ chatId: number; text: string; rows: unknown[][] }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; rows: unknown[][] }> = [];
  const removed: number[] = [];
  const deleted: number[] = [];
  return {
    sent,
    edits,
    removed,
    deleted,
    sendButtons: async (chatId: number, text: string, rows: unknown[][]) => {
      sent.push({ chatId, text, rows });
      return { message_id: 100 + sent.length };
    },
    editButtons: async (chatId: number, messageId: number, text: string, rows: unknown[][]) => {
      edits.push({ chatId, messageId, text, rows });
    },
    sendText: async (chatId: number, text: string) => {
      sent.push({ chatId, text, rows: [] });
      return [{ message_id: 300 + sent.length }];
    },
    removeInlineKeyboard: async (_chatId: number, messageId: number) => {
      removed.push(messageId);
    },
    deleteMessage: async (_chatId: number, messageId: number) => {
      deleted.push(messageId);
    },
  };
}

/** A focus view the test drives by hand: the three members the broker reads. */
function fakeFocus(entry?: EntryInfo) {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  // Where the host's focus really is; `info` is what the tracker has reported so far.
  let live: object = editor;
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    current: () => info,
    entryFor: () => entry,
    /** A live read the tracker runs when it validates (§4.1.3); a difference is a focus change. */
    validate() {
      if (live === info.component) return;
      emit({ kind: live === editor ? "editor" : "dialog", component: live as Record<string, unknown>, source: "getter" });
    },
    /** The host moves focus without an event the tracker can see yet. */
    handOverSilently(component: Record<string, unknown>) {
      live = component;
    },
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      live = component;
      emit({ kind: "dialog", component, source: "event" });
    },
    closeToEditor() {
      live = editor;
      emit({ kind: "editor", component: editor, source: "event" });
    },
    emitProgress(component: Record<string, unknown>) {
      emit({ kind: "progress", component, source: "event" });
    },
  };
}

function makeBroker(options: {
  turns?: TelegramTurn[];
  entry?: EntryInfo;
  scope?: CommandScope;
  secrets?: SecretStore;
} = {}) {
  const transport = fakeTransport();
  const written: string[] = [];
  const focus = fakeFocus(options.entry);
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => options.scope, touch: () => undefined } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => options.turns ?? [],
    writeText: (text: string) => {
      written.push(text);
      return true;
    },
    secrets: options.secrets,
    enabled: () => true,
  });
  broker.start();
  return { broker, transport, written, focus };
}

/** A three-row selector shaped like pi's extension selector. */
function selector(focus: { closeToEditor: () => void }) {
  const keys: string[] = [];
  const component: Record<string, unknown> = {
    options: ["alpha", "beta", "gamma"],
    selectedIndex: 0,
    handleInput: (input: string) => {
      keys.push(input);
      // A real selector resolves on Enter and hands focus back to the editor.
      if (input === "\r") focus.closeToEditor();
    },
  };
  return { component, keys };
}

/** Flush the fire-and-forget Bot API calls; nothing here waits on the clock. */
const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

describe("dialog broker", () => {
  it("mirrors a host dialog onto the chat that owns the running turn", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.chatId).toBe(42);
    expect(transport.sent[0]?.text).toContain("beta");
    expect(transport.sent[0]?.rows.length).toBeGreaterThan(0);

    const session = broker.current();
    expect(session?.adapter?.id).toBe("ext-select");
    expect(session?.telegram).toEqual({ chatId: 42, messageThreadId: undefined, messageId: 101 });
    // Only the chat that can see the dialog routes its text to the session.
    expect(broker.sessionFor(42)).toBeDefined();
    expect(broker.sessionFor(7)).toBeUndefined();
    expect(session?.keyMap.get(0)?.get("0.1")).toBe("1:beta");
  });

  it("tracks a purely local dialog without touching Telegram", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(true);
    // No chat owns it, so no Telegram message may claim it.
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("announces a dialog Telegram cannot handle with only a cancel button", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const keys: string[] = [];
    const component: Record<string, unknown> = {
      render: () => "weird frame",
      handleInput: (input: string) => {
        keys.push(input);
      },
    };
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain("can't handle");
    // The frame itself is never mirrored, only named.
    expect(transport.sent[0]?.text).not.toContain("weird frame");
    const buttons = transport.sent[0]!.rows.flat() as Array<{ text: string }>;
    expect(buttons.map((button) => button.text)).toEqual(["Cancel"]);

    const session = broker.current();
    expect(session?.adapter?.id).toBe("unsupported");
    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "x",
    });
    await settle();

    expect(result).toEqual({ handled: true });
    expect(keys).toEqual(["\x1b"]);
  });

  it("gives a read-only panel a single close button", async () => {
    const { broker, transport, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "panel", source: "omp", title: "Status" },
    });
    const component: Record<string, unknown> = { children: [{ text: "session report text" }] };
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain("session report text");
    const buttons = transport.sent[0]!.rows.flat() as Array<{ text: string }>;
    expect(buttons.map((button) => button.text)).toEqual(["Close"]);
  });

  it("follows the dialog a tap opened inside the host call instead of redrawing the closed one", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const keysNext: string[] = [];
    const next: Record<string, unknown> = {
      options: ["x", "y"],
      selectedIndex: 0,
      handleInput: (input: string) => {
        keysNext.push(input);
      },
    };
    const keysFirst: string[] = [];
    // Shaped like pi's login selector: Enter answers, then the host shows the next list.
    const first: Record<string, unknown> = {
      options: ["alpha", "beta", "gamma"],
      selectedIndex: 0,
      handleInput: (input: string) => {
        keysFirst.push(input);
        if (input === "\r") focus.handOverSilently(next);
      },
    };
    focus.openDialog(first);
    await settle();

    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();
    broker.handleCallback(42, undefined, { sessionId: session?.id ?? "", generation: 0, op: "c", arg });
    await settle();

    expect(keysFirst).toEqual(["\x1b[B", "\r"]);
    expect(broker.current()?.focus).toBe(next);
    const shown = transport.sent.at(-1);
    expect(shown?.text).toContain("x");
    expect(JSON.stringify(shown?.rows)).toContain("y");
    expect(JSON.stringify(shown?.rows)).not.toContain("gamma");

    // The next tap is for the list on screen: it reaches that list, not the closed one.
    const nextSession = broker.current();
    const yArg = [...(nextSession?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:y")?.[0];
    expect(yArg).toBeDefined();
    broker.handleCallback(42, undefined, { sessionId: nextSession?.id ?? "", generation: 0, op: "c", arg: yArg });
    await settle();
    expect(keysNext).toEqual(["\x1b[B", "\r"]);
    expect(keysFirst).toHaveLength(2);
  });

  it("walks the host key path on a row tap and retires the message", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();

    // Cursor sits on alpha, so reaching beta is one arrow key plus Enter.
    expect(keys).toEqual(["\x1b[B", "\r"]);
    expect(result).toEqual({ handled: true });
    expect(broker.current()).toBeUndefined();
    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.text).toContain("beta");
    // The summary line keeps no keyboard.
    expect(transport.edits[0]?.rows).toEqual([]);
  });

  it("keeps the dialog's message when the overlay wrapper takes the focus", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // OMP hands focus to the overlay wrapper that holds the dialog; the wrapper is what
    // receives keys afterwards, but the user is still being asked the same question.
    const wrapper = {
      children: [component],
      render: () => "",
      handleInput: (input: string) => { keys.push(input); },
    };
    focus.openDialog(wrapper);
    await settle();

    // One question, one message: the handoff must not draw a second dialog nor retire
    // the first, or every keyboard already shown becomes a dead button.
    expect(transport.sent).toHaveLength(1);
    expect(broker.current()?.focus).toBe(wrapper);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();
    expect(result).toEqual({ handled: true });
    expect(keys).toEqual(["\x1b[B", "\r"]);
  });

  it("keeps the buttons already shown when only the terminal's cursor moved", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // The local user arrows down to gamma and the host repaints (focus flickers to the
    // spinner and back). The cursor mark sits inside the button labels, but no button's
    // meaning changed, so the keyboard the chat is looking at must still work.
    component.selectedIndex = 2;
    focus.emitProgress({});
    focus.openDialog(component);
    await settle();

    expect(session?.generation).toBe(0);
    expect(transport.sent).toHaveLength(1);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();

    expect(result).toEqual({ handled: true });
    // gamma is marked now, so beta is reached by walking up from it and pressing Enter.
    expect(keys).toEqual(["\x1b[A", "\r"]);
  });

  it("redraws instead of acting when the callback is stale", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 7,
      op: "c",
      arg: "0.1",
    });
    await settle();

    expect(result.toast).toContain("The list changed");
    expect(keys).toEqual([]);
    expect(broker.hasActive()).toBe(true);
  });

  it("feeds typed text to the dialog's input and hides a secret answer", async () => {
    const { broker, transport, written, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "input", title: "Paste the token", secret: true, source: "pi" },
    });
    const keys: string[] = [];
    const component: Record<string, unknown> = {
      getValue: () => "",
      handleInput: (input: string) => keys.push(input),
    };
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    expect(session?.adapter?.id).toBe("ext-input");
    expect(broker.waitsForText(42)).toBe(true);

    const result = broker.handleText(session!, "hunter2", 55);
    await settle();

    expect(result.handled).toBe(true);
    // The answer is typed into the component's own field rather than written
    // blind to the terminal, which also keeps the secret out of a raw keystroke
    // stream shared with the editor.
    expect(written).toEqual([]);
    expect(keys).toEqual(["\x15", ..."hunter2", "\r"]);
    // The answer was a secret: the raw message is deleted, not just ignored.
    expect(transport.deleted).toContain(55);
    expect(session?.pendingInput).toBeUndefined();

    // The input still owns the keyboard, so a second message is still dialog
    // input. The dialog still shows a secret field, so a retry is a secret too.
    const followUp = broker.handleText(session!, "again", 56);
    await settle();
    expect(followUp.handled).toBe(true);
    expect(written).toEqual([]);
    expect(transport.deleted).toEqual([55, 56]);
  });

  it("does not hide a message once the redrawn input is no longer secret", async () => {
    const secrets = new SecretStore();
    const remember = vi.spyOn(secrets, "remember");
    const { broker, transport, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "input", title: "Paste your API key", secret: true, source: "pi" },
      secrets,
    });
    focus.openDialog({ getValue: () => "", handleInput: () => undefined });
    await settle();
    const session = broker.current()!;
    expect(broker.handleText(session, "sk-test-123", 57)).toEqual({ handled: true });
    await settle();
    expect(transport.deleted).toEqual([57]);
    expect(remember).toHaveBeenCalledTimes(1);

    // The host redraws the same dialog as a plain (non-secret) input, and the
    // marker is gone after the answer, so the model alone decides.
    session.model = { kind: "input", title: "Paste your API key", secret: false };
    expect(broker.handleText(session, "plain-text", 58)).toEqual({ handled: true });
    await settle();
    expect(transport.deleted).toEqual([57]);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("deletes and remembers a secret answer when the secret input appeared after the dialog opened", async () => {
    // A progress panel opened the dialog, so no `pendingInput` marker was set; the
    // redraw that added the secret field never sets one either.
    const secrets = new SecretStore();
    const remember = vi.spyOn(secrets, "remember");
    const { broker, transport, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "input", title: "Paste your API key", secret: true, source: "pi" },
      secrets,
    });
    focus.openDialog({ getValue: () => "", handleInput: () => undefined });
    await settle();
    const session = broker.current()!;
    session.pendingInput = undefined;

    const result = broker.handleText(session, "sk-test-123", 4242);
    await settle();

    expect(result).toEqual({ handled: true });
    expect(transport.deleted).toContain(4242);
    expect(remember).toHaveBeenCalled();
  });

  it("keeps a plain answer when the input that appeared after the dialog opened is not secret", async () => {
    const secrets = new SecretStore();
    const remember = vi.spyOn(secrets, "remember");
    const { broker, transport, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "input", title: "Paste your API key", secret: false, source: "pi" },
      secrets,
    });
    focus.openDialog({ getValue: () => "", handleInput: () => undefined });
    await settle();
    const session = broker.current()!;
    session.pendingInput = undefined;

    const result = broker.handleText(session, "plain-text", 4243);
    await settle();

    expect(result).toEqual({ handled: true });
    expect(transport.deleted).toEqual([]);
    expect(remember).not.toHaveBeenCalled();
  });

  it("cancels the dialog before /stop interrupts anything", async () => {
    const { broker, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(broker.cancelFor(42)).toBe(true);
    expect(keys).toEqual(["\x1b"]);
    expect(broker.hasActive()).toBe(false);
  });

  it("reports a terminal-side answer and drops the keyboard", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    // The terminal user picks a row: focus leaves before Telegram ever taps.
    focus.closeToEditor();
    await settle();

    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.text).toContain("Answered in the terminal");
    expect(broker.current()).toBeUndefined();
    // A late tap on the dead keyboard must not reach the host.
    const result = broker.handleCallback(42, undefined, { sessionId: "gone", generation: 0, op: "c", arg: "0.1" });
    expect(result).toEqual({ handled: true, toast: "Answered in the terminal", clear: true });
  });

  it("attributes a Telegram Cancel to Telegram when the host closes the dialog after the tap", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const keys: string[] = [];
    const component: Record<string, unknown> = {
      render: () => "weird frame",
      handleInput: (input: string) => {
        keys.push(input);
        // The host handles Esc later, so the close is observed after the tap has returned.
        if (input === "\x1b") queueMicrotask(() => focus.closeToEditor());
      },
    };
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    broker.handleCallback(42, undefined, { sessionId: session?.id ?? "", generation: 0, op: "x" });
    await settle();

    expect(keys).toEqual(["\x1b"]);
    expect(transport.edits.at(-1)?.text).toContain("✖ Cancelled");
    expect(transport.edits.at(-1)?.text).not.toContain("Answered in the terminal");
  });

  it("mirrors a dialog onto the chat whose command scope is running", async () => {
    // No Telegram turn is active: only the running command scope can tie this
    // dialog to a chat, and it draws on the ack message the scope carries.
    const scope = {
      id: "s1",
      origin: { chatId: 7, messageThreadId: 3, sourceMessageId: 21 },
      telegramMessageId: 555,
      ended: false,
    } as unknown as CommandScope;
    const { broker, transport, focus } = makeBroker({ scope });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.chatId).toBe(7);
    expect(transport.edits[0]?.messageId).toBe(555);
    // The scope wins over the chat the user last touched.
    expect(broker.sessionFor(7, 3)).toBeDefined();
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("does not open a session for a progress panel", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    // A spinner takes the keyboard only so Esc can interrupt: drawing a keyboard for
    // it would put a message in the chat before the real dialog has even opened, and
    // that message then swallows whatever the user types for the dialog.
    focus.emitProgress({ deps: {}, handleInput: () => undefined });
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(false);
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("keeps a dialog answerable while a progress panel holds the keyboard", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // The host focuses its spinner so Esc can interrupt the turn. The question behind it is
    // still open, so withdrawing the keyboard here would strand a message the user can no
    // longer answer - the OMP ask dialog loses exactly this way.
    focus.emitProgress({ deps: {}, handleInput: () => undefined });
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.edits).toHaveLength(0);
    expect(broker.current()).toBe(session);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();
    expect(result).toEqual({ handled: true });
    expect(keys).toEqual(["\x1b[B", "\r"]);
  });

  it("refuses to answer a dialog this chat was never shown", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(broker.hasActive()).toBe(true);

    // The terminal opened this question and nobody in this chat was ever shown it (§4.3 rule 3).
    // The host queues every later command behind it, so the arriving command is refused with an
    // explanation; the broker must not press Esc on a question this chat does not own.
    expect(broker.abandonFor(42)).toEqual({ kind: "blocked", title: "Pick env" });
    await settle();

    expect(keys).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(true);
    // Still blocked: nothing was answered, so the next command is refused the same way.
    expect(broker.abandonFor(42)).toEqual({ kind: "blocked", title: "Pick env" });
  });

  it("leaves an abandoned message for the command that arrived", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Bot name",
      options: ["work", "home"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent).toHaveLength(1);

    expect(broker.abandonFor(42)).toEqual({ kind: "closed", title: "Bot name" });
    await settle();

    // The command that arrived draws its own answer on this very message (one scope, one
    // message), so the broker strips the dead keyboard and writes nothing over the text.
    expect(transport.edits).toHaveLength(0);
    expect(transport.removed).toEqual([101]);
    expect(broker.current()).toBeUndefined();
  });

  it("quietly retires a dialog the host already closed", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent).toHaveLength(1);

    // The terminal answered. A command arriving afterwards must not press Esc again or claim
    // that it closed a question - the notice would land where the command's own answer goes.
    focus.closeToEditor();
    await settle();
    expect(broker.abandonFor(42)).toEqual({ kind: "nothing" });
    await settle();

    expect(keys).toEqual([]);
    // The only edit is the "answered in the terminal" line the close itself writes.
    expect(transport.edits).toHaveLength(1);
    expect(broker.current()).toBeUndefined();
  });

  it("leaves another chat's dialog alone when this one sends a command", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(7)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent[0]?.chatId).toBe(7);

    // Not this chat's question: no Esc, no keyboard taken away, and the arriving command is
    // refused instead of queued behind a dialog it may not answer.
    expect(broker.abandonFor(42).kind).toBe("blocked");
    await settle();

    expect(keys).toEqual([]);
    expect(transport.removed).toEqual([]);
    expect(broker.hasActive()).toBe(true);
  });
});

describe("background refresh of an open dialog", () => {
  // The host can fill a dialog in *after* drawing it: pi's `/resume` "show all"
  // renders an empty list and loads the sessions behind it, and no Telegram event
  // or focus change fires for that. The broker's own poll has to notice, or the
  // chat sits on a stale frame until the user taps something.

  /** A selector whose option reads are counted, so "re-read?" is observable. */
  function countingSelector() {
    let options = ["alpha", "beta"];
    let reads = 0;
    const component: Record<string, unknown> = {
      selectedIndex: 0,
      handleInput: () => undefined,
    };
    Object.defineProperty(component, "options", {
      get() {
        reads += 1;
        return options;
      },
      set(next: string[]) {
        options = next;
      },
    });
    return { component, reads: () => reads, setOptions: (next: string[]) => { options = next; } };
  }

  it("edits the mirrored dialog when the host loads new options in the background", async () => {
    vi.useFakeTimers();
    try {
      const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
      const { component } = selector(focus);
      focus.openDialog(component);
      await settle();
      expect(transport.sent).toHaveLength(1);

      component.options = ["alpha", "beta", "gamma", "delta"];
      vi.advanceTimersByTime(REFRESH_MS);
      await settle();

      expect(transport.edits).toHaveLength(1);
      expect(JSON.stringify(transport.edits[0]?.rows)).toContain("delta");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the poll silent while the dialog has not changed", async () => {
    vi.useFakeTimers();
    try {
      const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
      const { component } = selector(focus);
      focus.openDialog(component);
      await settle();
      expect(transport.sent).toHaveLength(1);

      vi.advanceTimersByTime(REFRESH_MS * 4);
      await settle();

      expect(transport.edits).toHaveLength(0);
      expect(transport.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never re-reads a dialog that was never mirrored", async () => {
    vi.useFakeTimers();
    try {
      // No turn, no scope: a purely local dialog (§4.3 rule 3) - tracked, but the
      // poll has no chat to keep in step.
      const { broker, focus } = makeBroker();
      const dialog = countingSelector();
      focus.openDialog(dialog.component);
      await settle();
      expect(broker.hasActive()).toBe(true);

      const reads = dialog.reads();
      dialog.setOptions(["alpha", "beta", "gamma"]);
      vi.advanceTimersByTime(REFRESH_MS * 3);
      await settle();

      expect(dialog.reads()).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-reading once stop() has run", async () => {
    vi.useFakeTimers();
    try {
      const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
      const dialog = countingSelector();
      focus.openDialog(dialog.component);
      await settle();
      expect(transport.sent).toHaveLength(1);

      broker.stop();
      const reads = dialog.reads();
      dialog.setOptions(["alpha", "beta", "gamma"]);
      vi.advanceTimersByTime(REFRESH_MS * 3);
      await settle();

      expect(dialog.reads()).toBe(reads);
      expect(transport.edits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("page reset when a dialog swaps in a different list", () => {
  // S2: OMP's `/model` list spans pages; tapping a model turns the same dialog
  // into the "Assign ... to" list. The terminal starts that new list at its
  // first item - the chat must not stay parked on the old page.

  /** A 25-option selector = 3 pages of 10, shaped like pi's extension selector. */
  function pagedSelector(): Record<string, unknown> {
    return {
      baseTitle: "Models",
      options: Array.from({ length: 25 }, (_, index) => `mock-model-${index}`),
      selectedIndex: 0,
      handleInput: () => undefined,
    };
  }

  /** Open the dialog and tap "Next" once, so the chat sits on page 2. */
  async function openOnPage2() {
    const harness = makeBroker({ turns: [turn(42)] });
    const component = pagedSelector();
    harness.focus.openDialog(component);
    await settle();
    const session = harness.broker.current();
    harness.broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: session?.generation ?? 0,
      op: "p",
      arg: "1",
    });
    await settle();
    expect(transportText(harness.transport)).toContain("Page 2/3");
    return { ...harness, component };
  }

  const transportText = (transport: { edits: Array<{ text: string }> }) =>
    transport.edits[transport.edits.length - 1]?.text ?? "";

  it("draws the first page when the dialog swaps in a different list", async () => {
    vi.useFakeTimers();
    try {
      const { broker, transport, component } = await openOnPage2();

      // The same component becomes the "Assign ... to" list: new title, new options.
      component.baseTitle = "Assign mock-model-2 to";
      component.options = ["default", "smol"];
      vi.advanceTimersByTime(REFRESH_MS);
      await settle();

      const last = transport.edits[transport.edits.length - 1];
      expect(broker.current()?.page).toBe(0);
      expect(last?.text).toContain("Assign mock-model-2 to");
      expect(last?.text).toContain("Page 1/1 · 2 items");
      expect(last?.text).toContain("default");
      // No navigation left on a one-page list: the user never sees "◀ Prev".
      expect(JSON.stringify(last?.rows)).not.toContain("Prev");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the page when the same list only moves its cursor", async () => {
    vi.useFakeTimers();
    try {
      const { transport, component } = await openOnPage2();

      // Same kind, same title, same keys: only the terminal cursor moved onto
      // an item of the page the chat is already showing.
      component.selectedIndex = 11;
      vi.advanceTimersByTime(REFRESH_MS);
      await settle();

      const last = transport.edits[transport.edits.length - 1];
      expect(last?.text).toContain("Page 2/3");
      expect(last?.text).toContain("mock-model-11");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("textPurpose for settings submenus", () => {
  const settings = (extra: Partial<Extract<DialogModel, { kind: "settings" }>> = {}): DialogModel => ({
    kind: "settings",
    title: "Settings",
    items: [],
    ...extra,
  });
  const inputModel: DialogModel = { kind: "input", title: "Name", secret: false };
  const multiModel: DialogModel = { kind: "select", title: "Languages", items: [], total: 0, multi: true };

  it("routes typed text to a submenu input", () => {
    expect(textPurpose(settings({ submenu: { itemKey: "name", model: inputModel } }))).toBe("input");
  });

  it("lets the open submenu override the search box: a multi-select takes no text", () => {
    expect(textPurpose(settings({ search: { query: "the" }, submenu: { itemKey: "langs", model: multiModel } }))).toBeUndefined();
  });

  it("keeps search the purpose while no submenu is open, and plain settings take no text", () => {
    expect(textPurpose(settings({ search: { query: "" } }))).toBe("search");
    expect(textPurpose(settings())).toBeUndefined();
  });
});

describe("who closed a dialog and what they tapped", () => {
  /**
   * A dialog whose model and actions the test scripts: the adapter is swapped in after the
   * session opens, and `closesOn` decides which action the host answers by closing the dialog.
   */
  async function scripted(model: DialogModel, closesOn: (action: DialogAction) => boolean) {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog({});
    await settle();
    const session = broker.current()!;
    const acts: string[] = [];
    const adapter: DialogAdapter = {
      id: "scripted",
      detect: () => true,
      read: () => model,
      act: (_component, action) => {
        acts.push(action.type);
        if (closesOn(action)) focus.closeToEditor();
        return true;
      },
    };
    session.adapter = adapter;
    session.model = model;
    return { broker, transport, focus, session, acts };
  }

  const lastText = (transport: { edits: Array<{ text: string }> }) => transport.edits.at(-1)?.text ?? "";

  it("counts a typed answer sent from Telegram as Telegram's, not the terminal's", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { broker, transport, focus, session } = await scripted(
        { kind: "input", title: "Paste your API key", secret: false },
        () => false,
      );
      expect(broker.handleText(session, "sk-test-123", 57)).toEqual({ handled: true });
      await settle();
      // The redraw after the typed answer uses the edit throttle; let it pass before the host closes.
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
      focus.closeToEditor();
      await settle();

      expect(lastText(transport)).toContain("✅ Sent an answer");
      expect(lastText(transport)).not.toContain("Answered in the terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a typed answer as Telegram's even when the host closes the dialog during the write", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog({});
    await settle();
    const session = broker.current()!;
    // The host closes the dialog synchronously inside the submit, before handleText returns.
    const model: DialogModel = { kind: "input", title: "Paste your API key", secret: false };
    session.adapter = {
      id: "scripted",
      detect: () => true,
      read: () => model,
      act: (_component, action) => {
        if (action.type === "submit") focus.closeToEditor();
        return true;
      },
    };
    session.model = model;

    expect(broker.handleText(session, "sk-test-123", 57)).toEqual({ handled: true });
    await settle();

    expect(lastText(transport)).toContain("✅ Sent an answer");
    expect(lastText(transport)).not.toContain("Answered in the terminal");
  });

  it("ends a tab or scope tap with its label, not the marker the host draws on the active one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const picker: DialogModel = { kind: "select", title: "Sessions", items: [{ key: "a", label: "alpha" }], total: 1, extraActions: [{ label: "All", mark: "● ", key: "scope:2" }] };
      const { broker, transport, focus, session } = await scripted(picker, () => false);
      session.keyMap.set(session.generation, new Map([["scope:2", "scope:2"]]));
      broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "k", arg: "scope:2" });
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
      focus.closeToEditor();
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);

      expect(lastText(transport)).toContain("✅ All");
      expect(lastText(transport)).not.toContain("●");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not echo a plain input's typed text into the closing summary", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { broker, transport, focus, session } = await scripted(
        { kind: "input", title: "Paste your API key", secret: false },
        () => false,
      );
      expect(broker.handleText(session, "sk-test-123", 57)).toEqual({ handled: true });
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
      focus.closeToEditor();
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);

      expect(lastText(transport)).toContain("✅ Sent an answer");
      expect(lastText(transport)).not.toContain("sk-test-123");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the terminal closed the dialog when the Telegram tap moved it to another list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { broker, transport, focus, session } = await scripted(
        { kind: "confirm", title: "Delete session?" },
        () => false,
      );
      // The tap returns the host to a list the terminal user is still looking at: the dialog changed.
      let current: DialogModel = { kind: "confirm", title: "Delete session?" };
      session.adapter = {
        id: "scripted",
        detect: () => true,
        read: () => current,
        act: () => {
          current = { kind: "select", title: "Sessions", items: [], total: 0 };
          return true;
        },
      };
      broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "n" });
      await settle();
      // The dialog then says something new on its own, and the next draw shows it.
      current = { kind: "select", title: "Other sessions", items: [], total: 0 };
      focus.openDialog(session.focus as Record<string, unknown>);
      await settle();
      vi.setSystemTime(Date.now() + 2_000);
      focus.closeToEditor();
      await settle();

      expect(lastText(transport)).toContain("Answered in the terminal");
      expect(lastText(transport)).not.toContain("✅");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs OMP's /share loader as a progress wait: no line when the host ends it, Cancelled when Telegram cancels", async () => {
    // OMP's BorderedLoader shape (bordered-loader.ts): a signal Escape aborts through, and a describe tree.
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
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog(new Zq() as unknown as Record<string, unknown>);
    await settle();
    const session = broker.current();
    // The minified class name is no clue: the structure selects the panel adapter, which reads the wait.
    expect(session?.adapter?.id).toBe("info-panel");
    expect(session?.model).toEqual({ kind: "progress", text: "Sharing session...", cancellable: true });
    focus.closeToEditor();
    await settle();
    expect(transport.edits.filter((entry) => entry.text.includes("Answered in the terminal"))).toEqual([]);
    expect(transport.deleted).toHaveLength(1);
  });

  it("says Cancelled when Telegram cancels OMP's /share loader", async () => {
    class Zq {
      render(): string[] {
        return [];
      }
      handleInput(): void {}
      get signal(): AbortSignal {
        return new AbortController().signal;
      }
      describe() {
        return { k: "card", p: { role: "omp.hook.loader" }, c: [{ k: "spinner", p: { label: [{ t: "Sharing session..." }] } }] };
      }
    }
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog(new Zq() as unknown as Record<string, unknown>);
    await settle();
    const session = broker.current()!;
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "x" });
    // The loader's Escape handler aborts it, and the host closes it after the tap.
    focus.closeToEditor();
    await settle();
    expect(lastText(transport)).toContain("✖ Cancelled");
  });

  it("writes no closing line for an unsupported dialog the terminal closes", async () => {
    const { transport, focus } = await scripted(
      { kind: "unsupported", title: "Something new", what: "a panel with no readable content" },
      () => false,
    );
    focus.closeToEditor();
    await settle();

    expect(transport.edits.filter((entry) => entry.text.includes("Answered in the terminal"))).toEqual([]);
  });

  it("writes no closing line when the host ends a progress wait (e.g. /share uploading)", async () => {
    const { transport, focus, session } = await scripted(
      { kind: "progress", text: "Sharing session...", cancellable: true },
      () => false,
    );
    focus.closeToEditor();
    await settle();

    expect(transport.edits.filter((entry) => entry.text.includes("Answered in the terminal"))).toEqual([]);
    expect(transport.deleted).toEqual([session.telegram?.messageId]);
  });

  it("writes nothing into a running command scope when the host ends a progress wait", async () => {
    const scope = {
      id: "s2",
      origin: { chatId: 7, messageThreadId: 3, sourceMessageId: 21 },
      telegramMessageId: 555,
      ended: false,
      dialogSummaries: [] as string[],
    } as unknown as CommandScope;
    const { broker, focus } = makeBroker({ scope });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current()!;
    const progress: DialogModel = { kind: "progress", text: "Sharing session...", cancellable: true };
    session.adapter = {
      id: "scripted",
      detect: () => true,
      read: () => progress,
      act: () => true,
    };
    session.model = progress;
    // The opening select made the dialog interactive; a loader never shows an answer, so clear that.
    session.interactive = false;
    focus.closeToEditor();
    await settle();

    expect(scope.dialogSummaries).toEqual([]);
  });

  it("keeps the line of a dialog Telegram answered when the same command's next dialog replaces it", async () => {
    const scope = {
      id: "s4",
      origin: { chatId: 7, messageThreadId: 3, sourceMessageId: 21 },
      telegramMessageId: 555,
      ended: false,
      dialogSummaries: [] as string[],
    } as unknown as CommandScope;
    const { broker, focus } = makeBroker({ scope });
    focus.openDialog({});
    await settle();
    const session = broker.current()!;
    const model: DialogModel = {
      kind: "select",
      title: "Login",
      items: [{ key: "a", label: "A" }],
      total: 1,
      extraActions: [{ label: "Paste code (mock)", key: "act:0" }],
    };
    // The host opens the next dialog (OMP's OAuth sheet) inside the tap, as a selector does on Enter.
    session.adapter = {
      id: "scripted",
      detect: () => true,
      read: () => model,
      act: () => {
        focus.openDialog(selector(focus).component);
        return true;
      },
    };
    session.model = model;
    broker.handleCallback(7, 3, { sessionId: session.id, generation: 0, op: "k", arg: "act:0" });
    await settle();

    expect(scope.dialogSummaries).toEqual(["✅ Paste code (mock)"]);
  });

  it("writes no line for a dialog nobody answered when the same command's next dialog replaces it", async () => {
    const scope = {
      id: "s5",
      origin: { chatId: 7, messageThreadId: 3, sourceMessageId: 21 },
      telegramMessageId: 555,
      ended: false,
      dialogSummaries: [] as string[],
    } as unknown as CommandScope;
    const { broker, focus } = makeBroker({ scope });
    focus.openDialog(selector(focus).component);
    await settle();
    expect(broker.current()).toBeDefined();

    focus.openDialog(selector(focus).component);
    await settle();

    expect(scope.dialogSummaries).toEqual([]);
  });

  it("writes Cancelled when Telegram cancels a progress wait", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "progress", text: "Sharing session...", cancellable: true },
      () => true,
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "x" });
    await settle();

    expect(lastText(transport)).toContain("✖ Cancelled");
    expect(lastText(transport)).not.toContain("Answered in the terminal");
  });

  it("names the button a key tap pressed, not its internal id", async () => {
    const { broker, transport, session } = await scripted(
      {
        kind: "select",
        title: "Login",
        items: [{ key: "a", label: "A" }],
        total: 1,
        extraActions: [{ label: "Sign in", key: "act:0" }],
      },
      (action) => action.type === "key",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "k", arg: "act:0" });
    await settle();

    expect(lastText(transport)).toContain("✅ Sign in");
    expect(lastText(transport)).not.toContain("act:0");
  });

  it("names a confirm's Yes button as the button the user pressed", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "confirm", title: "Delete session?" },
      (action) => action.type === "confirm",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "y" });
    await settle();

    expect(lastText(transport)).toContain("✅ Yes");
    expect(lastText(transport)).not.toContain("Confirm");
  });

  it("uses the host's own confirm label when the confirm names one", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "confirm", title: "Delete session?", confirmLabel: "Delete", cancelLabel: "Keep" },
      (action) => action.type === "confirm",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "y" });
    await settle();

    expect(lastText(transport)).toContain("✅ Delete");
  });

  it("closes a choice with the picked label alone, trimmed and without a Choose prefix", async () => {
    const { broker, transport, session } = await scripted(
      {
        kind: "select",
        title: "Model",
        items: [{ key: "full", label: "  full   access " }],
        total: 1,
      },
      (action) => action.type === "choose",
    );
    // The scripted model was never drawn, so its row buttons are not in the key map yet.
    session.keyMap.set(0, new Map([["0.0", "full"]]));
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "c", arg: "0.0" });
    await settle();

    expect(lastText(transport)).toContain("✅ full access");
    expect(lastText(transport)).not.toContain("Choose");
  });

  it("closes a toggle with the row and the state the tap set", async () => {
    const { broker, transport, session } = await scripted(
      {
        kind: "select",
        title: "Tools",
        multi: true,
        items: [{ key: "bash", label: "bash", checked: false }],
        total: 1,
      },
      (action) => action.type === "toggle",
    );
    session.keyMap.set(0, new Map([["0.0", "bash"]]));
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "t", arg: "0.0" });
    await settle();

    expect(lastText(transport)).toContain("✅ bash: on");
    expect(lastText(transport)).not.toContain("Toggle");
  });

  it("closes a hidden answer as Submitted (hidden) even after the dialog turned into progress", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
      focus.openDialog({});
      await settle();
      const session = broker.current()!;
      let current: DialogModel = { kind: "input", title: "Paste your API key", secret: true };
      session.adapter = {
        id: "scripted",
        detect: () => true,
        read: () => current,
        act: (_component, action) => {
          // The host starts signing in: the same dialog now shows progress, not a secret field.
          if (action.type === "submit") current = { kind: "progress", text: "Signing in", cancellable: false };
          return true;
        },
      };
      session.model = current;

      expect(broker.handleText(session, "sk-secret", 57)).toEqual({ handled: true });
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
      focus.closeToEditor();
      await settle();

      expect(lastText(transport)).toContain("✅ Submitted (hidden)");
      expect(lastText(transport)).not.toContain("Sent an answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a login that moved from its key prompt to an information page as Submitted (hidden), not Closed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
      focus.openDialog({});
      await settle();
      const session = broker.current()!;
      // pi's login: a key prompt, then the same dialog shows an information page (pi-login's `info`).
      let current: DialogModel = { kind: "input", title: "Paste your API key", secret: true };
      session.adapter = {
        id: "scripted",
        detect: () => true,
        read: () => current,
        act: (_component, action) => {
          if (action.type === "submit") current = { kind: "info", title: "Login to acme", text: "Signing in", closable: true };
          return true;
        },
      };
      session.model = current;

      expect(broker.handleText(session, "sk-secret", 57)).toEqual({ handled: true });
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
      focus.closeToEditor();
      await settle();

      expect(lastText(transport)).toContain("✅ Submitted (hidden)");
      expect(lastText(transport)).not.toContain("✖ Closed");
      expect(lastText(transport)).not.toContain("Signing in");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a Cancel tap as Cancelled even when the host closes the dialog during the tap", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "select", title: "Tool", items: [{ key: "a", label: "A" }], total: 1 },
      (action) => action.type === "cancel",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "x" });
    await settle();

    expect(lastText(transport)).toContain("✖ Cancelled");
    expect(lastText(transport)).not.toContain("✅");
  });

  it("closes a confirm's No as an answer, not as a cancel", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "confirm", title: "Delete session?" },
      (action) => action.type === "confirm",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "n" });
    await settle();

    expect(lastText(transport)).toContain("✅ No");
    expect(lastText(transport)).not.toContain("Cancelled");
  });

  it("declines a confirm that names only its confirm button with No, not Cancel", async () => {
    const { broker, transport, session } = await scripted(
      { kind: "confirm", title: "Delete session?", confirmLabel: "Delete" },
      (action) => action.type === "confirm",
    );
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "n" });
    await settle();

    expect(lastText(transport)).toContain("✅ No");
    expect(lastText(transport)).not.toContain("Cancel");
  });
});

describe("a read-only panel that closes keeps the page it showed", () => {
  const panelModel: DialogModel = {
    kind: "info",
    title: "Recent Changes",
    text: "<b>1.2.0</b> fixed the thing",
    html: true,
    closable: false,
    actions: [{ label: "Close", key: "close" }],
  };

  /** A panel drawn on the chat, with its own Close button mapped to the key the renderer would use. */
  async function openedPanel(model: DialogModel) {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog({});
    await settle();
    const session = broker.current()!;
    session.adapter = {
      id: "scripted",
      detect: () => true,
      read: () => model,
      act: (_component, action) => {
        if (action.type === "choose" || action.type === "cancel") focus.closeToEditor();
        return true;
      },
    };
    session.model = model;
    session.keyMap.set(session.generation, new Map([["close", "close"], ...(model.kind === "info" ? (model.actions ?? []).map((action) => [action.key, action.key] as [string, string]) : [])]));
    return { broker, transport, focus, session };
  }

  const lastEdit = (transport: { edits: Array<{ text: string; rows: unknown[][] }> }) => transport.edits.at(-1);

  it("keeps the page and ends with a Closed line when Telegram closes it", async () => {
    const { broker, transport, session } = await openedPanel(panelModel);

    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "c", arg: "close" });
    await settle();

    const edit = lastEdit(transport);
    expect(edit?.text).toContain("Recent Changes");
    expect(edit?.text).toContain("<b>1.2.0</b> fixed the thing");
    expect(edit?.text).toContain("✖ Closed");
    expect(edit?.text).not.toContain("✅");
    expect(edit?.text).not.toContain("Answered in the terminal");
    expect(edit?.rows).toEqual([]);
  });

  it("says the action a panel button ran, and drops the panel text, when the host closes it", async () => {
    const actionModel: DialogModel = {
      kind: "info",
      title: "Debug",
      text: "Pick a report to run.",
      closable: true,
      actions: [{ key: "view:system", label: "View: system info" }],
    };
    const { broker, transport, session } = await openedPanel(actionModel);
    // The host runs the report and closes the panel inside the tap.
    expect(broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "c", arg: "view:system" })).toEqual({ handled: true });
    await settle();

    expect(lastEdit(transport)?.text).toContain("✅ View: system info");
    expect(lastEdit(transport)?.text).not.toContain("Pick a report");
    expect(lastEdit(transport)?.text).not.toContain("✖ Closed");
  });

  it("keeps the panel and says Closed when Telegram taps Close on a panel with action buttons", async () => {
    const actionModel: DialogModel = {
      kind: "info",
      title: "Debug",
      text: "Pick a report to run.",
      closable: true,
      actions: [{ key: "view:system", label: "View: system info" }],
    };
    const { broker, transport, session } = await openedPanel(actionModel);
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "x" });
    await settle();

    expect(lastEdit(transport)?.text).toContain("Pick a report");
    expect(lastEdit(transport)?.text).toContain("✖ Closed");
  });

  it("keeps the page and says it was closed in the terminal when the terminal closes it", async () => {
    const { transport, focus } = await openedPanel(panelModel);

    focus.closeToEditor();
    await settle();

    const edit = lastEdit(transport);
    expect(edit?.text).toContain("<b>1.2.0</b> fixed the thing");
    expect(edit?.text).toContain("Closed in the terminal");
    expect(edit?.text).not.toContain("Answered in the terminal");
    expect(edit?.rows).toEqual([]);
  });

  it("keeps the page that was on screen, not the first one", async () => {
    const paged: DialogModel = {
      kind: "info",
      title: "Long",
      text: Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n\n"),
      html: true,
      closable: true,
    };
    const { broker, transport, session } = await openedPanel(paged);
    session.page = 1;
    session.model = paged;
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "x" });
    await settle();

    const edit = lastEdit(transport);
    expect(edit?.text).toContain("✖ Closed");
    expect(edit?.text).not.toContain("line 0 ");
  });

  it("ends a choice with the item's name, not the mark the row draws before it", async () => {
    const choice: DialogModel = { kind: "select", title: "Logout", items: [{ key: "a", label: "MockAuth (test only)", mark: "● " }], total: 1 };
    const { broker, transport, session } = await openedPanel(choice);
    session.keyMap.set(session.generation, new Map([["a", "a"]]));
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "c", arg: "a" });
    await settle();

    expect(lastEdit(transport)?.text).toContain("✅ MockAuth (test only)");
    expect(lastEdit(transport)?.text).not.toContain("●");
  });

  it("still ends a choice with its answer rather than the panel status", async () => {
    const choice: DialogModel = { kind: "select", title: "Pick", items: [{ key: "a", label: "alpha" }], total: 1 };
    const { broker, transport, session } = await openedPanel(choice);
    session.keyMap.set(session.generation, new Map([["a", "a"]]));
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: session.generation, op: "c", arg: "a" });
    await settle();

    expect(lastEdit(transport)?.text).toContain("✅ alpha");
    expect(lastEdit(transport)?.text).not.toContain("Closed");
  });
});

describe("the questionnaire's answers and typed answers in the closing summary (#57, #58)", () => {
  async function questionnaire(model: DialogModel) {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    focus.openDialog({});
    await settle();
    const session = broker.current()!;
    const acts: DialogAction[] = [];
    session.adapter = {
      id: "scripted",
      detect: () => true,
      read: () => model,
      act: (_component, action) => {
        acts.push(action);
        if (action.type === "submit") focus.closeToEditor();
        return true;
      },
    };
    session.model = model;
    return { broker, transport, focus, session, acts };
  }
  const lastText = (transport: { edits: Array<{ text: string }> }) => transport.edits.at(-1)?.text ?? "";

  it("ends a submitted questionnaire with each question and its answer", async () => {
    const { broker, transport, session } = await questionnaire({
      kind: "questionnaire",
      title: "Order",
      active: 1,
      canSubmit: true,
      questions: [
        { id: "t", prompt: "Pick toppings", multi: true, allowCustom: false, answered: true, answers: ["cheese", "olive"], items: [] },
        { id: "s", prompt: "Pick a size", multi: false, allowCustom: false, answered: true, answers: ["large"], items: [] },
      ],
    });
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "k", arg: "enter" });
    await settle();

    expect(lastText(transport)).toContain("Pick toppings: cheese, olive");
    expect(lastText(transport)).toContain("Pick a size: large");
  });

  it("says the message waits for a typed answer once Type an answer is tapped", async () => {
    const { broker, transport, session } = await questionnaire({
      kind: "questionnaire",
      title: "Colour",
      active: 0,
      canSubmit: false,
      questions: [{ id: "c", prompt: "Pick a colour", multi: false, allowCustom: true, answered: false, items: [{ key: "red", label: "red" }] }],
    });
    broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "i" });
    await settle();

    expect(lastText(transport)).toContain("Send a message as the answer");
  });

  it("ends a typed answer to a single question with the answer's text", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { broker, transport, session } = await questionnaire({
        kind: "questionnaire",
        title: "Colour",
        active: 0,
        canSubmit: false,
        questions: [{ id: "c", prompt: "Pick a colour", multi: false, allowCustom: true, answered: false, items: [{ key: "red", label: "red" }] }],
      });
      broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "i" });
      await settle();
      expect(broker.handleText(session, "purple please", 57)).toEqual({ handled: true });
      await settle();
      await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);

      expect(lastText(transport)).toContain("✅ purple please");
      expect(lastText(transport)).not.toContain("Sent an answer");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a tap that hands the message to another dialog keeps its line (#41)", () => {
  const lastText = (transport: { edits: Array<{ text: string }> }) => transport.edits.at(-1)?.text ?? "";

  it("ends with the tap's answer and then the terminal's close of the dialog it handed over to", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
        // Both dialogs belong to one host entry, so the list the confirm hands over to keeps this session.
        const entry = { kind: "select", source: "omp" } as unknown as EntryInfo;
        const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
        focus.openDialog({});
        await settle();
        const session = broker.current()!;
        const list = {};
        let current: DialogModel = { kind: "confirm", title: "Delete session?" };
        session.adapter = {
          id: "scripted",
          detect: () => true,
          read: () => current,
          act: (_component, action) => {
            if (action.type === "confirm") {
              current = { kind: "select", title: "Resume", items: [{ key: "s1", label: "session one" }], total: 1 };
              focus.openDialog(list);
            }
            return true;
          },
        };
        session.model = current;
        broker.handleCallback(42, undefined, { sessionId: session.id, generation: 0, op: "n" });
        await settle();
        await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);
        focus.closeToEditor();
        await settle();
        await vi.advanceTimersByTimeAsync(EDIT_THROTTLE_MS);

        expect(lastText(transport)).toContain("✅ No");
        expect(lastText(transport)).toContain("Answered in the terminal");
    } finally {
      vi.useRealTimers();
    }
  });
});
