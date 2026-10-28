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
import { DialogBroker, REFRESH_MS, textPurpose } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { DialogModel, EntryInfo } from "../tui/model.ts";
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
    origin: { active: () => options.scope } as unknown as BrokerDeps["origin"],
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
