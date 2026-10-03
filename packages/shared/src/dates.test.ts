import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  addMonths,
  eventStartDate,
  isHhMm,
  isIsoDate,
  isPast,
  localToday,
  offsetMinutesAt,
  rollForwardMonth,
  todayIso,
  wallTimeToEpoch,
  zonedIso,
} from "./dates.ts";

describe("isIsoDate", () => {
  it("accepts valid dates", () => {
    expect(isIsoDate("2026-10-13")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });
  it("rejects non-ISO shapes and impossible dates", () => {
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026/10/13")).toBe(false);
    expect(isIsoDate("2026-2-1")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
  });
});

describe("isHhMm", () => {
  it("accepts 24-hour times", () => {
    expect(isHhMm("07:30")).toBe(true);
    expect(isHhMm("23:59")).toBe(true);
    expect(isHhMm("24:00")).toBe(false);
    expect(isHhMm("7:30")).toBe(false);
  });
});

describe("addDaysIso and addMonths", () => {
  it("crosses month and year boundaries", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-10", 12)).toBe("2027-10");
  });
  it("rolls forward to the month of last start + 1 calendar year", () => {
    expect(rollForwardMonth("2026-06-01")).toBe("2027-06");
    expect(rollForwardMonth("2026-10-19")).toBe("2027-10");
  });
});

describe("todayIso", () => {
  it("returns the UTC date of the injected clock", () => {
    expect(todayIso(Date.parse("2026-09-29T12:00:00Z"))).toBe("2026-09-29");
  });
});

describe("localToday", () => {
  const lateEvening = Date.parse("2026-10-20T03:30:00Z"); // 23:30 on Oct 19 in New York
  it("uses the course's time zone, not UTC", () => {
    expect(localToday(lateEvening, "America/New_York")).toBe("2026-10-19");
    expect(localToday(lateEvening, "America/Los_Angeles")).toBe("2026-10-19");
    expect(localToday(lateEvening, "UTC")).toBe("2026-10-20");
  });
  it("handles Arizona, which has no DST", () => {
    expect(localToday(Date.parse("2026-10-03T06:59:00Z"), "America/Phoenix")).toBe("2026-10-02");
    expect(localToday(Date.parse("2026-10-03T07:00:00Z"), "America/Phoenix")).toBe("2026-10-03");
  });
  it("throws on an unknown zone", () => {
    expect(() => localToday(0, "Mars/Olympus_Mons")).toThrow();
  });
});

describe("zonedIso", () => {
  it("gives the SPEC example for NKF Winged Foot", () => {
    expect(zonedIso("2026-10-19", "12:00", "America/New_York")).toBe("2026-10-19T12:00:00-04:00");
  });
  it("uses standard time after the November change", () => {
    expect(zonedIso("2026-12-15", "08:00", "America/Los_Angeles")).toBe(
      "2026-12-15T08:00:00-08:00",
    );
    expect(zonedIso("2026-11-01", "12:00", "America/New_York")).toBe("2026-11-01T12:00:00-05:00");
  });
  it("handles Phoenix (UTC-7 all year)", () => {
    expect(zonedIso("2026-10-03", "07:00", "America/Phoenix")).toBe("2026-10-03T07:00:00-07:00");
  });
  it("round-trips through epoch milliseconds", () => {
    const ms = wallTimeToEpoch("2026-10-19", "12:00", "America/New_York");
    expect(new Date(ms).toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(offsetMinutesAt(ms, "America/New_York")).toBe(-240);
  });
  it("rejects malformed input", () => {
    expect(() => zonedIso("2026-10-19", "noon", "America/New_York")).toThrow();
    expect(() => zonedIso("10/19/2026", "12:00", "America/New_York")).toThrow();
  });
});

describe("eventStartDate", () => {
  it("is date-only when there is no shotgun time", () => {
    expect(eventStartDate("2026-10-07", null, "America/New_York")).toBe("2026-10-07");
    expect(eventStartDate("2026-10-19", "12:00", "America/New_York")).toBe(
      "2026-10-19T12:00:00-04:00",
    );
  });
});

describe("isPast", () => {
  const tz = "America/Los_Angeles";
  it("keeps a multi-day event current until its last day", () => {
    const dec16 = Date.parse("2026-12-16T20:00:00Z");
    expect(isPast("2026-12-15", "2026-12-18", dec16, tz)).toBe(false);
    const dec19 = Date.parse("2026-12-19T20:00:00Z");
    expect(isPast("2026-12-15", "2026-12-18", dec19, tz)).toBe(true);
  });
  it("uses start_date when there is no end date", () => {
    expect(isPast("2026-10-03", null, Date.parse("2026-10-03T20:00:00Z"), "America/Phoenix")).toBe(
      false,
    );
    expect(isPast("2026-10-03", null, Date.parse("2026-10-04T08:00:00Z"), "America/Phoenix")).toBe(
      true,
    );
  });
});
