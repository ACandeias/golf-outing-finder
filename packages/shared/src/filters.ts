/**
 * Listing filters (SPEC.md v1.1 section 9.2) as plain data plus one predicate.
 * No imports, so the browser filter script can bundle this without zod; the zod
 * parser for URL parameters lives in filter-params.ts.
 */

/** Course type filter groups: municipal and public are one choice. */
export const COURSE_TYPE_FILTERS = ["municipal_public", "semi_private", "private", "resort", "unknown"] as const;
export type CourseTypeFilter = (typeof COURSE_TYPE_FILTERS)[number];

export const COURSE_TYPE_FILTER_LABELS: Readonly<Record<CourseTypeFilter, string>> = {
  municipal_public: "Municipal and public",
  semi_private: "Semi-private",
  private: "Private",
  resort: "Resort",
  unknown: "Course type unknown",
};

export const DISTANCE_MILES = [10, 25, 50, 100] as const;
export type DistanceMiles = (typeof DISTANCE_MILES)[number];

export const FORMAT_FILTERS = ["scramble", "best_ball", "shamble", "stroke", "other"] as const;
export type FormatFilter = (typeof FORMAT_FILTERS)[number];

/** Every query parameter that counts as a filter (noindex when present). */
export const FILTER_PARAMS = [
  "course_type",
  "charity",
  "max_price",
  "from",
  "to",
  "distance",
  "format",
  "singles",
] as const;

export interface ListingFilters {
  courseTypes: CourseTypeFilter[];
  charityOnly: boolean;
  /** Price per player, cents. */
  maxPriceCents: number | null;
  /** Inclusive YYYY-MM-DD. */
  from: string | null;
  to: string | null;
  distanceMiles: DistanceMiles | null;
  format: FormatFilter | null;
  singlesWelcome: boolean;
}

export const NO_FILTERS: Readonly<ListingFilters> = Object.freeze({
  courseTypes: [],
  charityOnly: false,
  maxPriceCents: null,
  from: null,
  to: null,
  distanceMiles: null,
  format: null,
  singlesWelcome: false,
});

export function hasActiveFilters(f: ListingFilters): boolean {
  return (
    f.courseTypes.length > 0 ||
    f.charityOnly ||
    f.maxPriceCents !== null ||
    f.from !== null ||
    f.to !== null ||
    f.distanceMiles !== null ||
    f.format !== null ||
    f.singlesWelcome
  );
}

/** Stored course types per filter group. */
export function courseTypesForFilters(
  groups: readonly CourseTypeFilter[],
): ("municipal" | "public" | "semi_private" | "private" | "resort" | "unknown")[] {
  return groups.flatMap((g) => (g === "municipal_public" ? (["municipal", "public"] as const) : ([g] as const)));
}

export function courseTypeFilterOf(courseType: string): CourseTypeFilter {
  if (courseType === "municipal" || courseType === "public") return "municipal_public";
  if (courseType === "semi_private" || courseType === "private" || courseType === "resort") return courseType;
  return "unknown";
}

/** What a card exposes to the filter (mirrors data-* attributes on the card). */
export interface FilterableOuting {
  courseType: string;
  outingType: string;
  singlePriceCents: number | null;
  /** start_date, or null for an expected outing with no announced date. */
  startDate: string | null;
  format: string | null;
  /** Miles from the page's centre, when known. */
  distanceMiles: number | null;
}

/** True when an outing passes every active filter. */
export function matchesFilters(o: FilterableOuting, f: ListingFilters): boolean {
  if (f.courseTypes.length > 0 && !f.courseTypes.includes(courseTypeFilterOf(o.courseType))) return false;
  if (f.charityOnly && o.outingType !== "charity" && o.outingType !== "school_fundraiser") return false;
  if (f.maxPriceCents !== null && (o.singlePriceCents === null || o.singlePriceCents > f.maxPriceCents)) return false;
  if (f.from !== null && (o.startDate === null || o.startDate < f.from)) return false;
  if (f.to !== null && (o.startDate === null || o.startDate > f.to)) return false;
  if (f.distanceMiles !== null && (o.distanceMiles === null || o.distanceMiles > f.distanceMiles)) return false;
  if (f.format !== null && o.format !== f.format) return false;
  if (f.singlesWelcome && o.singlePriceCents === null) return false;
  return true;
}
