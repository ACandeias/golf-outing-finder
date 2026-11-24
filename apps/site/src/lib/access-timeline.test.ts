import { describe, expect, it } from "vitest";
import { accessTimeline, daysBetween, deadlineLabel, lastOccurrence, monthsSeen, monthsSeenText, nextOccurrence, type TimelineInput } from "./access-timeline.ts";

const TODAY = "2026-11-23";
const item = (id: string, kind: string, status: string, dateStart: string | null, dateEnd: string | null, recurring = false): TimelineInput => ({
  id,
  kind,
  status,
  dateStart,
  dateEnd,
  recurring,
});

describe("date helpers", () => {
  it("counts whole days across months and years", () => {
    expect(daysBetween("2026-11-23", "2026-11-23")).toBe(0);
    expect(daysBetween("2026-11-23", "2026-11-24")).toBe(1);
    expect(daysBetween("2026-11-23", "2027-01-03")).toBe(41);
    expect(daysBetween("2026-11-24", "2026-11-23")).toBe(-1);
  });

  it("finds the next time a month and day comes round", () => {
    expect(nextOccurrence("2026-04-12", TODAY)).toBe("2027-04-12");
    expect(nextOccurrence("2025-12-05", TODAY)).toBe("2026-12-05");
    expect(nextOccurrence("2025-11-23", TODAY)).toBe("2026-11-23");
    expect(nextOccurrence("2027-02-14", TODAY)).toBe("2027-02-14");
    // Feb 29 lands on Feb 28 in a year without one, and on Feb 29 when the year has one.
    expect(nextOccurrence("2024-02-29", TODAY)).toBe("2027-02-28");
    expect(nextOccurrence("2024-02-29", "2027-06-01")).toBe("2028-02-29");
  });

  it("finds a past date's most recent anniversary", () => {
    expect(lastOccurrence("2025-11-01", TODAY)).toBe("2026-11-01");
    expect(lastOccurrence("2026-05-01", TODAY)).toBe("2026-05-01");
    expect(lastOccurrence("2025-12-05", TODAY)).toBe("2025-12-05");
    expect(lastOccurrence("2025-11-23", TODAY)).toBe("2026-11-23");
    expect(lastOccurrence("2024-02-29", "2028-03-01")).toBe("2028-02-29");
    expect(lastOccurrence("2024-02-29", "2027-03-01")).toBe("2027-02-28");
  });
});

describe("deadlineLabel", () => {
  it("counts an auction down to its closing day", () => {
    expect(deadlineLabel(item("a", "auction", "open", null, "2026-11-23"), TODAY)).toBe("Bidding closes today");
    expect(deadlineLabel(item("a", "auction", "open", null, "2026-11-24"), TODAY)).toBe("Bidding closes tomorrow");
    expect(deadlineLabel(item("a", "auction", "upcoming", null, "2026-12-05"), TODAY)).toBe("Bidding closes in 12 days");
  });

  it("counts an event down to its first day and an offer to its last", () => {
    expect(deadlineLabel(item("e", "outing", "open", "2026-11-25", "2026-11-25"), TODAY)).toBe("Starts in 2 days");
    expect(deadlineLabel(item("o", "stay_and_play", "open", "2026-04-01", "2026-12-01"), TODAY)).toBe("Ends in 8 days");
  });

  it("says an event that has started is under way", () => {
    expect(deadlineLabel(item("e", "outing", "open", "2026-11-22", "2026-11-25"), TODAY)).toBe("Under way until Nov 25, 2026");
  });

  it("is silent past 30 days, without a date, and for anything not open or upcoming", () => {
    expect(deadlineLabel(item("a", "auction", "open", null, "2026-12-24"), TODAY)).toBeNull();
    expect(deadlineLabel(item("a", "auction", "open", null, "2026-12-23"), TODAY)).toBe("Bidding closes in 30 days");
    expect(deadlineLabel(item("t", "public_tee_time", "open", null, null), TODAY)).toBeNull();
    expect(deadlineLabel(item("a", "auction", "closed", null, "2026-11-24"), TODAY)).toBeNull();
    expect(deadlineLabel(item("a", "auction", "recurring", null, "2026-11-24"), TODAY)).toBeNull();
    // An auction whose closing day has passed is over, not under way.
    expect(deadlineLabel(item("a", "auction", "open", null, "2026-11-22"), TODAY)).toBeNull();
  });

  it("never calls a lot's start date its closing day: it is the day bidding opens", () => {
    expect(deadlineLabel(item("a", "auction", "upcoming", "2026-11-24", null), TODAY)).toBe("Bidding opens tomorrow");
    expect(deadlineLabel(item("a", "auction", "upcoming", "2026-12-01", null), TODAY)).toBe("Bidding opens in 8 days");
    expect(deadlineLabel(item("a", "auction", "upcoming", "2027-02-01", null), TODAY)).toBeNull();
    // Already open with no closing day listed: nothing to count down to.
    expect(deadlineLabel(item("a", "auction", "open", "2026-11-01", null), TODAY)).toBeNull();
    // Only auctions: an event with no dates has no label at all.
    expect(deadlineLabel(item("e", "outing", "upcoming", null, null), TODAY)).toBeNull();
  });
});

describe("accessTimeline", () => {
  const items = [
    item("lot-tomorrow", "auction", "open", null, "2026-11-24"),
    item("shamble", "other", "open", "2026-11-25", "2026-11-25"),
    item("lot-week-edge", "auction", "open", null, "2026-11-29"),
    item("lot-day-7", "auction", "open", null, "2026-11-30"),
    item("new-year", "outing", "open", "2026-12-31", "2027-01-03"),
    item("spring", "outing", "upcoming", "2027-02-14", "2027-02-17"),
    item("offer", "stay_and_play", "open", "2026-04-01", "2027-03-31"),
    item("tee-times", "public_tee_time", "open", null, null),
    item("undated-upcoming", "outing", "upcoming", null, null),
    item("annual-lot", "auction", "recurring", null, "2026-04-12", true),
    item("annual-outing", "outing", "recurring", "2026-06-08", null, true),
    item("closed-annual", "auction", "closed", null, "2025-12-05", true),
    item("closed-once", "auction", "closed", null, "2026-10-01"),
    item("recurring-ahead", "outing", "recurring", "2027-05-18", null, true),
    item("recurring-undated", "member_for_a_day", "recurring", null, null, true),
    item("unknown", "auction", "unknown", null, "2026-12-01"),
  ];
  const t = accessTimeline(items, TODAY);
  const shape = (groups: typeof t.upcoming) => groups.map((g) => [g.key, g.entries.map((e) => e.item.id)]);

  it("puts the next 7 days first, then one group per month, soonest first", () => {
    expect(shape(t.upcoming)).toEqual([
      ["week", ["lot-tomorrow", "shamble", "lot-week-edge"]],
      ["2026-11", ["lot-day-7"]],
      ["2026-12", ["new-year"]],
      ["2027-02", ["spring"]],
      ["2027-03", ["offer"]],
      ["2027-05", ["recurring-ahead"]],
    ]);
    expect(t.upcoming.map((g) => g.heading)).toEqual(["In the next 7 days", "November 2026", "December 2026", "February 2027", "March 2027", "May 2027"]);
  });

  it("labels each entry with its countdown, or its date when it is far off", () => {
    const labels = Object.fromEntries(t.upcoming.flatMap((g) => g.entries.map((e) => [e.item.id, e.label])));
    expect(labels).toMatchObject({
      "lot-tomorrow": "Bidding closes tomorrow",
      shamble: "Starts in 2 days",
      "new-year": "Starts Dec 31, 2026",
      offer: "Ends Mar 31, 2027",
      "recurring-ahead": "Starts May 18, 2027",
    });
    expect(t.upcoming[0]!.entries[0]).toMatchObject({ date: "2026-11-24", daysLeft: 1 });
  });

  it("places recurring items in the month they are expected back", () => {
    expect(shape(t.expected)).toEqual([
      ["2026-12", ["closed-annual"]],
      ["2027-04", ["annual-lot"]],
      ["2027-06", ["annual-outing"]],
    ]);
    const labels = Object.fromEntries(t.expected.flatMap((g) => g.entries.map((e) => [e.item.id, e.label])));
    expect(labels).toEqual({
      "closed-annual": "Last closed Dec 5, 2025",
      "annual-lot": "Last closed Apr 12, 2026",
      "annual-outing": "Last held Jun 8, 2026",
    });
  });

  it("lists open items with no date separately, and leaves out what it can't place", () => {
    expect(t.anytime.map((i) => i.id)).toEqual(["tee-times"]);
    const placed = [...t.upcoming, ...t.expected].flatMap((g) => g.entries.map((e) => e.item.id));
    for (const id of ["undated-upcoming", "closed-once", "recurring-undated", "unknown"]) expect(placed).not.toContain(id);
  });

  it("an event under way sits on today", () => {
    const under = accessTimeline([item("e", "outing", "open", "2026-11-22", "2026-11-25")], TODAY);
    expect(under.upcoming[0]).toMatchObject({ key: "week", entries: [{ date: TODAY, daysLeft: 0, label: "Under way until Nov 25, 2026" }] });
  });

  it("a lot with no closing day: on its opening day until it opens, then open any time; it never drops off the page", () => {
    const t2 = accessTimeline(
      [
        item("started", "auction", "open", "2026-11-01", null),
        item("opens-dec", "auction", "upcoming", "2026-12-01", null),
        item("opens-feb", "auction", "upcoming", "2027-02-01", null),
        item("recurring-opens", "auction", "recurring", "2026-11-24", null, true),
        item("upcoming-started", "auction", "upcoming", "2026-11-01", null),
      ],
      TODAY,
    );
    expect(t2.upcoming.flatMap((g) => g.entries.map((e) => [e.item.id, g.key, e.label]))).toEqual([
      ["recurring-opens", "week", "Bidding opens tomorrow"],
      ["opens-dec", "2026-12", "Bidding opens in 8 days"],
      ["opens-feb", "2027-02", "Bidding opens Feb 1, 2027"],
    ]);
    expect(t2.anytime.map((i) => i.id)).toEqual(["started"]);
    expect(t2.expected).toEqual([]);
  });

  it("expected back holds only what has already happened", () => {
    const t2 = accessTimeline(
      [
        // Marked closed and recurring, but the day is still ahead: not "last held".
        item("closed-ahead", "outing", "closed", "2026-12-05", null, true),
        // Closed today by the loader: today hasn't passed yet.
        item("closed-today", "auction", "closed", null, TODAY, true),
        // A recurring event between its first and last day is under way, not expected back.
        item("recurring-under-way", "outing", "recurring", "2026-11-22", "2026-11-25", true),
        item("closed-yesterday", "auction", "closed", null, "2026-11-22", true),
      ],
      TODAY,
    );
    expect(t2.expected.flatMap((g) => g.entries.map((e) => [e.item.id, g.key, e.label]))).toEqual([["closed-yesterday", "2027-11", "Last closed Nov 22, 2026"]]);
    expect(t2.upcoming.flatMap((g) => g.entries.map((e) => [e.item.id, e.label]))).toEqual([["recurring-under-way", "Under way until Nov 25, 2026"]]);
  });

  it("a recurring offer is expected back when its season opens, not when it ends", () => {
    const t2 = accessTimeline(
      [
        item("summer", "stay_and_play", "recurring", "2026-05-01", "2026-10-31", true),
        item("start-only", "public_tee_time", "recurring", "2026-04-15", null, true),
        item("lot-start-only", "auction", "recurring", "2026-04-10", null, true),
      ],
      TODAY,
    );
    expect(t2.expected.flatMap((g) => g.entries.map((e) => [e.item.id, g.key, e.label]))).toEqual([
      ["lot-start-only", "2027-04", "Last listed Apr 10, 2026"],
      ["start-only", "2027-04", "Last offered from Apr 15, 2026"],
      ["summer", "2027-05", "Last offered until Oct 31, 2026"],
    ]);
  });

  it("a season offer whose dates, a year on, cover today is listed in this month, not a year out", () => {
    // Last season ran Nov 1, 2025 to Mar 31, 2026. By the same dates it opened again on Nov 1, 2026.
    const winter = item("winter", "stay_and_play", "recurring", "2025-11-01", "2026-03-31", true);
    const on = (day: string) => accessTimeline([winter], day).expected.flatMap((g) => g.entries.map((e) => [g.key, e.label, e.daysLeft]));
    const running = "Likely in season now. Last ran Nov 1, 2025 to Mar 31, 2026";
    expect(on("2026-10-31")).toEqual([["2026-11", "Last offered until Mar 31, 2026", 1]]);
    expect(on("2026-11-01")).toEqual([["2026-11", running, 0]]);
    expect(on(TODAY)).toEqual([["2026-11", running, 0]]);
    expect(on("2027-03-31")).toEqual([["2027-03", running, 0]]);
    expect(on("2027-04-01")).toEqual([["2027-11", "Last offered until Mar 31, 2026", 214]]);
    // The stored season itself still running is a live listing, not an expected one.
    expect(accessTimeline([item("now", "stay_and_play", "recurring", "2026-11-01", "2027-03-31", true)], TODAY).expected).toEqual([]);
  });

  it("keeps one 'next 7 days' group when courses in two time zones share an act-by day", () => {
    // 06:00 UTC on Nov 24: Nov 24 in New York, still Nov 23 in Los Angeles.
    const ny = (id: string, end: string) => ({ ...item(id, "auction", "open", null, end), localToday: "2026-11-24" });
    const la = (id: string, end: string) => ({ ...item(id, "auction", "open", null, end), localToday: "2026-11-23" });
    const t2 = accessTimeline([ny("c", "2026-11-25"), la("a", "2026-11-30"), ny("b", "2026-11-30"), la("d", "2026-12-02")], "2026-11-23");
    expect(t2.upcoming.map((g) => [g.key, g.entries.map((e) => e.item.id)])).toEqual([
      ["week", ["c", "b"]],
      ["2026-11", ["a"]],
      ["2026-12", ["d"]],
    ]);
  });

  it("counts from each item's own day at its course", () => {
    // The list day is Nov 23; at this course it is already Nov 24, the closing day.
    const east = { ...item("east", "auction", "open", null, "2026-11-24"), localToday: "2026-11-24" };
    const west = { ...item("west", "auction", "open", null, "2026-11-24"), localToday: "2026-11-23" };
    const t2 = accessTimeline([east, west], TODAY);
    expect(t2.upcoming[0]!.entries.map((e) => [e.item.id, e.label, e.daysLeft])).toEqual([
      ["east", "Bidding closes today", 0],
      ["west", "Bidding closes tomorrow", 1],
    ]);
  });

  it("is empty for no items", () => {
    expect(accessTimeline([], TODAY)).toEqual({ upcoming: [], expected: [], anytime: [] });
  });
});

describe("monthsSeen", () => {
  it("counts dated items by calendar month, in calendar order", () => {
    const items = [
      item("a", "auction", "closed", null, "2026-04-12"),
      item("b", "auction", "closed", null, "2025-04-20"),
      item("c", "auction", "closed", null, "2025-11-10"),
      item("d", "outing", "recurring", "2026-06-08", null, true),
      item("e", "public_tee_time", "open", null, null),
    ];
    expect(monthsSeen(items)).toEqual([
      { month: 4, name: "April", count: 2 },
      { month: 6, name: "June", count: 1 },
      { month: 11, name: "November", count: 1 },
    ]);
    expect(monthsSeenText(items)).toBe("April (2), June and November");
    expect(monthsSeenText(items.slice(0, 2))).toBe("April (2)");
    expect(monthsSeenText([])).toBe("");
  });
});
