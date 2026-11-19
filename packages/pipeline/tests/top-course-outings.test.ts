/**
 * Appending hand-researched outings to a database that already holds the seed:
 * nothing existing is deleted or changed, foreign keys resolve against the
 * target's own ids, duplicates and unmatched courses are skipped, and a second
 * run adds nothing. Offline.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { migratedSqlite, type Sqlite } from "@gof/db/testing";
import { loadCourseContext } from "../src/seed/context.ts";
import { seedFileSchema, type SeedFile } from "../src/seed/seed-file.ts";
import { buildSeed } from "../src/seed.ts";
import { chunkStatements } from "../src/sql/literal.ts";
import { buildAppendPlan, targetSnapshotSchema, type AppendInput, type TargetSnapshot } from "../src/topcourses/plan.ts";
import type { CourseRecord } from "../src/courses/import.ts";
import type { PlaceLocator } from "../src/places/locator.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const LATER = Date.parse("2026-11-17T12:00:00Z");

const apply = (db: Sqlite, statements: readonly string[]): void => {
  for (const f of chunkStatements(statements)) db.exec(f.join("\n"));
};
const count = (db: Sqlite, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

function snapshot(db: Sqlite): TargetSnapshot {
  return targetSnapshotSchema.parse({
    courses: db.prepare("SELECT id, slug, osm_ref FROM courses").all(),
    organizers: db.prepare("SELECT id, slug, name FROM organizers").all(),
    outings: db.prepare("SELECT slug, course_id, start_date, organizer_id, canonical_source_url FROM outings").all(),
  });
}

const entries: SeedFile = seedFileSchema.parse({
  version: "test",
  outings: [
    {
      id: "t01-oakmont-new",
      status: "open",
      title: "Charity Classic at Oakmont",
      organizer_name: "National Kidney Foundation",
      course_name: "Oakmont Country Club",
      course_city: "Oakmont",
      course_state: "PA",
      start_date: "2027-06-07",
      single_price_usd: 1500,
      source_url: "https://example.org/oakmont-classic-2027",
      registration_url: "https://example.org/oakmont-classic-2027/register",
      source_kind: "organizer",
      expected_outing_type: "charity",
    },
    {
      // Same page as seed s06: already loaded.
      id: "t02-nkf-winged-foot-dup",
      status: "open",
      title: "NKF Golf Classic at Winged Foot Golf Club",
      organizer_name: "National Kidney Foundation",
      course_name: "Winged Foot Golf Club",
      course_city: "Mamaroneck",
      course_state: "NY",
      start_date: "2026-10-19",
      source_url: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893",
      source_kind: "organizer",
      expected_outing_type: "charity",
    },
    {
      id: "t03-riviera-expected",
      status: "expected",
      title: "Riviera Charity Pro-Am",
      organizer_name: "Example Youth Foundation",
      course_name: "Riviera Country Club",
      course_city: "Pacific Palisades",
      course_state: "CA",
      expected_month: "2027-05",
      last_date: "2026-05-11",
      source_url: "https://example.org/riviera-pro-am",
      source_kind: "organizer",
      expected_outing_type: "charity",
    },
    {
      id: "t04-nowhere",
      status: "open",
      title: "Outing at a course nobody imported",
      course_name: "Imaginary Links",
      course_city: "Nowhere",
      course_state: "PA",
      start_date: "2027-07-01",
      source_url: "https://example.org/imaginary",
      source_kind: "organizer",
      expected_outing_type: "charity",
    },
  ],
});

let target: Sqlite;
let pool: CourseRecord[];
let locator: PlaceLocator;
let before: { outings: number; organizers: number; courses: number };

beforeAll(async () => {
  const seed = await buildSeed({ now: NOW, includeTestEntries: false });
  target = migratedSqlite();
  apply(target, seed.statements);
  // A pool imported at another time: same osm_refs, different ids.
  const ctx = await loadCourseContext({ now: LATER });
  pool = ctx.courses;
  locator = ctx.locator;
  before = {
    outings: count(target, "SELECT count(*) AS n FROM outings"),
    organizers: count(target, "SELECT count(*) AS n FROM organizers"),
    courses: count(target, "SELECT count(*) AS n FROM courses"),
  };
});

const input = (): AppendInput => ({
  seed: entries,
  pool,
  target: snapshot(target),
  locator,
  now: LATER,
  registrationHosts: [],
  removals: { outing_ids: [], urls: [] },
});

describe("top-course outings append", () => {
  it("adds the new outings, reuses existing courses and organizers, and skips the rest", () => {
    const result = buildAppendPlan(input());
    expect(result.statements.some((s) => /^\s*(DELETE|DROP)/i.test(s))).toBe(false);
    apply(target, result.statements);

    expect(result.plan.outings.map((o) => o.title).sort()).toEqual([
      "Charity Classic at Oakmont",
      "Riviera Charity Pro-Am",
    ]);
    const skipped = Object.fromEntries(result.skipped.map((s) => [s.seedId, s.reason]));
    expect(skipped["t02-nkf-winged-foot-dup"]).toMatch(/already loaded/);
    expect(skipped["t04-nowhere"]).toMatch(/no course match/);

    expect(count(target, "SELECT count(*) AS n FROM outings")).toBe(before.outings + 2);
    // Oakmont and Riviera are seed-state fixture courses already in the target.
    expect(count(target, "SELECT count(*) AS n FROM courses")).toBe(before.courses);
    // NKF already exists; only the new foundation is added.
    expect(count(target, "SELECT count(*) AS n FROM organizers")).toBe(before.organizers + 1);
    expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const oak = target
      .prepare(
        `SELECT o.published, o.single_price_cents, o.summary, c.name AS course, g.name AS org,
                c.outing_count - (SELECT count(*) FROM outings x WHERE x.course_id = c.id AND x.published = 1) AS count_drift
           FROM outings o JOIN courses c ON c.id = o.course_id JOIN organizers g ON g.id = o.organizer_id
          WHERE o.title = 'Charity Classic at Oakmont'`,
      )
      .get() as Record<string, unknown>;
    expect(oak).toMatchObject({
      published: 1,
      single_price_cents: 150_000,
      course: "Oakmont Country Club",
      org: "National Kidney Foundation",
      count_drift: 0,
    });
    expect(String(oak.summary).length).toBeLessThanOrEqual(300);
    expect(count(target, "SELECT count(*) AS n FROM source_outings so JOIN sources s ON s.id = so.source_id WHERE s.url LIKE 'https://example.org/%'")).toBe(3);
  });

  it("adds nothing on a second run", () => {
    const again = buildAppendPlan(input());
    expect(again.plan.outings).toEqual([]);
    const n = count(target, "SELECT count(*) AS n FROM outings");
    apply(target, again.statements);
    expect(count(target, "SELECT count(*) AS n FROM outings")).toBe(n);
  });
});
