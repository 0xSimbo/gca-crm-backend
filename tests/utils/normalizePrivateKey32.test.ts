import { describe, expect, it } from "bun:test";
import { normalizePrivateKey32Hex } from "../../src/utils/normalizePrivateKey32";

describe("normalizePrivateKey32Hex", () => {
  it("accepts a 64-hex string without 0x", () => {
    const raw = "1".repeat(64);
    expect(normalizePrivateKey32Hex(raw)).toBe(`0x${raw}`);
  });

  it("accepts a 0x-prefixed 64-hex string", () => {
    const raw = `0x${"a".repeat(64)}`;
    expect(normalizePrivateKey32Hex(raw)).toBe(raw);
  });

  it("rejects wrong length", () => {
    expect(() => normalizePrivateKey32Hex("abc")).toThrow();
  });
});

