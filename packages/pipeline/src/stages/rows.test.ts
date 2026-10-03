import { describe, expect, it } from "vitest";
import { migratedSqlite } from "@gof/db/testing";
import {
  outingRowSchema,
  runRowSchema,
  TABLE_NAMES,
  TABLE_PRIMARY_KEYS,
  tableColumns,
} from "./rows.ts";

describe("row schemas mirror the D1 migration", () => {
  const db = migratedSqlite();

  for (const table of TABLE_NAMES) {
    it(`${table}: same columns, same primary key`, () => {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        pk: number;
      }[];
      expect(info.length).toBeGreaterThan(0);
      expect([...tableColumns(table)].sort()).toEqual(info.map((c) => c.name).sort());
      const pk = info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect([...TABLE_PRIMARY_KEYS[table]]).toEqual(pk);
    });
  }
});

const outing = {
  id: "out_1",
  slug: "2026/fordham-golf-classic-winged-foot",
  course_id: "crs_1",
  organizer_id: "org_1",
  title: "Fordham Golf Classic",
  summary: null,
  outing_type: "school_fundraiser",
  audience: "aimed_at_group",
  audience_note: "Aimed at Fordham alumni",
  start_date: "2026-10-13",
  end_date: null,
  shotgun_time: "12:00",
  format: null,
  single_price_cents: null,
  foursome_price_cents: null,
  sponsor_only: 0,
  includes: "[]",
  handicap_required: null,
  status: "open",
  expected_month: null,
  registration_url: "https://now.fordham.edu/event/fordham-golf-classic-2026/",
  canonical_source_url: "https://now.fordham.edu/event/fordham-golf-classic-2026/",
  source_gone: 0,
  confidence: 0.9,
  published: 1,
  hold_reason: null,
  expected_misses: 0,
  next_outing_id: null,
  first_seen: "2026-09-28T12:00:00.000Z",
  last_verified: "2026-09-28T12:00:00.000Z",
  updated_at: "2026-09-28T12:00:00.000Z",
} as const;

describe("row schema CHECKs", () => {
  it("accepts a valid outing", () => {
    expect(outingRowSchema.parse(outing)).toEqual(outing);
  });

  it("enforces start_date unless expected, and end_date >= start_date", () => {
    expect(outingRowSchema.safeParse({ ...outing, start_date: null }).success).toBe(false);
    expect(
      outingRowSchema.safeParse({
        ...outing,
        start_date: null,
        status: "expected",
        expected_month: "2027-10",
      }).success,
    ).toBe(true);
    expect(outingRowSchema.safeParse({ ...outing, end_date: "2026-10-12" }).success).toBe(false);
  });

  it("enforces money, summary, URL and hold reason limits", () => {
    expect(outingRowSchema.safeParse({ ...outing, single_price_cents: 2_500_001 }).success).toBe(
      false,
    );
    expect(outingRowSchema.safeParse({ ...outing, single_price_cents: 125.5 }).success).toBe(false);
    expect(outingRowSchema.safeParse({ ...outing, summary: "x".repeat(301) }).success).toBe(false);
    expect(
      outingRowSchema.safeParse({ ...outing, registration_url: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(outingRowSchema.safeParse({ ...outing, hold_reason: "bored" }).success).toBe(false);
  });

  it("requires JSON array text in runs", () => {
    const run = {
      id: "run_1",
      kind: "nightly",
      started_at: "2026-09-28T12:00:00.000Z",
      finished_at: null,
      stages_done: "[]",
      serp_queries: 0,
      fetches: 0,
      renders: 0,
      extractions: 0,
      course_classifications: 0,
      llm_input_tokens: 0,
      llm_output_tokens: 0,
      pending_batch_id: null,
      outings_new: 0,
      outings_updated: 0,
      outings_held: 0,
      budget_hits: "[]",
      errors: "[]",
      est_cost_cents: 0,
    };
    expect(runRowSchema.safeParse(run).success).toBe(true);
    expect(runRowSchema.safeParse({ ...run, errors: "{}" }).success).toBe(false);
  });
});
