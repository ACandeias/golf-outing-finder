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

/**
 * Stored course types a list shows by default: everything but municipal. A
 * visitor brings municipal courses back with `include_municipal=1`, or by picking
 * course types in the course type filter, which replaces this default.
 */
export const DEFAULT_COURSE_TYPES = ["public", "semi_private", "private", "resort", "unknown"] as const;

/** The query parameter behind the "Include municipal courses" toggle. */
export const INCLUDE_MUNICIPAL_PARAM = "include_municipal";

/** Every query parameter that counts as a filter (noindex when present). */
export const FILTER_PARAMS = [
  "course_type",
  INCLUDE_MUNICIPAL_PARAM,
  "charity",
  "max_price",
  "from",
  "to",
  "distance",
  "format",
  "singles",
] as const;

export interface ListingFilters {
  /** Course type groups picked in the filter; when empty, the default applies. */
  courseTypes: CourseTypeFilter[];
  /** Show municipal courses when no course type is picked (they're hidden by default). */
  includeMunicipal: boolean;
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

/** The default list view: no filter picked, municipal courses hidden. */
export const NO_FILTERS: Readonly<ListingFilters> = Object.freeze({
  courseTypes: [],
  includeMunicipal: false,
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
    f.includeMunicipal ||
    f.charityOnly ||
    f.maxPriceCents !== null ||
    f.from !== null ||
    f.to !== null ||
    f.distanceMiles !== null ||
    f.format !== null ||
    f.singlesWelcome
  );
}

type StoredCourseType = "municipal" | "public" | "semi_private" | "private" | "resort" | "unknown";

/** Stored course types per filter group. */
export function courseTypesForFilters(
  groups: readonly CourseTypeFilter[],
): StoredCourseType[] {
  return groups.flatMap((g) => (g === "municipal_public" ? (["municipal", "public"] as const) : ([g] as const)));
}

/**
 * The stored course types a list shows: the picked groups when there are any
 * (municipal_public then means both municipal and public), every type when
 * municipal courses are included, otherwise the default without municipal.
 * `undefined` means no course type condition at all.
 */
export function listedCourseTypes(f: Pick<ListingFilters, "courseTypes" | "includeMunicipal">): StoredCourseType[] | undefined {
  if (f.courseTypes.length > 0) return courseTypesForFilters(f.courseTypes);
  return f.includeMunicipal ? undefined : [...DEFAULT_COURSE_TYPES];
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
  if (f.courseTypes.length > 0) {
    if (!f.courseTypes.includes(courseTypeFilterOf(o.courseType))) return false;
  } else if (!f.includeMunicipal && o.courseType === "municipal") return false;
  if (f.charityOnly && o.outingType !== "charity" && o.outingType !== "school_fundraiser") return false;
  if (f.maxPriceCents !== null && (o.singlePriceCents === null || o.singlePriceCents > f.maxPriceCents)) return false;
  if (f.from !== null && (o.startDate === null || o.startDate < f.from)) return false;
  if (f.to !== null && (o.startDate === null || o.startDate > f.to)) return false;
  if (f.distanceMiles !== null && (o.distanceMiles === null || o.distanceMiles > f.distanceMiles)) return false;
  if (f.format !== null && o.format !== f.format) return false;
  if (f.singlesWelcome && o.singlePriceCents === null) return false;
  return true;
}

/** Writes filters back to query parameters (only the active ones). */
export function filtersToParams(f: ListingFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.courseTypes.length > 0) p.set("course_type", f.courseTypes.join(","));
  if (f.includeMunicipal) p.set(INCLUDE_MUNICIPAL_PARAM, "1");
  if (f.charityOnly) p.set("charity", "1");
  if (f.maxPriceCents !== null) p.set("max_price", String(Math.floor(f.maxPriceCents / 100)));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.distanceMiles !== null) p.set("distance", String(f.distanceMiles));
  if (f.format) p.set("format", f.format);
  if (f.singlesWelcome) p.set("singles", "1");
  return p;
}

/** What the home page's soonest list needs to know to put featured outings first. */
export interface FeaturableOuting {
  id: string;
  startDate: string | null;
  course: { courseType: string; notable: boolean };
}

/** A private or resort course on the top-course list (courses.notable). */
export function isFeaturedCourse(c: FeaturableOuting["course"]): boolean {
  return c.notable && (c.courseType === "private" || c.courseType === "resort");
}

/**
 * The home page's "soonest" order: outings at featured courses first, then the
 * rest, each soonest first. Takes any number of lists (a featured query and a
 * date query can overlap), drops repeats by id and keeps at most `limit`.
 * Ties keep their incoming order, so the database's tiebreakers survive.
 */
export function featuredFirst<T extends FeaturableOuting>(lists: readonly (readonly T[])[], limit: number): T[] {
  const seen = new Set<string>();
  const all: T[] = [];
  for (const list of lists) {
    for (const o of list) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      all.push(o);
    }
  }
  const date = (o: T) => o.startDate ?? "9999-12-31";
  const tier = (o: T) => (isFeaturedCourse(o.course) ? 0 : 1);
  return all
    .map((o, i) => ({ o, i }))
    .sort((a, b) => tier(a.o) - tier(b.o) || date(a.o).localeCompare(date(b.o)) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.o);
}
