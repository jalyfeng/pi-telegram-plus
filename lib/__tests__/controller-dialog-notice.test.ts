import { afterEach, describe, expect, it, vi } from "vitest";
import { watchDialogNotice } from "../controller.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("the 'dialog is waiting' notice is removed when the dialog closes (#73)", () => {
  it("removes the notice once the dialog is no longer open", async () => {
    vi.useFakeTimers();
    let open = true;
    const remove = vi.fn();
    watchDialogNotice(() => open, remove);

    await vi.advanceTimersByTimeAsync(1000);
    expect(remove).not.toHaveBeenCalled();

    open = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("stops watching after the cap without removing the notice", async () => {
    vi.useFakeTimers();
    const remove = vi.fn();
    watchDialogNotice(() => true, remove, { maxMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(remove).not.toHaveBeenCalled();
  });

  it("stop() ends the watch without removing the notice", async () => {
    vi.useFakeTimers();
    let open = true;
    const remove = vi.fn();
    const stop = watchDialogNotice(() => open, remove);
    stop();
    open = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(remove).not.toHaveBeenCalled();
  });
});
