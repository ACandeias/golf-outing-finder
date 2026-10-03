import type { CourseRecord } from "../courses/import.ts";
import type { CityRow, ZipRow } from "../places/geonames.ts";
import type { SeedPlan } from "../seed/plan.ts";
import { insertStatements, type SqlScalar } from "./literal.ts";

/** Row mappers from records to `snake_case` columns (SPEC.md 7.1) and their INSERTs. */

type Row = Record<string, SqlScalar>;

export const CITY_COLUMNS = ["id", "slug", "name", "state", "lat", "lng", "population", "time_zone"] as const;
export const ZIP_COLUMNS = ["zip", "lat", "lng", "city_id"] as const;
export const COURSE_COLUMNS = [
  "id",
  "slug",
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
  "osm_ref",
  "outing_count",
  "last_outing_date",
  "created_at",
  "updated_at",
] as const;
export const ORGANIZER_COLUMNS = [
  "id",
  "slug",
  "name",
  "org_type",
  "ein",
  "charity_status",
  "irs_subsection",
  "website",
  "series_id",
  "created_at",
  "updated_at",
] as const;
export const OUTING_COLUMNS = [
  "id",
  "slug",
  "course_id",
  "organizer_id",
  "title",
  "summary",
  "outing_type",
  "audience",
  "audience_note",
  "start_date",
  "end_date",
  "shotgun_time",
  "format",
  "single_price_cents",
  "foursome_price_cents",
  "sponsor_only",
  "includes",
  "handicap_required",
  "status",
  "expected_month",
  "registration_url",
  "canonical_source_url",
  "source_gone",
  "confidence",
  "published",
  "hold_reason",
  "expected_misses",
  "next_outing_id",
  "first_seen",
  "last_verified",
  "updated_at",
] as const;
export const SOURCE_COLUMNS = ["id", "url", "domain", "kind"] as const;
export const SOURCE_OUTING_COLUMNS = ["source_id", "outing_id"] as const;

export function cityRow(c: CityRow): Row {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    state: c.state,
    lat: c.lat,
    lng: c.lng,
    population: c.population,
    time_zone: c.timeZone,
  };
}

export function zipRow(z: ZipRow): Row {
  return { zip: z.zip, lat: z.lat, lng: z.lng, city_id: z.cityId };
}

export function courseRow(c: CourseRecord): Row {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    aliases: JSON.stringify(c.aliases),
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
    outing_count: c.outingCount,
    last_outing_date: c.lastOutingDate,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/** Courses re-imported by osm_ref keep their id, slug, aliases and outing counts. */
const COURSE_UPSERT =
  "ON CONFLICT(osm_ref) DO UPDATE SET name = excluded.name, street = excluded.street, city = excluded.city, " +
  "state = excluded.state, zip = excluded.zip, lat = excluded.lat, lng = excluded.lng, time_zone = excluded.time_zone, " +
  "course_type = excluded.course_type, course_type_source = excluded.course_type_source, " +
  "course_type_confidence = excluded.course_type_confidence, notable = excluded.notable, website = excluded.website, " +
  "updated_at = excluded.updated_at";

export function placesStatements(cities: readonly CityRow[], zips: readonly ZipRow[]): string[] {
  return [
    ...insertStatements("cities", CITY_COLUMNS, cities.map(cityRow), { verb: "INSERT OR REPLACE" }),
    ...insertStatements("zips", ZIP_COLUMNS, zips.map(zipRow), { verb: "INSERT OR REPLACE" }),
  ];
}

export function courseStatements(courses: readonly CourseRecord[], mode: "insert" | "upsert"): string[] {
  return insertStatements(
    "courses",
    COURSE_COLUMNS,
    courses.map(courseRow),
    mode === "upsert" ? { suffix: COURSE_UPSERT } : {},
  );
}

/**
 * The full local seed: clears the seeded tables, then loads places, courses,
 * organizers, outings, sources and links, in foreign-key order.
 */
export function seedStatements(
  plan: SeedPlan,
  places: { cities: readonly CityRow[]; zips: readonly ZipRow[] },
): string[] {
  const reset = [
    "DELETE FROM source_outings;",
    "DELETE FROM sources;",
    "UPDATE outings SET next_outing_id = NULL WHERE next_outing_id IS NOT NULL;",
    "DELETE FROM outings;",
    "DELETE FROM organizers;",
    "DELETE FROM courses;",
    "DELETE FROM zips;",
    "DELETE FROM cities;",
  ];
  return [
    ...reset,
    ...placesStatements(places.cities, places.zips),
    ...courseStatements(plan.courses, "insert"),
    ...insertStatements(
      "organizers",
      ORGANIZER_COLUMNS,
      plan.organizers.map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name,
        org_type: o.orgType,
        ein: o.ein,
        charity_status: o.charityStatus,
        irs_subsection: o.irsSubsection,
        website: o.website,
        series_id: o.seriesId,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
      })),
    ),
    ...insertStatements(
      "outings",
      OUTING_COLUMNS,
      plan.outings.map((o) => ({
        id: o.id,
        slug: o.slug,
        course_id: o.courseId,
        organizer_id: o.organizerId,
        title: o.title,
        summary: o.summary,
        outing_type: o.outingType,
        audience: o.audience,
        audience_note: o.audienceNote,
        start_date: o.startDate,
        end_date: o.endDate,
        shotgun_time: o.shotgunTime,
        format: o.format,
        single_price_cents: o.singlePriceCents,
        foursome_price_cents: o.foursomePriceCents,
        sponsor_only: o.sponsorOnly,
        includes: o.includes,
        handicap_required: o.handicapRequired,
        status: o.status,
        expected_month: o.expectedMonth,
        registration_url: o.registrationUrl,
        canonical_source_url: o.canonicalSourceUrl,
        source_gone: o.sourceGone,
        confidence: o.confidence,
        published: o.published,
        hold_reason: o.holdReason,
        expected_misses: o.expectedMisses,
        next_outing_id: o.nextOutingId,
        first_seen: o.firstSeen,
        last_verified: o.lastVerified,
        updated_at: o.updatedAt,
      })),
    ),
    ...insertStatements(
      "sources",
      SOURCE_COLUMNS,
      plan.sources.map((s) => ({ id: s.id, url: s.url, domain: s.domain, kind: s.kind })),
    ),
    ...insertStatements(
      "source_outings",
      SOURCE_OUTING_COLUMNS,
      plan.sourceOutings.map((l) => ({ source_id: l.sourceId, outing_id: l.outingId })),
    ),
  ];
}
