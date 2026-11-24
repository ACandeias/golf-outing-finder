import { describe, expect, it } from "vitest";
import { dayAt, secondsToNextDay, ttlEndingWithDay } from "./day.ts";

const at = (iso: string) => Date.parse(iso);

describe("dayAt", () => {
  it("gives each course its own day", () => {
    // 04:30 UTC on Nov 24: still Nov 23 in New York (23:30) and Honolulu, Nov 24 nowhere in the US yet.
    const day = dayAt(at("2026-11-24T04:30:00Z"));
    expect(day("America/New_York")).toBe("2026-11-23");
    // An hour later it is Nov 24 in New York and still Nov 23 in Los Angeles and Honolulu.
    const later = dayAt(at("2026-11-24T05:30:00Z"));
    expect(later("America/New_York")).toBe("2026-11-24");
    expect(later("America/Los_Angeles")).toBe("2026-11-23");
    expect(later("Pacific/Honolulu")).toBe("2026-11-23");
  });
});

describe("secondsToNextDay", () => {
  it("counts to the next local midnight", () => {
    expect(secondsToNextDay(at("2026-11-24T04:30:00Z"), "America/New_York")).toBe(30 * 60);
    expect(secondsToNextDay(at("2026-11-24T05:00:00Z"), "America/New_York")).toBe(24 * 60 * 60);
    expect(secondsToNextDay(at("2026-11-24T09:59:30Z"), "Pacific/Honolulu")).toBe(30);
    // Summer time: New York is UTC-4, so midnight is 04:00 UTC.
    expect(secondsToNextDay(at("2026-07-01T03:00:00Z"), "America/New_York")).toBe(60 * 60);
  });

  it("handles the short and long days when clocks change", () => {
    // Nov 1, 2026 is 25 hours long in New York; Mar 8, 2026 is 23.
    expect(secondsToNextDay(at("2026-11-01T04:00:00Z"), "America/New_York")).toBe(25 * 60 * 60);
    expect(secondsToNextDay(at("2026-03-08T05:00:00Z"), "America/New_York")).toBe(23 * 60 * 60);
  });
});

describe("ttlEndingWithDay", () => {
  const SIX_HOURS = 6 * 60 * 60;
  it("keeps the full lifetime when no course's midnight is near", () => {
    expect(ttlEndingWithDay(SIX_HOURS, ["America/New_York", "America/Los_Angeles"], at("2026-11-24T15:00:00Z"))).toBe(SIX_HOURS);
    expect(ttlEndingWithDay(SIX_HOURS, [], at("2026-11-24T04:30:00Z"))).toBe(SIX_HOURS);
  });

  it("ends at the nearest midnight among the courses on the page", () => {
    const now = at("2026-11-24T04:30:00Z");
    expect(ttlEndingWithDay(SIX_HOURS, ["America/Los_Angeles", "America/New_York", "America/New_York"], now)).toBe(30 * 60);
    // Without the New York course the next midnight is Los Angeles's, 3.5 hours off.
    expect(ttlEndingWithDay(SIX_HOURS, ["America/Los_Angeles"], now)).toBe(3.5 * 60 * 60);
  });
});
