import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryD1 } from "../d1/memory.ts";
import { sourceIdForUrl } from "../extract/ids.ts";
import { EXTRACTOR_VERSION } from "../extract/prompt.ts";
import { matched, NOW, outingRow, sourceRow, testCtx } from "../extract/test-helpers.ts";
import { dedupeUpsert, slugTitle } from "./dedupe-upsert.ts";
import { publish } from "./publish.ts";
import { recheckRollForward, rolledSlug, rolledTitle } from "./recheck-roll-forward.ts";
import { outingRowSchema, sourceRowSchema } from "./rows.ts";
import type { CourseRow, DedupeUpsertInput, OutingRow } from "./types.ts";

const course: CourseRow = {
  id: "crs_encanto",
  slug: "az/encanto-18-golf-course",
  name: "Encanto 18 Golf Course",
  aliases: "[]",
  street: null,
  city: "Phoenix",
  state: "AZ",
  zip: null,
  lat: 33.47,
  lng: -112.09,
  time_zone: "America/Phoenix",
  course_type: "municipal",
  course_type_source: "override",
  course_type_confidence: null,
  notable: 0,
  website: null,
  osm_ref: null,
  outing_count: 0,
  last_outing_date: null,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

async function db(): Promise<MemoryD1> {
  const d1 = new MemoryD1();
  await d1.apply({ ops: [{ op: "upsert", table: "courses", rows: [course] }] });
  return d1;
}

const org1 = {
  id: "org_1",
  slug: "friends-of-the-park",
  name: "Friends of the Park",
  org_type: "charity" as const,
  ein: null,
  charity_status: "unverified" as const,
  irs_subsection: null,
  website: null,
  series_id: null,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

async function dbWithOrg(): Promise<MemoryD1> {
  const d1 = await db();
  await d1.apply({ ops: [{ op: "upsert", table: "organizers", rows: [org1] }] });
  return d1;
}

const emptyExisting: DedupeUpsertInput["existing"] = {
  outings: [],
  organizers: [],
  sources: [],
  outingSlugs: [],
  organizerSlugs: [],
};

async function outings(d1: MemoryD1): Promise<OutingRow[]> {
  return (await d1.snapshot()).all("SELECT * FROM outings ORDER BY slug", outingRowSchema);
}

describe("dedupe-upsert", () => {
  it("inserts one outing per course, date and organizer, merging sources by precedence", async () => {
    const d1 = await db();
    const fromDirectory = matched({
      source_url: "https://scramblehunter.com/event/spring/",
      source_kind: "directory",
      directory_host: "scramblehunter.com",
      single_price_cents: 9_900,
      shotgun_time: null,
      registration_url: "https://www.golfstatus.com/t/spring",
    });
    const fromOrganizer = matched({ organizer_name: "Friends of the Park Inc", shotgun_time: "07:00" });
    const { output, result } = dedupeUpsert(testCtx(), {
      outings: [fromDirectory, fromOrganizer],
      existing: emptyExisting,
      unchanged: [],
      fetches: [],
    });
    await d1.apply(output.plan);
    const rows = await outings(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "2026/spring-charity-scramble-encanto-18",
      canonical_source_url: "https://example.org/golf",
      single_price_cents: 12_500,
      shotgun_time: "07:00",
      registration_url: "https://www.golfstatus.com/t/spring",
      published: 0,
      status: "open",
    });
    expect(output.outcomes.map((o) => o.action).sort()).toEqual(["insert", "merge"]);
    expect(result.counters).toMatchObject({ outings_new: 1, outings_updated: 0, outings_held: 0 });
    const links = (await d1.snapshot()).all(
      "SELECT source_id, outing_id FROM source_outings ORDER BY source_id",
      z.object({ source_id: z.string(), outing_id: z.string() }),
    );
    expect(links).toHaveLength(2);
    const org = (await d1.snapshot()).all("SELECT slug, org_type FROM organizers", z.object({ slug: z.string(), org_type: z.string() }));
    expect(org).toEqual([{ slug: "friends-of-the-park-inc", org_type: "charity" }]);
  });

  it("keeps different organizers on the same course and date apart, and suffixes the slug", async () => {
    const d1 = await db();
    const { output } = dedupeUpsert(testCtx(), {
      outings: [matched(), matched({ organizer_name: "Rotary Club of Phoenix", source_url: "https://rotary.example/golf" })],
      existing: emptyExisting,
      unchanged: [],
      fetches: [],
    });
    await d1.apply(output.plan);
    expect((await outings(d1)).map((o) => o.slug)).toEqual([
      "2026/spring-charity-scramble-encanto-18",
      "2026/spring-charity-scramble-encanto-18-2",
    ]);
  });

  it("holds events on their source with held_until 30 days out, never as outings", async () => {
    const d1 = await db();
    const { output, result } = dedupeUpsert(testCtx(), {
      outings: [
        matched({ hold_reason: "course_unmatched" }, null),
        matched({ hold_reason: "status_unknown", source_url: "https://other.example/x" }),
        matched({ excluded: true, exclude_reason: "resort_package", source_url: "https://third.example/y" }),
      ],
      existing: emptyExisting,
      unchanged: [],
      fetches: [],
    });
    await d1.apply(output.plan);
    expect(await outings(d1)).toEqual([]);
    const srcs = (await d1.snapshot()).all("SELECT * FROM sources ORDER BY url", sourceRowSchema);
    expect(srcs.map((s) => [s.url, s.hold_reason, s.held_until])).toEqual([
      ["https://example.org/golf", "course_unmatched", "2026-10-28"],
      ["https://other.example/x", "status_unknown", "2026-10-28"],
      ["https://third.example/y", null, null],
    ]);
    expect(result.counters.outings_held).toBe(2);
    expect(output.outcomes.map((o) => o.action)).toEqual(["excluded", "held", "held"]);
  });

  it("publishes a low-confidence hold once a second independent source agrees on course and date", () => {
    const { output } = dedupeUpsert(testCtx(), {
      outings: [
        matched({ hold_reason: "low_confidence", confidence: 0.7 }),
        matched({ hold_reason: "low_confidence", confidence: 0.6, source_url: "https://azgolf.org/cal", source_kind: "association" }),
      ],
      existing: emptyExisting,
      unchanged: [],
      fetches: [],
    });
    expect(output.outcomes.map((o) => o.action).sort()).toEqual(["insert", "merge"]);
    const op = output.plan.ops.find((o) => o.op === "upsert" && o.table === "outings");
    expect(op && op.op === "upsert" ? (op.rows[0] as OutingRow).confidence : null).toBe(0.75);
  });

  it("updates an existing outing in place and confirms an expected row in place", async () => {
    const d1 = await dbWithOrg();
    const existingOrg = { id: "org_1", slug: "friends-of-the-park", name: "Friends of the Park", ein: null, charity_status: "unverified" as const };
    const dated = outingRow({ id: "out_dated", published: 1 });
    const expected = outingRow({
      id: "out_exp",
      slug: "2026/fall-classic-encanto-18",
      title: "Fall Classic",
      status: "expected",
      start_date: null,
      expected_month: "2026-11",
      published: 1,
    });
    await d1.apply({
      ops: [
        { op: "upsert", table: "outings", rows: [dated, expected] },
      ],
    });
    const { output } = dedupeUpsert(testCtx(), {
      outings: [
        matched({ single_price_cents: 15_000 }),
        matched({ title: "Fall Classic 2026", start_date: "2026-10-24", source_url: "https://example.org/fall" }),
      ],
      existing: { ...emptyExisting, outings: [dated, expected], organizers: [existingOrg], outingSlugs: [dated.slug, expected.slug] },
      unchanged: [],
      fetches: [],
    });
    await d1.apply(output.plan);
    const rows = await outings(d1);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "out_dated")).toMatchObject({ single_price_cents: 15_000, published: 1, slug: dated.slug });
    expect(rows.find((r) => r.id === "out_exp")).toMatchObject({
      status: "open",
      start_date: "2026-10-24",
      expected_month: null,
      slug: "2026/fall-classic-encanto-18",
    });
    expect(output.outcomes.map((o) => o.action)).toEqual(["update", "confirm_expected"]);
  });

  it("keeps sources bookkeeping: consecutive 404s, hashes, and last_verified for unchanged pages", async () => {
    const d1 = await db();
    const prev = sourceRow({ id: "src_old", url: "https://example.org/gone", consecutive_gone: 1 });
    const { output } = dedupeUpsert(testCtx(), {
      outings: [],
      existing: { ...emptyExisting, sources: [prev] },
      unchanged: [{ url: "https://example.org/golf", recheck_outing_id: "out_1" }],
      fetches: [
        { url: "https://example.org/gone", kind: "organizer", http_status: 404, outcome: "not_found", hash: null, extracted_json: null, error: null },
        { url: "https://example.org/new", kind: "platform", http_status: 200, outcome: "ok", hash: "b".repeat(64), extracted_json: '{"events":[]}', error: null },
      ],
    });
    await d1.apply(output.plan);
    const srcs = (await d1.snapshot()).all("SELECT * FROM sources ORDER BY url", sourceRowSchema);
    expect(srcs.map((s) => [s.id, s.consecutive_gone, s.content_hash?.slice(0, 1) ?? null, s.extractor_version])).toEqual([
      ["src_old", 2, null, null],
      [sourceIdForUrl("https://example.org/new"), 0, "b", EXTRACTOR_VERSION],
    ]);
    expect(output.plan.ops.filter((o) => o.op === "update" && o.table === "outings")).toHaveLength(2);
  });
});

describe("outing slug titles", () => {
  it("drop the venue the slug already ends with", () => {
    expect(slugTitle("2026 NKF Golf Classic at Winged Foot Golf Club", "Winged Foot Golf Club")).toBe("2026 NKF Golf Classic");
    expect(slugTitle("Two Man Links at Torrey Pines", "Torrey Pines Golf Course (South)")).toBe("Two Man Links");
    expect(slugTitle("Fun at the Lake", "Encanto 18 Golf Course")).toBe("Fun at the Lake");
    expect(slugTitle("Encanto 18 Golf Course", "Encanto 18 Golf Course")).toBe("Encanto 18 Golf Course");
  });
});

describe("publish", () => {
  const entry = (o: OutingRow, tz = "America/Phoenix") => ({ outing: o, time_zone: tz, source_urls: [o.canonical_source_url] });

  it("publishes matched, upcoming, confident dated outings and expected rows with an organizer and month", () => {
    const { output, result } = publish(testCtx(), {
      outings: [
        entry(outingRow({ id: "a" })),
        entry(outingRow({ id: "b", confidence: 0.74 })),
        entry(outingRow({ id: "c", start_date: "2026-09-27" })),
        entry(outingRow({ id: "d", start_date: "2026-09-26", end_date: "2026-09-29" })),
        entry(outingRow({ id: "e", status: "expected", start_date: null, expected_month: "2027-04" })),
        entry(outingRow({ id: "f", status: "expected", start_date: null, expected_month: null })),
        entry(outingRow({ id: "g", status: "expected", start_date: null, expected_month: "2027-04", organizer_id: null })),
        entry(outingRow({ id: "h", status: "expected", start_date: "2027-04-12", expected_month: "2027-04" })),
      ],
      heldSources: [],
      changed: [],
    });
    const by = Object.fromEntries(output.decisions.map((d) => [d.outing_id, d]));
    expect(Object.fromEntries(Object.entries(by).map(([k, d]) => [k, [d.publish, d.hold_reason, d.event_markup]]))).toEqual({
      a: [true, null, true],
      b: [false, "low_confidence", true],
      c: [false, null, true],
      d: [true, null, true],
      e: [true, null, false],
      f: [false, "no_date", false],
      g: [false, null, false],
      h: [true, null, false],
    });
    expect(output.indexnowUrls).toEqual([
      "/outings/2026/spring-charity-scramble-encanto-18",
      "/outings/2026/spring-charity-scramble-encanto-18",
      "/outings/2026/spring-charity-scramble-encanto-18",
      "/outings/2026/spring-charity-scramble-encanto-18",
    ]);
    expect(result.counters.indexnow_urls).toBe(4);
  });

  const eventbriteRules = (allowed: boolean) => [
    { name: "eventbrite", allowed, domains: ["eventbrite.*"], listing_url_pattern: "^/(d|b|o|cc)/" },
  ];

  it("never publishes an outing whose canonical source is a platform listing page", () => {
    const { output } = publish(testCtx(), {
      outings: [
        entry(outingRow({ id: "listing", canonical_source_url: "https://www.eventbrite.ca/d/ct--darien/golf-tournament/" })),
        entry(outingRow({ id: "event", canonical_source_url: "https://www.eventbrite.com/e/1-club-golf-outing-tickets-1" })),
        entry(
          outingRow({
            id: "past-listing",
            status: "past",
            published: 1,
            start_date: "2026-09-01",
            canonical_source_url: "https://www.eventbrite.com/d/nj--northfield/golf/",
          }),
        ),
      ],
      heldSources: [],
      changed: [],
      platform_rules: eventbriteRules(true),
    });
    expect(output.decisions.map((d) => [d.outing_id, d.publish, d.why])).toEqual([
      ["listing", false, "platform_listing"],
      ["event", true, "dated"],
      ["past-listing", false, "platform_listing"],
    ]);
  });

  it("an outing that only pages on a disallowed platform support doesn't publish; another source keeps it", () => {
    const ev = "https://www.eventbrite.com/e/9th-annual-1-club-golf-outing-tickets-1999044102724";
    const only = outingRow({ id: "only", canonical_source_url: ev });
    const also = outingRow({ id: "also", canonical_source_url: ev });
    const { output } = publish(testCtx(), {
      outings: [entry(only), { ...entry(also), source_urls: [ev, "https://club.example/outing"] }],
      heldSources: [],
      changed: [],
      platform_rules: eventbriteRules(false),
    });
    expect(output.decisions.map((d) => [d.outing_id, d.publish, d.hold_reason, d.why])).toEqual([
      ["only", false, null, "platform_not_allowed"],
      ["also", true, null, "dated"],
    ]);
  });

  it("removals.yaml still wins over the platform rule", () => {
    const url = "https://www.eventbrite.ca/d/ct--darien/golf-tournament/";
    const { output } = publish(testCtx({ removals: { outing_ids: [], urls: [url] } }), {
      outings: [entry(outingRow({ id: "gone", canonical_source_url: url, published: 1 }))],
      heldSources: [],
      changed: [],
      platform_rules: eventbriteRules(false),
    });
    expect(output.decisions.map((d) => [d.publish, d.hold_reason, d.why])).toEqual([[false, "removed", "removed"]]);
  });

  it("honors removals.yaml by id or URL and pings only on publish or material change", async () => {
    const d1 = await dbWithOrg();
    const rows = [
      outingRow({ id: "kept", published: 1 }),
      outingRow({ id: "by_id", slug: "2026/x-encanto-18", published: 1, organizer_id: null }),
      outingRow({ id: "by_url", slug: "2026/y-encanto-18", published: 1, organizer_id: null, start_date: "2026-10-04", canonical_source_url: "https://removed.example/z" }),
      outingRow({ id: "changed", slug: "2026/z-encanto-18", published: 1, organizer_id: null, start_date: "2026-10-05" }),
    ];
    await d1.apply({ ops: [{ op: "upsert", table: "outings", rows }] });
    const ctx = testCtx({ removals: { outing_ids: ["by_id"], urls: ["https://removed.example/z"] } });
    const { output } = publish(ctx, { outings: rows.map((o) => entry(o)), heldSources: [], changed: ["changed"] });
    await d1.apply(output.plan);
    const after = await outings(d1);
    expect(after.map((o) => [o.id, o.published, o.hold_reason])).toEqual([
      ["kept", 1, null],
      ["by_id", 0, "removed"],
      ["by_url", 0, "removed"],
      ["changed", 1, null],
    ]);
    expect(output.indexnowUrls).toEqual(["/outings/2026/z-encanto-18"]);
  });
});

describe("recheck and roll forward", () => {
  const entry = (o: OutingRow, urls: string[] = [o.canonical_source_url]) => ({ outing: o, time_zone: "America/Phoenix", source_urls: urls });

  it("sets past the day after end_date ?? start_date and rolls forward to next year's month", async () => {
    const d1 = await dbWithOrg();
    const done = outingRow({ id: "done", title: "Spring Scramble 2026", slug: "2026/spring-scramble-encanto-18", start_date: "2026-09-20", published: 1 });
    const running = outingRow({ id: "running", slug: "2026/b-encanto-18", start_date: "2026-09-25", end_date: "2026-09-28", organizer_id: null });
    await d1.apply({
      ops: [
        { op: "upsert", table: "outings", rows: [done, running] },
      ],
    });
    const { output } = recheckRollForward(testCtx(), {
      outings: [entry(done), entry(running)],
      sources: [],
      outingSlugs: [done.slug, running.slug],
    });
    expect(output.past).toEqual(["done"]);
    await d1.apply(output.plan);
    const rows = await outings(d1);
    const next = rows.find((r) => r.status === "expected")!;
    expect(next).toMatchObject({
      slug: "2027/spring-scramble-encanto-18",
      title: "Spring Scramble 2027",
      expected_month: "2027-09",
      start_date: null,
      organizer_id: "org_1",
      course_id: "crs_encanto",
    });
    expect(rows.find((r) => r.id === "done")).toMatchObject({ status: "past", next_outing_id: next.id });
    expect(rows.find((r) => r.id === "running")?.status).toBe("open");
    expect(output.rolledForward).toEqual([{ from: "done", to: next.id }]);
  });

  it("links to an expected row that already exists instead of creating another", () => {
    const done = outingRow({ id: "done", start_date: "2026-09-20" });
    const exp = outingRow({ id: "exp", status: "expected", start_date: null, expected_month: "2027-10" });
    const { output } = recheckRollForward(testCtx(), { outings: [entry(done), entry(exp)], sources: [], outingSlugs: [] });
    expect(output.rolledForward).toEqual([]);
    expect(output.plan.ops).toContainEqual(
      expect.objectContaining({ op: "update", where: { id: "done" }, set: expect.objectContaining({ next_outing_id: "exp", status: "past" }) }),
    );
  });

  it("moves an unconfirmed expected row 12 months once, then stales it", () => {
    const e1 = outingRow({ id: "e1", status: "expected", start_date: null, expected_month: "2026-07", published: 1 });
    const e2 = outingRow({ id: "e2", status: "expected", start_date: null, expected_month: "2026-07", expected_misses: 1, published: 1 });
    const e3 = outingRow({ id: "e3", status: "expected", start_date: null, expected_month: "2026-08", published: 1 });
    const { output } = recheckRollForward(testCtx(), { outings: [entry(e1), entry(e2), entry(e3)], sources: [], outingSlugs: [] });
    expect(output.expectedBumped).toEqual(["e1"]);
    expect(output.expectedStale).toEqual(["e2"]);
    expect(output.plan.ops).toContainEqual(
      expect.objectContaining({ where: { id: "e1" }, set: expect.objectContaining({ expected_month: "2027-07", expected_misses: 1 }) }),
    );
    expect(output.plan.ops).toContainEqual(
      expect.objectContaining({ where: { id: "e2" }, set: expect.objectContaining({ published: 0, hold_reason: "expected_stale" }) }),
    );
  });

  it("sets source_gone after two consecutive 404/410s unless another source is alive", () => {
    const a = outingRow({ id: "a" });
    const b = outingRow({ id: "b", canonical_source_url: "https://gone.example/b" });
    const { output } = recheckRollForward(testCtx(), {
      outings: [entry(a), entry(b, ["https://gone.example/b", "https://alive.example/b"])],
      sources: [
        sourceRow({ url: "https://example.org/golf", consecutive_gone: 2, http_status: 410 }),
        sourceRow({ id: "s2", url: "https://gone.example/b", consecutive_gone: 3, http_status: 404 }),
        sourceRow({ id: "s3", url: "https://alive.example/b" }),
      ],
      outingSlugs: [],
    });
    expect(output.sourceGone).toEqual(["a"]);
    expect(output.plan.ops).toContainEqual(
      expect.objectContaining({ where: { id: "b" }, set: expect.objectContaining({ canonical_source_url: "https://alive.example/b" }) }),
    );
    const one = recheckRollForward(testCtx(), {
      outings: [entry(a)],
      sources: [sourceRow({ consecutive_gone: 1, http_status: 404 })],
      outingSlugs: [],
    });
    expect(one.output.sourceGone).toEqual([]);
  });

  it("builds next year's slug and title", () => {
    expect(rolledSlug("2026/nkf-golf-classic-winged-foot", 2027, new Set(["2027/nkf-golf-classic-winged-foot"]))).toBe(
      "2027/nkf-golf-classic-winged-foot-2",
    );
    expect(rolledTitle("Fordham Golf Classic 2026", 2026)).toBe("Fordham Golf Classic 2027");
  });

  it("uses the pinned clock, not the wall clock", () => {
    expect(NOW.toISOString()).toBe("2026-09-28T12:00:00.000Z");
  });
});
