import { resolveBudget } from "@gof/shared/budget";
import { describe, expect, it } from "vitest";
import { emptyOverrides } from "../overrides/load.ts";
import { discover, isGolfOutingText, planSearch, PRIORITY } from "./discover.ts";
import type { PlatformRule } from "../discovery/platform-policy.ts";
import {
  discoverInputSchema,
  queueEntrySchema,
  type Context,
  type DiscoverInput,
  type RecheckCandidate,
} from "./types.ts";

function ctxAt(iso: string, patch: Partial<Context> = {}): Context {
  return {
    now: new Date(iso),
    caps: resolveBudget("nightly"),
    overrides: emptyOverrides({
      exclusions: { domains: ["facebook.com"], url_patterns: ["https://example.org/members/*"] },
    }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { nowMs: () => 0 },
    ...patch,
  };
}
const NOW = "2026-09-28T12:00:00Z";
const ctx = ctxAt(NOW);

function input(patch: Partial<DiscoverInput> = {}): DiscoverInput {
  return {
    recheck: [],
    submissions: [],
    listings: [],
    serpResults: [],
    recentlyFetched: [],
    heldSources: [],
    allowance: { MAX_FETCHES_PER_RUN: 2500 },
    ...patch,
  };
}

function recheck(id: string, start: string, lastVerified: string, url = `https://org.example/${id}`): RecheckCandidate {
  return {
    outing_id: id,
    url,
    status: "open",
    start_date: start,
    last_verified: lastVerified,
    time_zone: "America/New_York",
  };
}

// ---------------------------------------------------------------------------
// planSearch
// ---------------------------------------------------------------------------

const metros = Array.from({ length: 500 }, (_, i) => ({
  name: `City${i}`,
  state: "AZ",
  population: 1_000_000 - i,
}));
const courses = [
  { id: "crs_b", name: "Winged Foot Golf Club", outing_count: 2, notable: true },
  { id: "crs_a", name: "Encanto 18", outing_count: 1, notable: false },
  { id: "crs_c", name: "Quiet Muni", outing_count: 0, notable: false },
];

describe("planSearch", () => {
  it("in April to September covers every metro once a week, a seventh per night", () => {
    const seen = new Map<string, number>();
    let maxPerNight = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.UTC(2026, 6, 1 + d, 7, 15)).toISOString();
      const q = planSearch(ctxAt(day), { metros, courses: [], allowance: { MAX_SERP_QUERIES_PER_RUN: 450 } })
        .output.queries;
      maxPerNight = Math.max(maxPerNight, q.length);
      for (const x of q.filter((x) => x.kind === "place")) seen.set(x.subject, (seen.get(x.subject) ?? 0) + 1);
    }
    expect(seen.size).toBe(500);
    expect([...seen.values()].every((n) => n === 3)).toBe(true);
    expect(maxPerNight).toBeLessThanOrEqual(3 * Math.ceil(500 / 7));
  });

  it("October to March covers every metro once a month", () => {
    const seen = new Set<string>();
    for (let d = 1; d <= 31; d++) {
      const day = new Date(Date.UTC(2026, 9, d, 7, 15)).toISOString();
      for (const x of planSearch(ctxAt(day), {
        metros,
        courses: [],
        allowance: { MAX_SERP_QUERIES_PER_RUN: 450 },
      }).output.queries)
        seen.add(x.subject);
    }
    expect(seen.size).toBe(500);
  });

  it("uses the SPEC query templates with the year and month", () => {
    const q = planSearch(ctxAt("2026-07-01T07:15:00Z"), {
      metros: [{ name: "Phoenix", state: "AZ", population: 1 }],
      courses: [],
      allowance: { MAX_SERP_QUERIES_PER_RUN: 450 },
    }).output.queries;
    const slot = Math.floor(Date.parse("2026-07-01T07:15:00Z") / 86_400_000) % 7;
    if (slot === 0) {
      expect(q.map((x) => x.q)).toEqual([
        "golf outing Phoenix AZ 2026",
        "charity golf tournament Phoenix AZ 2026",
        "golf scramble Phoenix AZ July",
      ]);
      expect(q[0]).toMatchObject({ kind: "place", subject: "Phoenix, AZ" });
    } else {
      expect(q).toEqual([]);
    }
  });

  it("queries courses with outings or flagged notable, monthly", () => {
    const all: string[] = [];
    for (let d = 1; d <= 30; d++) {
      const day = new Date(Date.UTC(2026, 10, d, 7, 15)).toISOString();
      all.push(
        ...planSearch(ctxAt(day), { metros: [], courses, allowance: { MAX_SERP_QUERIES_PER_RUN: 450 } })
          .output.queries.map((x) => x.q),
      );
    }
    // November: the coming season's year too (from September 1).
    expect(all.sort()).toEqual(
      [
        '"Encanto 18" golf classic register',
        '"Encanto 18" golf outing 2026',
        '"Encanto 18" golf outing 2027',
        '"Winged Foot Golf Club" golf classic register',
        '"Winged Foot Golf Club" golf outing 2026',
        '"Winged Foot Golf Club" golf outing 2027',
      ].sort(),
    );
  });

  it("searches the coming season: next year from September 1, the current year dropped from December 1", () => {
    const qs = (iso: string): string[] =>
      planSearch(ctxAt(iso), {
        metros: [{ name: "Mamaroneck", state: "NY", population: 1 }],
        courses: [],
        allowance: { MAX_SERP_QUERIES_PER_RUN: 450 },
        prioritize_states: ["NY"],
      }).output.queries.map((x) => x.q);
    expect(qs("2026-08-31T07:15:00Z")).toEqual([
      "golf outing Mamaroneck NY 2026",
      "charity golf tournament Mamaroneck NY 2026",
      "golf scramble Mamaroneck NY August",
    ]);
    expect(qs("2026-09-01T07:15:00Z")).toEqual([
      "golf outing Mamaroneck NY 2026",
      "golf outing Mamaroneck NY 2027",
      "charity golf tournament Mamaroneck NY 2026",
      "charity golf tournament Mamaroneck NY 2027",
      "golf scramble Mamaroneck NY September",
    ]);
    expect(qs("2026-12-01T07:15:00Z")).toEqual([
      "golf outing Mamaroneck NY 2027",
      "charity golf tournament Mamaroneck NY 2027",
      "golf scramble Mamaroneck NY December",
    ]);
  });

  it("stops at MAX_SERP_QUERIES_PER_RUN and records a budget hit", () => {
    const out = planSearch(ctxAt("2026-07-01T07:15:00Z"), {
      metros,
      courses: [],
      allowance: { MAX_SERP_QUERIES_PER_RUN: 5 },
    });
    expect(out.output.queries).toHaveLength(5);
    expect(out.result.budgetHits[0]).toMatchObject({ cap: "MAX_SERP_QUERIES_PER_RUN", limit: 5, stage: "discover" });
  });

  it("--prioritize-states: those states' metros and courses run tonight, first, in the order given", () => {
    const mixed = [
      { name: "Phoenix", state: "AZ", population: 5 },
      { name: "Hartford", state: "CT", population: 4 },
      { name: "Yonkers", state: "NY", population: 3 },
      { name: "Newark", state: "NJ", population: 2 },
      { name: "New York City", state: "NY", population: 1 },
    ];
    const stateCourses = [
      { id: "crs_az", name: "Encanto 18", outing_count: 1, notable: false, state: "AZ" },
      { id: "crs_ny", name: "Winged Foot Golf Club", outing_count: 0, notable: true, state: "NY" },
      { id: "crs_nj", name: "Baltusrol", outing_count: 2, notable: false, state: "NJ" },
    ];
    // 2026-10-03: monthly cadence; none of these would be scheduled on this night otherwise except index 2.
    const out = planSearch(ctxAt("2026-10-03T19:00:00Z"), {
      metros: mixed,
      courses: stateCourses,
      allowance: { MAX_SERP_QUERIES_PER_RUN: 450 },
      prioritize_states: ["NY", "NJ", "CT"],
    }).output.queries;
    const subjects = [...new Set(out.map((x) => x.subject))];
    expect(subjects).toEqual(["Yonkers, NY", "New York City, NY", "crs_ny", "Newark, NJ", "crs_nj", "Hartford, CT"]);
    expect(out.filter((x) => x.subject === "Yonkers, NY").map((x) => x.q)).toEqual([
      "golf outing Yonkers NY 2026",
      "golf outing Yonkers NY 2027",
      "charity golf tournament Yonkers NY 2026",
      "charity golf tournament Yonkers NY 2027",
      "golf scramble Yonkers NY October",
    ]);
    // Phoenix (index 0) and the AZ course are not due on day 3 and are not prioritized.
    expect(subjects).not.toContain("Phoenix, AZ");
    expect(subjects).not.toContain("crs_az");
  });

  it("prioritized queries come first when the cap cuts the night short", () => {
    const many = [
      ...Array.from({ length: 40 }, (_, i) => ({ name: `Az${i}`, state: "AZ", population: 1 })),
      { name: "Yonkers", state: "NY", population: 1 },
    ];
    const out = planSearch(ctxAt("2026-07-01T07:15:00Z"), {
      metros: many,
      courses: [],
      allowance: { MAX_SERP_QUERIES_PER_RUN: 3 },
      prioritize_states: ["NY"],
    });
    expect(out.output.queries.map((x) => x.subject)).toEqual(["Yonkers, NY", "Yonkers, NY", "Yonkers, NY"]);
    expect(out.result.budgetHits).toHaveLength(1);
  });

  it("plans nothing when the allowance is zero (monthly budget, spend cap)", () => {
    const out = planSearch(ctx, { metros, courses, allowance: { MAX_SERP_QUERIES_PER_RUN: 0 } });
    expect(out.output.queries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe("discover: platforms.yaml applies to search results and rechecks", () => {
  const rules: PlatformRule[] = [
    { name: "eventbrite", allowed: false, domains: ["eventbrite.*"], listing_url_pattern: "^/(d|b|o|cc)/" },
    { name: "golfgenius", allowed: true, domains: ["golfgenius.com"], listing_url_pattern: "^/$" },
  ];
  const serp = (url: string) => ({
    query: { kind: "place" as const, q: "golf outing Darien CT 2026", subject: "Darien, CT" },
    rank: 1,
    url,
    title: "t",
    snippet: "s",
  });

  it("drops an Eventbrite search listing and any page on a platform with allowed: false", () => {
    const out = discover(
      ctx,
      input({
        platform_rules: rules,
        serpResults: [
          serp("https://www.eventbrite.ca/d/ct--darien/golf-tournament/"),
          serp("https://www.eventbrite.com/e/9th-annual-1-club-golf-outing-tickets-1999044102724"),
          serp("https://www.golfgenius.com/pages/123-charity-classic"),
          serp("https://www.golfgenius.com/"),
          serp("https://www.fordham.edu/golf"),
        ],
      }),
    );
    expect(out.output.queue.map((q) => q.url)).toEqual([
      "https://www.golfgenius.com/pages/123-charity-classic",
      "https://www.fordham.edu/golf",
    ]);
    expect(out.output.skipped).toEqual(
      expect.arrayContaining([
        { url: "https://www.eventbrite.ca/d/ct--darien/golf-tournament/", reason: "platform_not_allowed" },
        { url: "https://www.golfgenius.com/", reason: "platform_listing" },
      ]),
    );
  });

  it("does not recheck an outing whose page is an Eventbrite listing", () => {
    const out = discover(
      ctx,
      input({
        platform_rules: rules,
        recheck: [recheck("o1", "2026-10-20", "2026-09-01T00:00:00Z", "https://www.eventbrite.ca/d/ct--darien/golf-tournament/")],
      }),
    );
    expect(out.output.queue).toEqual([]);
  });

  it("a series link, a submission or a leftover queue row on a disallowed platform is skipped too", () => {
    const out = discover(
      ctx,
      input({
        platform_rules: rules,
        listings: [
          {
            found_via: "series",
            origin: "acs-golf-classic",
            url: "https://www.eventbrite.com/e/acs-golf-classic-tickets-2",
            title: "ACS Golf Classic",
            text: null,
            registration_url: null,
          },
          {
            found_via: "series",
            origin: "acs-golf-classic",
            url: "https://akroncanton.acsgolf.org/",
            title: null,
            text: null,
            registration_url: null,
          },
        ],
        submissions: [{ id: "s1", url: "https://www.eventbrite.com/e/submitted-golf-outing-tickets-3", created_at: NOW }],
        pending: [
          {
            url: "https://www.eventbrite.com.au/d/nj--northfield/pine-beach-golf-outing/",
            found_via: "search_place",
            found_at: NOW,
            priority: 7,
            next_attempt_at: null,
            attempts: 0,
          },
        ],
      }),
    );
    expect(out.output.queue.map((q) => q.url)).toEqual(["https://akroncanton.acsgolf.org/"]);
    expect(out.output.processedSubmissionIds).toEqual(["s1"]);
    expect(out.output.skipped.filter((x) => x.reason === "platform_not_allowed")).toHaveLength(3);
  });
});

describe("discover: recheck queue", () => {
  it("force_recheck queues every published outing, due or not (within the 40% share)", () => {
    const fresh = recheck("o2", "2026-12-01", "2026-09-28T11:00:00Z");
    expect(discover(ctx, input({ recheck: [fresh] })).output.queue).toEqual([]);
    expect(discover(ctx, input({ recheck: [fresh], force_recheck: true })).output.queue.map((q) => q.recheck_outing_id)).toEqual(["o2"]);
  });

  it("rechecks every 7 days when more than 30 days out, else every 48 hours", () => {
    const out = discover(
      ctx,
      input({
        recheck: [
          recheck("far-fresh", "2026-12-01", "2026-09-22T12:00:01Z"), // 6.99 days: not due
          recheck("far-stale", "2026-12-01", "2026-09-21T12:00:00Z"), // 7 days: due
          recheck("near-fresh", "2026-10-10", "2026-09-26T12:00:01Z"), // < 48 h: not due
          recheck("near-stale", "2026-10-10", "2026-09-26T12:00:00Z"), // 48 h: due
          recheck("past", "2026-09-20", "2026-09-01T00:00:00Z"), // past: roll-forward handles it
        ],
      }),
    );
    expect(out.output.queue.map((q) => q.recheck_outing_id)).toEqual(["far-stale", "near-stale"]);
    expect(out.output.queue[0]).toMatchObject({
      found_via: "recheck",
      kind: "organizer",
      priority: PRIORITY.recheck,
      bypass_dedupe: true,
    });
  });

  it("goes oldest first and takes at most 40% of MAX_FETCHES_PER_RUN", () => {
    const c = ctxAt(NOW, { caps: { ...resolveBudget("nightly"), MAX_FETCHES_PER_RUN: 10 } });
    const recheckRows = Array.from({ length: 8 }, (_, i) =>
      recheck(`o${i}`, "2026-10-05", `2026-09-0${i + 1}T00:00:00Z`),
    ).reverse();
    const out = discover(c, input({ recheck: recheckRows, allowance: { MAX_FETCHES_PER_RUN: 10 } }));
    expect(out.output.queue.map((q) => q.recheck_outing_id)).toEqual(["o0", "o1", "o2", "o3"]);
    expect(out.result.budgetHits[0]).toMatchObject({ cap: "MAX_FETCHES_PER_RUN" });
  });

  it("bypasses the 7-day dedupe and keeps the source kind", () => {
    const url = "https://support.kidney.org/event/e1";
    const out = discover(
      ctx,
      input({
        recheck: [{ ...recheck("o1", "2026-10-19", "2026-09-20T00:00:00Z", url), source_kind: "platform" }],
        recentlyFetched: [{ url, fetched_at: "2026-09-27T00:00:00Z" }],
      }),
    );
    expect(out.output.queue).toHaveLength(1);
    expect(out.output.queue[0]?.kind).toBe("platform");
  });

  it("evaluates 'today' in the course's time zone", () => {
    // 2026-10-29 05:00 UTC is Oct 29 in New York (30 days out: 48-hour cadence)
    // and still Oct 28 in Los Angeles (31 days out: 7-day cadence).
    const c = ctxAt("2026-10-29T05:00:00Z");
    const row = { ...recheck("o", "2026-11-28", "2026-10-26T00:00:00Z"), time_zone: "America/Los_Angeles" };
    expect(discover(c, input({ recheck: [row] })).output.queue).toHaveLength(0);
    const ny = { ...row, time_zone: "America/New_York" };
    expect(discover(c, input({ recheck: [ny] })).output.queue).toHaveLength(1);
  });
});

describe("discover: sources, dedupe and exclusions", () => {
  it("normalizes URLs, strips tracking parameters and dedupes within the run", () => {
    const out = discover(
      ctx,
      input({
        submissions: [
          { id: "s1", url: "https://Example.org/golf?utm_source=x#top", created_at: NOW },
          { id: "s2", url: "https://example.org/golf", created_at: NOW },
        ],
      }),
    );
    expect(out.output.queue.map((q) => q.url)).toEqual(["https://example.org/golf"]);
    expect(out.output.skipped).toEqual([{ url: "https://example.org/golf", reason: "duplicate" }]);
    expect(out.output.processedSubmissionIds).toEqual(["s1", "s2"]);
  });

  it("marks invalid and excluded submissions processed and skips them", () => {
    const out = discover(
      ctx,
      input({
        submissions: [
          { id: "a", url: "javascript:alert(1)", created_at: NOW },
          { id: "b", url: "https://www.facebook.com/events/1", created_at: NOW },
          { id: "c", url: "https://example.org/members/list", created_at: NOW },
        ],
      }),
    );
    expect(out.output.queue).toEqual([]);
    expect(out.output.skipped.map((s) => s.reason)).toEqual(["invalid", "excluded", "excluded"]);
    expect(out.output.processedSubmissionIds).toEqual(["a", "b", "c"]);
  });

  it("skips URLs fetched in the last 7 days except series pages", () => {
    const recent = [
      { url: "https://org.example/a", fetched_at: "2026-09-25T00:00:00Z" },
      { url: "https://nkf.example/series/e1", fetched_at: "2026-09-27T00:00:00Z" },
      { url: "https://org.example/old", fetched_at: "2026-09-20T00:00:00Z" },
    ];
    const out = discover(
      ctx,
      input({
        recentlyFetched: recent,
        serpResults: [
          { query: { kind: "place", q: "golf outing X", subject: "X" }, rank: 1, url: "https://org.example/a", title: "Golf outing", snippet: "" },
          { query: { kind: "place", q: "golf outing X", subject: "X" }, rank: 2, url: "https://org.example/old", title: "Golf outing", snippet: "" },
        ],
        listings: [
          { found_via: "series", origin: "nkf", url: "https://nkf.example/series/e1", title: null, text: null, registration_url: null },
        ],
      }),
    );
    expect(out.output.queue.map((q) => [q.url, q.found_via, q.bypass_dedupe])).toEqual([
      ["https://nkf.example/series/e1", "series", true],
      ["https://org.example/old", "search_place", false],
    ]);
    expect(out.output.skipped).toEqual([{ url: "https://org.example/a", reason: "recent" }]);
  });

  it("enqueues platform events only when they mention golf with an outing word", () => {
    const link = (url: string, title: string) => ({
      found_via: "platform" as const,
      origin: "golfstatus",
      url,
      title,
      text: null,
      registration_url: null,
    });
    const out = discover(
      ctx,
      input({
        listings: [
          link("https://golfstatus.com/e/1", "Rotary Golf Classic 2026"),
          link("https://golfstatus.com/e/2", "Spring Gala Dinner"),
          link("https://golfstatus.com/e/3", "Golf Lessons for Juniors"),
          link("https://golfstatus.com/e/4-charity-golf-scramble", "Event"),
        ],
      }),
    );
    expect(out.output.queue.map((q) => q.url)).toEqual([
      "https://golfstatus.com/e/1",
      "https://golfstatus.com/e/4-charity-golf-scramble",
    ]);
    expect(out.output.queue[0]).toMatchObject({ kind: "platform", priority: PRIORITY.platform });
    expect(out.output.skipped.filter((s) => s.reason === "not_golf")).toHaveLength(2);
  });

  it("keeps a listing's own source kind when it gives one (workstream E)", () => {
    const out = discover(
      ctx,
      input({
        listings: [
          {
            found_via: "series",
            origin: "fixtures",
            url: "https://org.example/golf-classic",
            title: null,
            text: null,
            registration_url: null,
            kind: "organizer",
          },
          {
            found_via: "series",
            origin: "fixtures",
            url: "https://org.example/other",
            title: null,
            text: null,
            registration_url: null,
          },
        ],
      }),
    );
    expect(out.output.queue.map((q) => [q.url, q.kind, q.bypass_dedupe])).toEqual([
      ["https://org.example/golf-classic", "organizer", true],
      ["https://org.example/other", "series", true],
    ]);
  });

  it("enqueues a directory event page with its host, plus its off-directory registration link", () => {
    const out = discover(
      ctx,
      input({
        listings: [
          {
            found_via: "directory",
            origin: "scramblehunter.com",
            url: "https://scramblehunter.com/event/grady-charity-golf-scramble-2026/",
            title: "Grady Charity Golf Scramble 2026",
            text: null,
            registration_url: "https://www.golfstatus.com/tournaments/grady-2026",
          },
        ],
      }),
    );
    expect(out.output.queue).toEqual([
      queueEntrySchema.parse({
        url: "https://scramblehunter.com/event/grady-charity-golf-scramble-2026/",
        found_via: "directory",
        kind: "directory",
        priority: PRIORITY.directory,
        bypass_dedupe: false,
        recheck_outing_id: null,
        directory_host: "scramblehunter.com",
      }),
      queueEntrySchema.parse({
        url: "https://www.golfstatus.com/tournaments/grady-2026",
        found_via: "directory",
        kind: "organizer",
        priority: PRIORITY.directory,
        bypass_dedupe: false,
        recheck_outing_id: null,
        directory_host: null,
      }),
    ]);
  });

  it("enqueues association calendars and SERP results with their kinds", () => {
    const out = discover(
      ctx,
      input({
        listings: [
          { found_via: "association", origin: "Arizona Golf Association", url: "https://azgolf.org/charity-club-sanctioned-events", title: null, text: null, registration_url: null },
        ],
        serpResults: [
          { query: { kind: "course", q: '"Encanto 18" golf outing 2026', subject: "crs_1" }, rank: 1, url: "https://org.example/encanto", title: "t", snippet: "s" },
        ],
      }),
    );
    expect(out.output.queue.map((q) => [q.found_via, q.kind])).toEqual([
      ["association", "association"],
      ["search_course", "search"],
    ]);
  });

  it("retries held sources and requeues due rows from discovery_queue", () => {
    const out = discover(
      ctx,
      input({
        heldSources: [{ url: "https://held.example/e", held_until: "2026-10-05" }],
        pending: [
          { url: "https://pending.example/due", found_via: "search_place", found_at: "2026-09-27T07:00:00Z", priority: 8, next_attempt_at: null, attempts: 0 },
          { url: "https://pending.example/later", found_via: "platform", found_at: "2026-09-27T07:00:00Z", priority: 5, next_attempt_at: "2026-09-29T00:00:00Z", attempts: 1 },
          { url: "https://pending.example/bogus", found_via: "nonsense", found_at: "2026-09-27T07:00:00Z", priority: 5, next_attempt_at: null, attempts: 0 },
        ],
        serpResults: [
          { query: { kind: "place", q: "q", subject: "s" }, rank: 1, url: "https://pending.example/later", title: "", snippet: "" },
        ],
      }),
    );
    expect(out.output.queue.map((q) => [q.url, q.found_via])).toEqual([
      ["https://held.example/e", "held_retry"],
      ["https://pending.example/due", "search_place"],
    ]);
    expect(out.output.skipped).toContainEqual({ url: "https://pending.example/later", reason: "duplicate" });
    expect(out.output.skipped).toContainEqual({ url: "https://pending.example/bogus", reason: "invalid" });
  });

  it("orders by priority and keeps the stronger entry for a URL found twice", () => {
    const url = "https://org.example/classic";
    const out = discover(
      ctx,
      input({
        serpResults: [{ query: { kind: "place", q: "q", subject: "s" }, rank: 1, url, title: "", snippet: "" }],
        recheck: [recheck("o1", "2026-12-01", "2026-09-01T00:00:00Z", url)],
        submissions: [{ id: "s", url: "https://org.example/submitted", created_at: NOW }],
      }),
    );
    expect(out.output.queue.map((q) => [q.url, q.found_via])).toEqual([
      [url, "recheck"],
      ["https://org.example/submitted", "submission"],
    ]);
    expect(out.result.counters.urls_enqueued).toBe(2);
  });

  it("removals.yaml: a listed URL is never queued, whatever route found it, so it costs no fetch or extraction", () => {
    const removed = "https://org.example/removed-outing";
    const rctx = ctxAt(NOW, {
      overrides: emptyOverrides({
        // The owner may paste the URL with tracking parameters; it still matches.
        removals: { outing_ids: [], urls: [`${removed}?utm_source=mail`] },
      }),
    });
    const q = { kind: "place" as const, q: "golf outing X", subject: "X" };
    const out = discover(
      rctx,
      input({
        recheck: [recheck("o1", "2026-10-01", "2026-09-20T00:00:00Z", removed)],
        submissions: [{ id: "s1", url: `${removed}#top`, created_at: NOW }],
        serpResults: [
          { query: q, rank: 1, url: removed, title: "Golf outing", snippet: "" },
          { query: q, rank: 2, url: "https://org.example/kept", title: "Golf outing", snippet: "" },
        ],
        listings: [
          { found_via: "series", origin: "s", url: removed, title: null, text: null, registration_url: null },
        ],
        heldSources: [{ url: removed, held_until: "2026-12-31" }],
        pending: [
          { url: removed, found_via: "search_place", found_at: NOW, priority: 8, next_attempt_at: null, attempts: 0 },
        ],
      }),
    );
    expect(out.output.queue.map((x) => x.url)).toEqual(["https://org.example/kept"]);
    const reasons = out.output.skipped.filter((s) => s.url === removed).map((s) => s.reason);
    expect(reasons.length).toBe(6);
    expect(new Set(reasons)).toEqual(new Set(["removed"]));
    // The submission is still consumed.
    expect(out.output.processedSubmissionIds).toEqual(["s1"]);
  });

  it("removals.yaml: an outing removed by id is not rechecked, but its page stays reachable for other outings", () => {
    const page = "https://azgolf.example/calendar";
    const rctx = ctxAt(NOW, {
      overrides: emptyOverrides({ removals: { outing_ids: ["gone"], urls: [] } }),
    });
    const out = discover(
      rctx,
      input({
        recheck: [
          recheck("gone", "2026-10-01", "2026-09-20T00:00:00Z", "https://org.example/gone"),
          recheck("kept", "2026-10-02", "2026-09-20T00:00:00Z", page),
        ],
      }),
    );
    expect(out.output.queue.map((x) => [x.url, x.recheck_outing_id])).toEqual([[page, "kept"]]);
    expect(out.output.skipped).toEqual([{ url: "https://org.example/gone", reason: "removed" }]);
  });

  it("accepts every input the zod schema accepts", () => {
    expect(() => discover(ctx, discoverInputSchema.parse(input()))).not.toThrow();
  });
});

describe("isGolfOutingText", () => {
  it("needs golf and an outing word", () => {
    expect(isGolfOutingText("Annual Golf Outing")).toBe(true);
    expect(isGolfOutingText("charity-golf-invitational")).toBe(true);
    expect(isGolfOutingText("Golf lessons")).toBe(false);
    expect(isGolfOutingText("Tennis tournament")).toBe(false);
    expect(isGolfOutingText("Minigolf scramble")).toBe(false);
  });
});
