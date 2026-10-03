import tzLookup from "tz-lookup";
import { describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { emptyOverrides } from "../overrides/load.ts";
import { courses } from "./courses.ts";
import {
  parseUpsertPlan,
  type Context,
  type CourseRow,
  type CoursesInput,
  type OsmFeatureInput,
  type UpsertOp,
} from "./types.ts";

const NOW = new Date("2026-10-01T10:30:00.000Z");

function ctx(overrides = emptyOverrides()): Context {
  return {
    now: NOW,
    caps: resolveBudget("monthly"),
    overrides,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { nowMs: () => 0 },
  };
}

const feat = (
  osm_ref: string,
  tags: Record<string, string>,
  lat = 40.96,
  lng = -73.75,
): OsmFeatureInput => ({
  osm_ref,
  state: "NY",
  lat,
  lng,
  tags: { leisure: "golf_course", ...tags },
});

const PLACES = [{ name: "Mamaroneck", state: "NY", lat: 40.94871, lng: -73.73263 }];

function input(patch: Partial<CoursesInput> = {}): CoursesInput {
  return {
    features: [],
    existing: [],
    places: PLACES,
    websiteTypes: {},
    timeZoneAt: (lat, lng) => tzLookup(lat, lng),
    ...patch,
  };
}

function upsert(out: ReturnType<typeof courses>): UpsertOp<"courses"> {
  const plan = parseUpsertPlan(out.output.plan);
  expect(plan.ops).toHaveLength(1);
  return plan.ops[0] as UpsertOp<"courses">;
}

const existingRow = (patch: Partial<CourseRow>): CourseRow => ({
  id: "crs_existing",
  slug: "ny/old-slug",
  name: "Old Name",
  aliases: '["Winged Foot West"]',
  street: null,
  city: "Mamaroneck",
  state: "NY",
  zip: null,
  lat: 40.96,
  lng: -73.75,
  time_zone: "America/New_York",
  course_type: "unknown",
  course_type_source: null,
  course_type_confidence: null,
  notable: 0,
  website: null,
  osm_ref: "way/1",
  outing_count: 3,
  last_outing_date: "2026-06-01",
  created_at: "2026-09-20T00:00:00.000Z",
  updated_at: "2026-09-20T00:00:00.000Z",
  ...patch,
});

describe("courses stage (SPEC.md 8.1 steps 2 to 4)", () => {
  it("upserts named courses by osm_ref and drops excluded features", () => {
    const out = courses(
      ctx(),
      input({
        features: [
          feat("way/1", { name: "Winged Foot Golf Club", access: "private" }),
          feat("way/2", { name: "Putt Putt Fun Center" }),
          feat("node/3", {}),
        ],
      }),
    );
    const op = upsert(out);
    expect(op.conflict).toEqual(["osm_ref"]);
    expect(op.update).not.toContain("id");
    expect(op.update).not.toContain("slug");
    expect(op.update).not.toContain("outing_count");
    expect(op.update).not.toContain("created_at");
    expect(op.rows).toHaveLength(1);
    expect(op.rows[0]).toMatchObject({
      slug: "ny/winged-foot-golf-club",
      city: "Mamaroneck",
      time_zone: "America/New_York",
      course_type: "private",
      course_type_source: "osm",
      osm_ref: "way/1",
      created_at: NOW.toISOString(),
    });
    expect(out.output.dropped.map((d) => d.osm_ref).sort()).toEqual(["node/3", "way/2"]);
    expect(out.result.counters.courses_imported).toBe(1);
  });

  it("keeps an existing course's id, slug, aliases, outing count and created_at", () => {
    const out = courses(
      ctx(),
      input({
        features: [feat("way/1", { name: "Winged Foot Golf Club", alt_name: "WFGC" })],
        existing: [existingRow({})],
      }),
    );
    expect(upsert(out).rows[0]).toMatchObject({
      id: "crs_existing",
      slug: "ny/old-slug",
      name: "Winged Foot Golf Club",
      aliases: '["Winged Foot West","WFGC"]',
      outing_count: 3,
      last_outing_date: "2026-06-01",
      created_at: "2026-09-20T00:00:00.000Z",
      updated_at: NOW.toISOString(),
    });
  });

  it("a course-types.yaml override wins and keeps override as its source", () => {
    const overrides = emptyOverrides({
      courseTypes: [{ osm_ref: "way/1", course_type: "semi_private", reason: "owner checked" }],
    });
    const out = courses(
      ctx(overrides),
      input({
        features: [feat("way/1", { name: "Winged Foot Golf Club", access: "public" })],
        existing: [
          existingRow({
            course_type: "private",
            course_type_source: "website_llm",
            course_type_confidence: 0.9,
          }),
        ],
        websiteTypes: { "way/1": { course_type: "public", confidence: 0.95 } },
      }),
    );
    expect(upsert(out).rows[0]).toMatchObject({
      course_type: "semi_private",
      course_type_source: "override",
      course_type_confidence: 1,
    });
  });

  it("keeps an earlier website classification when OSM tags say nothing", () => {
    const out = courses(
      ctx(),
      input({
        features: [
          feat("way/1", { name: "Winged Foot Golf Club", website: "https://example.com/" }),
        ],
        existing: [
          existingRow({
            course_type: "private",
            course_type_source: "website_llm",
            course_type_confidence: 0.82,
          }),
        ],
      }),
    );
    expect(upsert(out).rows[0]).toMatchObject({
      course_type: "private",
      course_type_source: "website_llm",
      course_type_confidence: 0.82,
    });
  });

  it("applies new website classifications at 0.7 or higher and ignores bad ones", () => {
    const out = courses(
      ctx(),
      input({
        features: [
          feat("way/1", { name: "Alpha Golf Club", website: "https://a.example/" }),
          feat("way/2", { name: "Beta Golf Club", website: "https://b.example/" }, 40.97, -73.76),
          feat("way/3", { name: "Gamma Golf Club", website: "https://c.example/" }, 40.98, -73.77),
        ],
        websiteTypes: {
          "way/1": { course_type: "resort", confidence: 0.7 },
          "way/2": { course_type: "public", confidence: 0.69 },
          "way/3": { course_type: "castle", confidence: 0.99 },
        },
      }),
    );
    const byRef = Object.fromEntries(upsert(out).rows.map((r) => [r.osm_ref, r.course_type]));
    expect(byRef).toEqual({ "way/1": "resort", "way/2": "unknown", "way/3": "unknown" });
  });

  it("returns an empty plan for no features", () => {
    expect(courses(ctx(), input()).output.plan.ops).toEqual([]);
  });
});
