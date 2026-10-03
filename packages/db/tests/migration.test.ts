import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import { allTables } from "../src/schema.ts";

// Node's built-in SQLite (stable without a flag since Node 22.13). Loaded through
// require because Vitest 2's resolver does not know the `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** Every table in SPEC.md v1.1 section 7.1. */
const SPEC_TABLES = [
  "series",
  "cities",
  "zips",
  "courses",
  "organizers",
  "outings",
  "sources",
  "source_outings",
  "discovery_queue",
  "submissions",
  "runs",
];

function migrate(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  return db;
}

const NOW = "2026-09-28T00:00:00Z";

function seedCourseAndOrganizer(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO courses (id, slug, name, state, lat, lng, time_zone, created_at, updated_at)
    VALUES ('crs_1', 'ny/winged-foot', 'Winged Foot Golf Club', 'NY', 40.95, -73.75,
            'America/New_York', '${NOW}', '${NOW}');
    INSERT INTO organizers (id, slug, name, org_type, created_at, updated_at)
    VALUES ('org_1', 'nkf', 'National Kidney Foundation', 'charity', '${NOW}', '${NOW}');
  `);
}

function insertOuting(
  db: DatabaseSync,
  fields: Partial<Record<string, string | number | null>>,
): void {
  const row: Record<string, string | number | null> = {
    id: `out_${Math.random().toString(36).slice(2)}`,
    slug: `2026/x-${Math.random().toString(36).slice(2)}`,
    course_id: "crs_1",
    organizer_id: null,
    title: "Test outing",
    outing_type: "charity",
    status: "open",
    start_date: "2026-10-19",
    canonical_source_url: "https://example.org/e",
    confidence: 0.9,
    first_seen: NOW,
    last_verified: NOW,
    updated_at: NOW,
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO outings (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
    ...cols.map((c) => row[c] ?? null),
  );
}

describe("0000_init migration", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
  });

  it("creates every table in SPEC section 7.1", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    for (const t of SPEC_TABLES) expect(names).toContain(t);
  });

  it("matches the Drizzle schema column for column", () => {
    for (const [name, table] of Object.entries(allTables)) {
      const config = getTableConfig(table);
      expect(config.name).toBe(name);
      const dbCols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      const drizzleCols = config.columns.map((c) => c.name);
      expect(new Set(drizzleCols)).toEqual(new Set(dbCols));
    }
    expect(Object.keys(allTables).sort()).toEqual([...SPEC_TABLES].sort());
  });

  it("has no outing_id on sources (replaced by source_outings)", () => {
    const cols = (db.prepare("PRAGMA table_info(sources)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("outing_id");
    expect(cols).toEqual(expect.arrayContaining(["hold_reason", "held_until", "consecutive_gone"]));
  });

  it("creates the named indexes", () => {
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        "cities_state_slug",
        "cities_geo",
        "courses_geo",
        "courses_state_city",
        "outings_listing",
        "outings_course",
        "outings_organizer",
        "outings_dedupe",
        "outings_expected",
        "sources_hold",
        "source_outings_outing",
        "runs_started",
      ]),
    );
  });

  it("dedupes two organizer-less outings on the same course and date", () => {
    seedCourseAndOrganizer(db);
    insertOuting(db, {});
    expect(() => insertOuting(db, {})).toThrow(/UNIQUE/);
    // A different organizer on the same day is a different outing.
    insertOuting(db, { organizer_id: "org_1" });
  });

  it("allows one expected row per course, organizer and month", () => {
    seedCourseAndOrganizer(db);
    insertOuting(db, {
      status: "expected",
      start_date: null,
      expected_month: "2027-06",
      organizer_id: "org_1",
    });
    expect(() =>
      insertOuting(db, {
        status: "expected",
        start_date: null,
        expected_month: "2027-06",
        organizer_id: "org_1",
      }),
    ).toThrow(/UNIQUE/);
  });

  it("enforces CHECK constraints", () => {
    seedCourseAndOrganizer(db);
    expect(() => insertOuting(db, { status: "unknown" })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { start_date: null })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { end_date: "2026-10-01" })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { summary: "x".repeat(301) })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { single_price_cents: 2_500_001 })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { hold_reason: "nope" })).toThrow(/CHECK/);
    expect(() => insertOuting(db, { expected_misses: 3 })).toThrow(/CHECK/);
    expect(() =>
      db.exec("INSERT INTO zips (zip, lat, lng) VALUES ('1234', 0, 0)"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO sources (id, url, domain, kind) VALUES ('s1', 'https://a.example/', 'a.example', 'blog')",
      ),
    ).toThrow(/CHECK/);
  });

  it("cascades source_outings when a source is deleted", () => {
    seedCourseAndOrganizer(db);
    insertOuting(db, { id: "out_1" });
    db.exec(`
      INSERT INTO sources (id, url, domain, kind) VALUES ('src_1', 'https://azgolf.org/x', 'azgolf.org', 'association');
      INSERT INTO source_outings (source_id, outing_id) VALUES ('src_1', 'out_1');
      DELETE FROM sources WHERE id = 'src_1';
    `);
    const n = db.prepare("SELECT count(*) AS n FROM source_outings").get() as { n: number };
    expect(n.n).toBe(0);
  });
});
