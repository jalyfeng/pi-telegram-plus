import { describe, expect, it } from "vitest";
import { clearOnTerminalSubmit, createHostOriginTracker, turnsOrHostOrigin } from "../controller.ts";

describe("host-started turns quote the Telegram message that started them (#61, #60)", () => {
  it("has no origin before any Telegram message", () => {
    const origins = createHostOriginTracker();
    expect(origins.turn()).toBeUndefined();
  });

  it("remembers the last Telegram message that started host activity, with its chat and thread", () => {
    const origins = createHostOriginTracker();
    origins.note({ chatId: 111, messageThreadId: 5, sourceMessageId: 77 });
    expect(origins.turn()).toEqual(expect.objectContaining({ chatId: 111, messageThreadId: 5, sourceMessageId: 77 }));
    origins.note({ chatId: 111, sourceMessageId: 80 });
    expect(origins.turn()).toEqual(expect.objectContaining({ chatId: 111, sourceMessageId: 80 }));
  });

  it("uses the active Telegram turns first, the remembered origin only when none is running", () => {
    const origin = { chatId: 1, sourceMessageId: 9, queuedAttachments: [] };
    const active = { chatId: 2, sourceMessageId: 3, queuedAttachments: [] };
    expect(turnsOrHostOrigin([active], origin)).toEqual([active]);
    expect(turnsOrHostOrigin([], origin)).toEqual([origin]);
    expect(turnsOrHostOrigin([], undefined)).toEqual([]);
  });
});

describe("a prompt typed in the terminal ends the host origin (#61)", () => {
  it("a terminal (interactive) submit clears the origin", () => {
    const origins = createHostOriginTracker();
    origins.note({ chatId: 111, sourceMessageId: 77 });
    clearOnTerminalSubmit(origins, { source: "interactive" }, false);
    expect(origins.turn()).toBeUndefined();
  });

  it("a submit the plugin makes itself (inside a Telegram command) keeps the origin", () => {
    const origins = createHostOriginTracker();
    origins.note({ chatId: 111, sourceMessageId: 77 });
    clearOnTerminalSubmit(origins, { source: "interactive" }, true);
    expect(origins.turn()).toEqual(expect.objectContaining({ sourceMessageId: 77 }));
  });

  it("a non-interactive input (rpc) keeps the origin", () => {
    const origins = createHostOriginTracker();
    origins.note({ chatId: 111, sourceMessageId: 77 });
    clearOnTerminalSubmit(origins, { source: "rpc" }, false);
    expect(origins.turn()).toEqual(expect.objectContaining({ sourceMessageId: 77 }));
  });
});
