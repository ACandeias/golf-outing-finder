import { courseTypeSchema } from "@gof/shared/schemas";
import { citySlug } from "@gof/shared/slug";
import { buildCourses, type CourseRecord, type WebsiteClassification } from "../courses/import.ts";
import type { CityRow } from "../places/geonames.ts";
import { emptyResult, type CourseRow, type CoursesStage, type UpsertPlan } from "./types.ts";

/**
 * SPEC.md 8.1 steps 2 to 4, workstream D (monthly). Wraps
 * src/courses/import.ts#buildCourses over Overpass features and emits course
 * upserts by osm_ref.
 *
 * - Type order: course-types.yaml override, OSM tags, website classification
 *   (0.7 or higher), else unknown. An earlier website classification stored on
 *   the row is kept unless this run brings a new one.
 * - Existing rows keep id, slug, outing_count, last_outing_date and created_at;
 *   aliases are merged (the matcher adds facility aliases).
 */

/** Columns a re-import overwrites on conflict(osm_ref). */
export const COURSE_REIMPORT_COLUMNS = [
  "name",
  "aliases",
  "street",
  "city",
  "state",
  "zip",
  "lat",
  "lng",
  "time_zone",
  "course_type",
  "course_type_source",
  "course_type_confidence",
  "notable",
  "website",
  "updated_at",
] as const satisfies readonly (keyof CourseRow)[];

function jsonStrings(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRow(c: CourseRecord, existing: CourseRow | undefined): CourseRow {
  const aliases = [...(existing ? jsonStrings(existing.aliases) : [])];
  for (const a of c.aliases) if (!aliases.includes(a) && a !== c.name) aliases.push(a);
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    aliases: JSON.stringify(aliases),
    street: c.street,
    city: c.city,
    state: c.state,
    zip: c.zip,
    lat: c.lat,
    lng: c.lng,
    time_zone: c.timeZone,
    course_type: c.courseType,
    course_type_source: c.courseTypeSource,
    course_type_confidence: c.courseTypeConfidence,
    notable: c.notable,
    website: c.website,
    osm_ref: c.osmRef,
    outing_count: existing?.outing_count ?? 0,
    last_outing_date: existing?.last_outing_date ?? null,
    created_at: existing?.created_at ?? c.createdAt,
    updated_at: c.updatedAt,
  };
}

export const courses: CoursesStage = (ctx, input) => {
  const result = emptyResult();

  const websiteClassifications = new Map<string, WebsiteClassification>();
  for (const e of input.existing) {
    if (e.osm_ref && e.course_type_source === "website_llm" && e.course_type_confidence !== null) {
      websiteClassifications.set(e.osm_ref, {
        courseType: e.course_type,
        confidence: e.course_type_confidence,
      });
    }
  }
  for (const [ref, w] of Object.entries(input.websiteTypes)) {
    const t = courseTypeSchema.safeParse(w.course_type);
    if (!t.success || t.data === "unknown" || !(w.confidence >= 0 && w.confidence <= 1)) {
      ctx.log.warn("ignoring an invalid website classification", { osm_ref: ref, ...w });
      continue;
    }
    websiteClassifications.set(ref, { courseType: t.data, confidence: w.confidence });
  }

  const cities: CityRow[] = input.places.map((p, i) => ({
    id: i + 1,
    slug: citySlug(p.name),
    name: p.name,
    state: p.state,
    lat: p.lat,
    lng: p.lng,
    population: 0,
    timeZone: "",
  }));

  const existingByRef = new Map<string, CourseRow>();
  for (const e of input.existing) if (e.osm_ref) existingByRef.set(e.osm_ref, e);

  const built = buildCourses(
    input.features.map((f) => ({
      osmRef: f.osm_ref,
      state: f.state,
      lat: f.lat,
      lng: f.lng,
      tags: f.tags,
    })),
    {
      now: ctx.now.getTime(),
      cities,
      overrides: ctx.overrides.courseTypes,
      notable: ctx.overrides.notableCourses,
      timeZoneAt: input.timeZoneAt,
      existing: input.existing.map((e) => ({ id: e.id, slug: e.slug, osmRef: e.osm_ref })),
      websiteClassifications,
    },
  );

  const rows = built.courses.map((c) => toRow(c, existingByRef.get(c.osmRef)));
  const plan: UpsertPlan = { ops: [] };
  if (rows.length > 0) {
    plan.ops.push({
      op: "upsert",
      table: "courses",
      rows,
      conflict: ["osm_ref"],
      update: [...COURSE_REIMPORT_COLUMNS],
    });
  }
  result.counters.courses_imported = rows.length;
  return {
    output: {
      plan,
      dropped: built.dropped.map((d) => ({ osm_ref: d.osmRef, reason: d.reason })),
    },
    result,
  };
};
