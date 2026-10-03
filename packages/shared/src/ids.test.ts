import { describe, expect, it } from "vitest";
import { isUlid, ulid } from "./ids.ts";

describe("ulid", () => {
  it("encodes time and randomness as 26 Crockford characters", () => {
    const id = ulid(Date.UTC(2026, 8, 28), new Uint8Array(10).fill(255));
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(id.endsWith("ZZZZZZZZZZZZZZZZ")).toBe(true);
  });
  it("sorts by time", () => {
    const r = new Uint8Array(10);
    expect(ulid(1000, r) < ulid(2000, r)).toBe(true);
  });
  it("is deterministic for the same input", () => {
    const r = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ulid(5, r)).toBe(ulid(5, r));
  });
  it("matches the reference encoding of time 0 and zero bytes", () => {
    expect(ulid(0, new Uint8Array(10))).toBe("0".repeat(26));
  });
});
