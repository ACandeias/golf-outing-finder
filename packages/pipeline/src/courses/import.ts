import { createHash } from "node:crypto";
import { ulid } from "@gof/shared/ids";
import type { CourseType } from "@gof/shared/schemas";
import { citySlug, courseSlug } from "@gof/shared/slug";
import type { CourseTypeOverride } from "../overrides/course-types.ts";
import { CityIndex, type CityRow } from "../places/geonames.ts";
import { courseTypeFromOsmTags, isExcludedFeature } from "./classify.ts";
import type { OsmFeature } from "./overpass.ts";

/** SPEC.md 8.1 step 3: nearest city within 30 km when OSM has no addr:city. */
export const COURSE_CITY_RADIUS_KM = 30;
/** SPEC.md 8.1 step 4.3: accept a website classification at 0.7 or higher. */
export const WEBSITE_CONFIDENCE_MIN = 0.7;

export type CourseTypeSource = "override" | "osm" | "website_llm";

/** One `courses` row (SPEC.md 7.1), camelCase. */
export interface CourseRecord {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  street: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  lat: number;
  lng: number;
  timeZone: string;
  courseType: CourseType;
  courseTypeSource: CourseTypeSource | null;
  courseTypeConfidence: number | null;
  notable: 0 | 1;
  website: string | null;
  osmRef: string;
  outingCount: number;
  lastOutingDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase 2 hook for step 4.3: website classifications produced by the monthly LLM
 * batch, keyed by osm_ref. The importer stays pure; it only reads the results.
 */
export interface WebsiteClassification {
  courseType: CourseType;
  confidence: number;
}

export interface ExistingCourse {
  id: string;
  slug: string;
  osmRef: string | null;
}

export interface ImportContext {
  now: number;
  cities: readonly CityRow[];
  overrides: readonly CourseTypeOverride[];
  timeZoneAt: (lat: number, lng: number) => string;
  notable?: { names: readonly string[]; osmRefs: readonly string[] };
  existing?: readonly ExistingCourse[];
  websiteClassifications?: ReadonlyMap<string, WebsiteClassification>;
}

export interface DroppedFeature {
  osmRef: string;
  name: string | null;
  reason: "excluded" | "duplicate";
}

function courseId(now: number, osmRef: string): string {
  const bytes = createHash("sha256").update(`course:${osmRef}`).digest();
  return `crs_${ulid(now, bytes.subarray(0, 10))}`;
}

function cleanWebsite(...candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c.trim());
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {
      // not a URL; try the next tag
    }
  }
  return null;
}

function cleanZip(postcode: string | undefined): string | null {
  const m = postcode ? /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(postcode) : null;
  return m?.[1] ?? null;
}

function aliasesFrom(tags: Readonly<Record<string, string>>, name: string): string[] {
  const out: string[] = [];
  for (const key of ["alt_name", "official_name", "short_name"]) {
    for (const part of (tags[key] ?? "").split(";")) {
      const a = part.trim();
      if (a && a !== name && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

function refOrder(a: string, b: string): number {
  const [ta = "", ia = "0"] = a.split("/");
  const [tb = "", ib = "0"] = b.split("/");
  return ta === tb ? Number(ia) - Number(ib) : ta < tb ? -1 : 1;
}

/**
 * Turns Overpass features into `courses` rows (SPEC.md 8.1 steps 2 to 4). Pure:
 * cities, overrides, the time zone lookup and the clock come from the caller.
 */
export function buildCourses(
  features: readonly OsmFeature[],
  ctx: ImportContext,
): { courses: CourseRecord[]; dropped: DroppedFeature[] } {
  const now = new Date(ctx.now).toISOString();
  const index = new CityIndex(ctx.cities);
  const citiesBySlug = new Map<string, CityRow>();
  for (const c of ctx.cities) citiesBySlug.set(`${c.state}/${c.slug}`, c);
  const existingByRef = new Map<string, ExistingCourse>();
  const taken = new Set<string>();
  for (const e of ctx.existing ?? []) {
    if (e.osmRef) existingByRef.set(e.osmRef, e);
    taken.add(e.slug);
  }
  const byOsmRef = new Map<string, CourseTypeOverride>();
  const byCourseId = new Map<string, CourseTypeOverride>();
  for (const o of ctx.overrides) {
    if (o.osm_ref) byOsmRef.set(o.osm_ref, o);
    if (o.course_id) byCourseId.set(o.course_id, o);
  }
  const notableNames = new Set((ctx.notable?.names ?? []).map((n) => n.trim().toLowerCase()));
  const notableRefs = new Set(ctx.notable?.osmRefs ?? []);

  const dropped: DroppedFeature[] = [];
  const seen = new Set<string>();
  const kept: OsmFeature[] = [];
  for (const feat of features) {
    if (seen.has(feat.osmRef)) {
      dropped.push({ osmRef: feat.osmRef, name: feat.tags.name ?? null, reason: "duplicate" });
      continue;
    }
    seen.add(feat.osmRef);
    if (isExcludedFeature(feat.tags)) {
      dropped.push({ osmRef: feat.osmRef, name: feat.tags.name ?? null, reason: "excluded" });
      continue;
    }
    kept.push(feat);
  }

  // Existing courses keep their slugs; new ones are named in a stable order so the
  // same input always yields the same slugs.
  kept.sort((a, b) => {
    const ea = existingByRef.has(a.osmRef) ? 0 : 1;
    const eb = existingByRef.has(b.osmRef) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (a.state !== b.state) return a.state < b.state ? -1 : 1;
    const na = (a.tags.name ?? "").trim().toLowerCase();
    const nb = (b.tags.name ?? "").trim().toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return refOrder(a.osmRef, b.osmRef);
  });

  const courses: CourseRecord[] = [];
  for (const feat of kept) {
    const t = feat.tags;
    const name = (t.name ?? "").trim().replace(/\s+/g, " ");
    const existing = existingByRef.get(feat.osmRef);
    const id = existing?.id ?? courseId(ctx.now, feat.osmRef);

    let city: string | null = null;
    const addrCity = t["addr:city"]?.trim();
    if (addrCity) {
      city = citiesBySlug.get(`${feat.state}/${citySlug(addrCity)}`)?.name ?? addrCity;
    } else {
      city = index.nearest(feat, COURSE_CITY_RADIUS_KM, feat.state)?.name ?? null;
    }

    let slug: string;
    if (existing) slug = existing.slug;
    else {
      slug = courseSlug(feat.state, name, city, taken);
      taken.add(slug);
    }

    let courseType: CourseType = "unknown";
    let source: CourseTypeSource | null = null;
    let confidence: number | null = null;
    const override = byOsmRef.get(feat.osmRef) ?? byCourseId.get(id);
    const fromTags = courseTypeFromOsmTags(t);
    const website = cleanWebsite(t.website, t["contact:website"], t.url);
    const fromSite = website ? ctx.websiteClassifications?.get(feat.osmRef) : undefined;
    if (override) {
      courseType = override.course_type;
      source = "override";
      confidence = 1;
    } else if (fromTags) {
      courseType = fromTags;
      source = "osm";
    } else if (fromSite && fromSite.confidence >= WEBSITE_CONFIDENCE_MIN) {
      courseType = fromSite.courseType;
      source = "website_llm";
      confidence = fromSite.confidence;
    }

    const houseNumber = t["addr:housenumber"]?.trim();
    const streetName = t["addr:street"]?.trim();
    courses.push({
      id,
      slug,
      name,
      aliases: aliasesFrom(t, name),
      street: streetName ? (houseNumber ? `${houseNumber} ${streetName}` : streetName) : null,
      city,
      state: feat.state,
      zip: cleanZip(t["addr:postcode"]),
      lat: feat.lat,
      lng: feat.lng,
      timeZone: ctx.timeZoneAt(feat.lat, feat.lng),
      courseType,
      courseTypeSource: source,
      courseTypeConfidence: confidence,
      notable: notableRefs.has(feat.osmRef) || notableNames.has(name.toLowerCase()) ? 1 : 0,
      website,
      osmRef: feat.osmRef,
      outingCount: 0,
      lastOutingDate: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { courses, dropped };
}
