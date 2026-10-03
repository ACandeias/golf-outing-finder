import type { AstroGlobal } from "astro";
import { z } from "zod";
import {
  cityBySlug,
  isCityIndexable,
  listExpectedOutings,
  listUpcomingOutings,
  nearbyCitiesWithOutings,
  nearbyUpcomingOutings,
  type CityInfo,
  type OutingListItem,
} from "@gof/db/queries";
import type { ListingFilters } from "@gof/shared/filters";
import { isUsStateCode, type LatLng } from "@gof/shared/places";
import { getDb } from "./db.ts";
import { listToday } from "./clock.ts";
import { filtersFromUrl } from "./listing.ts";

export interface CityPageData {
  charity: boolean;
  st: string;
  city: CityInfo;
  center: LatLng | null;
  dated: OutingListItem[];
  expected: OutingListItem[];
  indexable: boolean;
  filters: ListingFilters;
  anyFilterParam: boolean;
  nearby: OutingListItem[];
  nearCities: { city: string; state: string; distanceKm: number }[];
}

const paramsSchema = z.object({
  state: z.string().regex(/^[a-z]{2}$/),
  city: z
    .string()
    .max(120)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});

/** Data for a city or charity city page; null means 404. */
export async function loadCityPage(astro: AstroGlobal, charity: boolean): Promise<CityPageData | null> {
  const params = paramsSchema.safeParse(astro.params);
  if (!params.success || !isUsStateCode(params.data.state.toUpperCase())) return null;
  const st = params.data.state.toUpperCase();
  const db = getDb();
  const today = listToday();
  const city = await cityBySlug(db, st, params.data.city);
  if (!city) return null;

  const charityOnly = charity || undefined;
  const [dated, expected, indexable] = await Promise.all([
    listUpcomingOutings(db, { state: st, city: city.name, charityOnly, today, limit: 1000 }),
    listExpectedOutings(db, { state: st, city: city.name, charityOnly, limit: 500 }),
    isCityIndexable(db, st, city.name, today, charity),
  ]);
  const center = city.lat !== null && city.lng !== null ? { lat: city.lat, lng: city.lng } : null;
  const { filters, anyFilterParam } = filtersFromUrl(astro.url);
  const [nearby, nearCities] = center
    ? await Promise.all([
        dated.length + expected.length === 0
          ? nearbyUpcomingOutings(db, { center, radiusKm: 80, today, limit: 6, charityOnly })
          : Promise.resolve([]),
        nearbyCitiesWithOutings(db, { center, today, excludeCity: city.name, limit: 10 }),
      ])
    : [[], []];
  return { charity, st, city, center, dated, expected, indexable, filters, anyFilterParam, nearby, nearCities };
}
