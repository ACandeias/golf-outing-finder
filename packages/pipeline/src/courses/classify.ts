import type { CourseType } from "@gof/shared/schemas";

/**
 * SPEC.md 8.1 step 2: drop unnamed features, mini golf, putting courses, Topgolf and
 * driving ranges. "putt" is matched as a word so names like "Putterham Meadows"
 * stay in. Par-3 courses stay in.
 */
const EXCLUDED_NAME = /mini ?golf|miniature|\bputt(?:-putt|ing)?\b|\btop ?golf\b|driving range/i;

export function isExcludedFeature(tags: Readonly<Record<string, string>>): boolean {
  const name = tags.name?.trim();
  if (!name) return true;
  if (tags.golf === "driving_range") return true;
  return EXCLUDED_NAME.test(name);
}

const MUNICIPAL_OPERATOR = /\bcity of\b|\bcounty\b|\bparks\b|\brecreation\b|\bstate park\b/i;

/** A course that calls itself municipal: "Horton Smith Municipal Golf Course", "Riverside Muni". Whole words. */
export const MUNICIPAL_NAME = /\bmunicipal\b|\bmuni\b/i;

/**
 * SPEC.md 8.1 step 4.2, OSM tag rules in order: `access=private` gives private;
 * `operator:type=government` or an operator naming a city, county, parks,
 * recreation or state park gives municipal; then a name that says "Municipal"
 * or "Muni" gives municipal (most municipal courses carry no operator tag);
 * `access=yes|public` gives public.
 */
export function courseTypeFromOsmTags(tags: Readonly<Record<string, string>>): CourseType | null {
  if (tags.access === "private") return "private";
  if (tags["operator:type"] === "government") return "municipal";
  const operator = tags.operator ?? "";
  if (operator && MUNICIPAL_OPERATOR.test(operator)) return "municipal";
  if (MUNICIPAL_NAME.test(tags.name ?? "")) return "municipal";
  if (tags.access === "yes" || tags.access === "public") return "public";
  return null;
}
