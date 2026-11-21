import type { OutingListItem } from "@gof/db/queries";
import { parseFilterParams, type ParsedFilters } from "@gof/shared/filter-params";
import { matchesFilters, parseSort, type ListingFilters, type SortOrder } from "@gof/shared/filters";
import { haversineKm, KM_PER_MILE, type LatLng } from "@gof/shared/places";
import { monthYear } from "./format.ts";

/**
 * Filters and sort from the request URL. Any filter parameter, or a `sort`
 * parameter (a re-ordered copy of the page), means noindex with the unfiltered
 * canonical (SPEC.md 9.2).
 */
export function filtersFromUrl(url: URL): ParsedFilters & { sort: SortOrder } {
  const parsed = parseFilterParams(url.searchParams);
  const { sort, present } = parseSort(url.searchParams);
  return { ...parsed, sort, anyFilterParam: parsed.anyFilterParam || present };
}

/** Outing URLs in the order a list page shows them (its ItemList). */
export function orderedForList(
  dated: readonly OutingListItem[],
  expected: readonly OutingListItem[],
  sort: SortOrder,
): OutingListItem[] {
  return listGroups(dated, expected, sort).flatMap((g) => g.outings);
}

export function isVisible(o: OutingListItem, f: ListingFilters, center: LatLng | null): boolean {
  return matchesFilters(
    {
      courseType: o.course.courseType,
      outingType: o.outingType,
      singlePriceCents: o.singlePriceCents,
      startDate: o.startDate,
      format: o.format,
      distanceMiles: center ? haversineKm(center, o.course) / KM_PER_MILE : null,
    },
    f,
  );
}

export interface MonthGroup {
  key: string;
  heading: string;
  outings: OutingListItem[];
}

/** Dated outings by start month, then expected outings by expected month. */
export function groupByMonth(dated: readonly OutingListItem[], expected: readonly OutingListItem[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const o of dated) {
    const key = (o.startDate ?? "").slice(0, 7);
    const g = groups.get(key) ?? { key, heading: monthYear(key), outings: [] };
    g.outings.push(o);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  if (expected.length > 0) {
    out.push({ key: "expected", heading: "Expected outings, dates not yet confirmed", outings: [...expected] });
  }
  return out;
}

/** The heading over the top-course part of a list sorted by ranking. */
export const TOP_COURSES_HEADING = "At top-ranked courses";

/**
 * A list page's sections. By date: months, then expected outings. By ranking
 * (the default): outings at courses on the top-course list first in one
 * section, dated then expected, then the rest by month. `dated` comes in date
 * order and `expected` in expected-month order (the queries' own order).
 */
export function listGroups(
  dated: readonly OutingListItem[],
  expected: readonly OutingListItem[],
  sort: SortOrder,
): MonthGroup[] {
  if (sort === "date") return groupByMonth(dated, expected);
  const top = [...dated, ...expected].filter((o) => o.course.notable);
  const rest = groupByMonth(
    dated.filter((o) => !o.course.notable),
    expected.filter((o) => !o.course.notable),
  );
  return top.length > 0 ? [{ key: "top", heading: TOP_COURSES_HEADING, outings: top }, ...rest] : rest;
}

/** The meta description for a list page, built from the data. */
export function listDescription(place: string, outings: readonly OutingListItem[], charity = false): string {
  const n = outings.length;
  const kind = charity ? "charity golf tournaments and fundraisers" : "golf outings and charity tournaments";
  if (n === 0) return `Find ${kind} near ${place}: dates, prices, what's included and how to register.`;
  const courses = [...new Set(outings.map((o) => o.course.name))].slice(0, 3);
  const at = courses.length > 0 ? ` at ${courses.join(", ")}` : "";
  return `${n} ${n === 1 ? "upcoming outing" : "upcoming outings"} in ${place}${at}. Dates, prices per player and foursome, what's included and registration links.`.slice(
    0,
    300,
  );
}
