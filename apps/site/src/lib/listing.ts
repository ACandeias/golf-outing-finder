import type { OutingListItem } from "@gof/db/queries";
import { parseFilterParams, type ParsedFilters } from "@gof/shared/filter-params";
import { matchesFilters, type ListingFilters } from "@gof/shared/filters";
import { haversineKm, KM_PER_MILE, type LatLng } from "@gof/shared/places";
import { monthYear } from "./format.ts";

/** Filters from the request URL; any filter parameter means noindex (SPEC.md 9.2). */
export function filtersFromUrl(url: URL): ParsedFilters {
  return parseFilterParams(url.searchParams);
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
