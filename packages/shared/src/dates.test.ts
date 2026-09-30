import { describe, expect, it } from "vitest";
import { addDaysIso, isIsoDate, todayIso } from "./dates.ts";

describe("isIsoDate", () => {
  it("accepts valid dates", () => {
    expect(isIsoDate("2026-10-13")).toBe(true);
  });
  it("rejects non-ISO shapes", () => {
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026/10/13")).toBe(false);
    expect(isIsoDate("2026-2-1")).toBe(false);
  });
});

describe("addDaysIso", () => {
  it("adds and crosses month boundaries", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("todayIso", () => {
  it("returns a YYYY-MM-DD from the injected clock", () => {
    const ms = Date.parse("2026-09-29T12:00:00Z");
    expect(todayIso(ms)).toBe("2026-09-29");
  });
});
