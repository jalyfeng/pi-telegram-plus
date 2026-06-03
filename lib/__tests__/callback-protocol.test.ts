import { describe, expect, it } from "vitest";
import { encodeUiCallback, decodeUiCallback, UI_CALLBACK_PREFIX } from "../callback-protocol.ts";

describe("callback-protocol", () => {
  describe("encodeUiCallback", () => {
    it("prepends prefix", () => {
      expect(encodeUiCallback("test")).toBe(`${UI_CALLBACK_PREFIX}test`);
    });

    it("handles empty string", () => {
      expect(encodeUiCallback("")).toBe(UI_CALLBACK_PREFIX);
    });

    it("handles colons and slashes", () => {
      expect(encodeUiCallback("f:1:cancel")).toBe(`${UI_CALLBACK_PREFIX}f:1:cancel`);
    });
  });

  describe("decodeUiCallback", () => {
    it("extracts value after prefix", () => {
      expect(decodeUiCallback(`${UI_CALLBACK_PREFIX}f:1:yes`)).toBe("f:1:yes");
    });

    it("returns undefined for non-prefixed data", () => {
      expect(decodeUiCallback("something")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(decodeUiCallback("")).toBeUndefined();
    });

    it("handles empty value after prefix", () => {
      expect(decodeUiCallback(UI_CALLBACK_PREFIX)).toBe("");
    });
  });

  describe("round-trip", () => {
    it("decode(encode(x)) === x", () => {
      const values = ["test", "f:1:cancel", "", "a:b:c:d"];
      for (const v of values) {
        expect(decodeUiCallback(encodeUiCallback(v))).toBe(v);
      }
    });
  });
});