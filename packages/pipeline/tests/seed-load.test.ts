/**
 * The whole seed (places, fixture courses, seed/outings.json) as literal SQL,
 * applied to node:sqlite with the D1 migration, then read back with the site's
 * typed queries. Offline.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  cityBySlug,
  courseBySlug,
  listExpectedOutings,
  outingBySlug,
  upcomingOutingsByCity,
  type GofDb,
} from "@gof/db/queries";
import { drizzleOver, migratedSqlite, type Sqlite } from "@gof/db/testing";
import { buildSeed, type SeedBuild } from "../src/seed.ts";
import {
  D1_MAX_ROWS_PER_STATEMENT,
  D1_MAX_STATEMENTS_PER_FILE,
  D1_MAX_STATEMENT_BYTES,
  chunkStatements,
} from "../src/sql/literal.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const TODAY = "2026-09-28";

function load(build: SeedBuild): Sqlite {
  const sqlite = migratedSqlite();
  for (const file of chunkStatements(build.statements)) sqlite.exec(file.join("\n"));
  return sqlite;
}

const count = (db: Sqlite, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

let build: SeedBuild;
let sqlite: Sqlite;
let db: GofDb;

beforeAll(async () => {
  build = await buildSeed({ now: NOW, includeTestEntries: false });
  sqlite = load(build);
  db = drizzleOver(sqlite);
});

describe("seed SQL", () => {
  it("respects the D1 limits: literal values, <= 50 rows and < 100 KB per statement", () => {
    for (const s of build.statements) {
      expect(Buffer.byteLength(s)).toBeLessThan(D1_MAX_STATEMENT_BYTES);
      expect(s).not.toMatch(/\?\s*[,)]/);
      const tuples = s.startsWith("INSERT") ? (s.match(/\),\(/g)?.length ?? 0) + 1 : 0;
      expect(tuples).toBeLessThanOrEqual(D1_MAX_ROWS_PER_STATEMENT);
    }
    for (const f of chunkStatements(build.statements)) expect(f.length).toBeLessThanOrEqual(D1_MAX_STATEMENTS_PER_FILE);
  });

  it("loads 30 outings: 29 published and e17 held with no_date; skips s14 and s15", () => {
    expect(build.plan.skipped.sort()).toEqual(["s14-panther-national-package", "s15-synthetic-oakmont-glendale"]);
    expect(count(sqlite, "SELECT count(*) AS n FROM outings")).toBe(30);
    expect(count(sqlite, "SELECT count(*) AS n FROM outings WHERE published = 1")).toBe(29);
    const held = sqlite.prepare("SELECT title, hold_reason, published, status FROM outings WHERE published = 0").all();
    expect(held).toEqual([
      { title: "Buoniconti Fund Celebrity Golf Invitational", hold_reason: "no_date", published: 0, status: "expected" },
    ]);
    expect(count(sqlite, "SELECT count(*) AS n FROM outings WHERE status = 'open'")).toBe(13);
    expect(count(sqlite, "SELECT count(*) AS n FROM outings WHERE status = 'expected'")).toBe(17);
  });

  it("loads cities, ZIPs, courses, organizers and sources", () => {
    expect(count(sqlite, "SELECT count(*) AS n FROM cities")).toBe(build.counts.cities);
    expect(count(sqlite, "SELECT count(*) AS n FROM zips")).toBe(build.counts.zips);
    expect(count(sqlite, "SELECT count(*) AS n FROM courses")).toBe(build.counts.courses);
    // NKF and Golf With Access each run two outings; s01 and s10 have no organizer.
    expect(count(sqlite, "SELECT count(*) AS n FROM organizers")).toBe(26);
    expect(count(sqlite, "SELECT count(*) AS n FROM organizers WHERE charity_status <> 'unverified'")).toBe(0);
    // The azgolf.org calendar is one source for two outings (s01, s09).
    expect(
      count(
        sqlite,
        "SELECT count(*) AS n FROM source_outings so JOIN sources s ON s.id = so.source_id WHERE s.url = 'https://azgolf.org/charity-club-sanctioned-events'",
      ),
    ).toBe(2);
  });

  it("stores money in cents and expected months as given", () => {
    const row = (title: string) =>
      sqlite.prepare("SELECT * FROM outings WHERE title = ?").get(title) as Record<string, unknown>;
    expect(row("30th Annual Scholarship Golf Classic")).toMatchObject({ single_price_cents: 11922, status: "expected", expected_month: "2027-08" });
    expect(row("Autism Speaks Golf Classic")).toMatchObject({ foursome_price_cents: 540000 });
    expect(row("Valley Hospital Auxiliary Golf Outing")).toMatchObject({ start_date: "2027-06-07", expected_month: "2027-06", status: "expected" });
    expect(row("Mercy Care Golf Classic")).toMatchObject({ expected_month: "2026-10", start_date: null, published: 1 });
    expect(row("Hyslop Drive Fore A Cure")).toMatchObject({ single_price_cents: 22000, foursome_price_cents: 88000 });
  });

  it("puts both Winged Foot outings on /golf-outings/ny/mamaroneck as private courses with Register links", async () => {
    const city = await cityBySlug(db, "ny", "mamaroneck");
    expect(city?.name).toBe("Mamaroneck");
    const rows = await upcomingOutingsByCity(db, "NY", city?.name ?? "", TODAY);
    expect(rows.map((r) => [r.startDate, r.course.name, r.course.courseType])).toEqual([
      ["2026-10-13", "Winged Foot Golf Club", "private"],
      ["2026-10-19", "Winged Foot Golf Club", "private"],
    ]);
    expect(rows.map((r) => r.registrationUrl)).toEqual([
      "https://now.fordham.edu/event/fordham-golf-classic-2026/",
      "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
    ]);
    expect(rows.map((r) => r.label)).toEqual(["School fundraiser", "Fundraiser, charity status unverified"]);
  });

  it("serves the NKF Winged Foot outing with a 12:00 shotgun in America/New_York", async () => {
    const nkf = build.plan.outings.find((o) => o.title === "NKF Golf Classic at Winged Foot Golf Club");
    const o = await outingBySlug(db, nkf?.slug ?? "");
    expect(o).toMatchObject({ startDate: "2026-10-19", shotgunTime: "12:00", outingType: "charity" });
    expect(o?.course.timeZone).toBe("America/New_York");
  });

  it("gc4: Encanto 18 is municipal and its charity outing has no organizer", async () => {
    const enc = build.plan.matches.find((m) => m.seedId === "s01-encanto-pejatc");
    expect(enc?.courseName).toBe("Encanto Golf Course");
    const rows = await upcomingOutingsByCity(db, "AZ", "Phoenix", TODAY);
    const pejatc = rows.find((r) => r.title.startsWith("Scramble benefiting PEJATC"));
    expect(pejatc).toMatchObject({ outingType: "charity", label: "Fundraiser, charity status unverified", organizer: null });
    expect(pejatc?.course.courseType).toBe("municipal");
    expect(pejatc?.singlePriceCents).toBe(12500);
  });

  it("returns 404 (null) for a course with no outings and a page for a seeded course", async () => {
    const empty = build.plan.courses.find((c) => c.outingCount === 0);
    expect(empty).toBeDefined();
    expect(await courseBySlug(db, empty?.slug ?? "")).toBeNull();
    expect((await courseBySlug(db, "ny/winged-foot-golf-club"))?.outingCount).toBe(3);
  });

  it("lists published expected outings and keeps e17 out", async () => {
    const rows = await listExpectedOutings(db);
    expect(rows).toHaveLength(16);
    expect(rows.some((r) => r.title.startsWith("Buoniconti"))).toBe(false);
  });

  it("loads the synthetic and excluded entries only with --include-test-entries", async () => {
    const withTests = await buildSeed({ now: NOW, includeTestEntries: true });
    const s = load(withTests);
    expect(count(s, "SELECT count(*) AS n FROM outings")).toBe(32);
    const glendale = s
      .prepare("SELECT c.osm_ref, c.state FROM outings o JOIN courses c ON c.id = o.course_id WHERE o.title LIKE 'Synthetic test%'")
      .get();
    // gc7: the Glendale, CA course (way/369572200), never Oakmont PA (relation/6174192).
    expect(glendale).toEqual({ osm_ref: "way/369572200", state: "CA" });
    expect(count(s, "SELECT count(*) AS n FROM outings WHERE published = 1")).toBe(30);
  });
});
