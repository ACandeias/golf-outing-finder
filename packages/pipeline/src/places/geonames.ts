import { z } from "zod";
import { citySlug } from "@gof/shared/slug";
import { haversineKm, isUsStateCode } from "@gof/shared/places";

/**
 * GeoNames parsing for amendment A4 (SPEC.md v1.1). Pure functions: the CLI in
 * build.ts downloads the archives and writes the files.
 *
 * cities1000.txt columns: https://download.geonames.org/export/dump/readme.txt
 * US.txt (postal codes): https://download.geonames.org/export/zip/readme.txt
 */

export interface GeoCity {
  id: number;
  name: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
  timeZone: string;
  featureCode: string;
}

export interface GeoPostal {
  zip: string;
  place: string;
  state: string;
  lat: number;
  lng: number;
}

export interface CityRow {
  id: number;
  slug: string;
  name: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
  timeZone: string;
}

export interface ZipRow {
  zip: string;
  lat: number;
  lng: number;
  cityId: number | null;
  /** Postal place name; not a column in `zips`, kept to locate cities missing from cities1000. */
  place: string;
  state: string;
}

const num = z.coerce.number().finite();
const lat = num.min(-90).max(90);
const lng = num.min(-180).max(180);

const cityCols = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().min(1),
  lat,
  lng,
  featureClass: z.literal("P"),
  featureCode: z.string().regex(/^PPL[A-Z0-9]*$/),
  country: z.literal("US"),
  state: z.string().refine(isUsStateCode),
  population: z.coerce.number().int().min(0),
  timeZone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_/-]+$/),
});

const postalCols = z.object({
  country: z.literal("US"),
  zip: z.string().regex(/^\d{5}$/),
  place: z.string().min(1),
  state: z.string().refine(isUsStateCode),
  lat: z.string().min(1).pipe(lat),
  lng: z.string().min(1).pipe(lng),
});

/** Parses cities1000.txt, keeping US rows in `states` (or every state when null). */
export function parseCitiesTsv(text: string, states: ReadonlySet<string> | null): GeoCity[] {
  const out: GeoCity[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const parsed = cityCols.safeParse({
      id: c[0],
      name: c[1],
      lat: c[4],
      lng: c[5],
      featureClass: c[6],
      featureCode: c[7],
      country: c[8],
      state: c[10],
      population: c[14] || "0",
      timeZone: c[17],
    });
    if (!parsed.success) continue;
    const r = parsed.data;
    if (states && !states.has(r.state)) continue;
    out.push({
      id: r.id,
      name: r.name,
      state: r.state,
      lat: r.lat,
      lng: r.lng,
      population: r.population,
      timeZone: r.timeZone,
      featureCode: r.featureCode,
    });
  }
  return out;
}

/** Parses the GeoNames US postal code file, keeping five-digit ZIPs with coordinates. */
export function parsePostalTsv(text: string, states: ReadonlySet<string> | null): GeoPostal[] {
  const out: GeoPostal[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const parsed = postalCols.safeParse({
      country: c[0],
      zip: c[1],
      place: c[2],
      state: c[4],
      lat: c[9],
      lng: c[10],
    });
    if (!parsed.success) continue;
    const r = parsed.data;
    if (states && !states.has(r.state)) continue;
    out.push({ zip: r.zip, place: r.place, state: r.state, lat: r.lat, lng: r.lng });
  }
  return out;
}

export const ZIP_CITY_RADIUS_KM = 30;

/**
 * Builds `cities` and `zips` rows. City slugs are unique within a state
 * (cities_state_slug): when two places share a name in a state, the most
 * populous one is kept. A ZIP links to the same-name city in its state, else the
 * nearest city within 30 km, else null.
 */
export function buildPlaces(
  geoCities: readonly GeoCity[],
  postals: readonly GeoPostal[],
): { cities: CityRow[]; zips: ZipRow[] } {
  const byKey = new Map<string, CityRow>();
  const sorted = [...geoCities].sort((a, b) => b.population - a.population || a.id - b.id);
  for (const c of sorted) {
    const slug = citySlug(c.name);
    if (!slug) continue;
    const key = `${c.state}/${slug}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: c.id,
      slug,
      name: c.name,
      state: c.state,
      lat: c.lat,
      lng: c.lng,
      population: c.population,
      timeZone: c.timeZone,
    });
  }
  const cities = [...byKey.values()].sort((a, b) =>
    a.state === b.state ? (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) : a.state < b.state ? -1 : 1,
  );
  const index = new CityIndex(cities);

  const seen = new Set<string>();
  const zips: ZipRow[] = [];
  for (const p of [...postals].sort((a, b) => (a.zip < b.zip ? -1 : a.zip > b.zip ? 1 : 0))) {
    if (seen.has(p.zip)) continue;
    seen.add(p.zip);
    const same = byKey.get(`${p.state}/${citySlug(p.place)}`);
    const city = same ?? index.nearest(p, ZIP_CITY_RADIUS_KM, p.state);
    zips.push({ zip: p.zip, lat: p.lat, lng: p.lng, cityId: city?.id ?? null, place: p.place, state: p.state });
  }
  return { cities, zips };
}

/** The most populous cities, for place queries (metros.yaml). Neighbourhoods (PPLX) are left out. */
export function selectMetros(geoCities: readonly GeoCity[], count: number): GeoCity[] {
  return geoCities
    .filter((c) => c.featureCode !== "PPLX")
    .sort((a, b) => b.population - a.population || a.id - b.id)
    .slice(0, count);
}

/** A grid index over cities for nearest-neighbour lookups (0.5 degree cells). */
export class CityIndex<C extends { lat: number; lng: number; state: string }> {
  private readonly cells = new Map<string, C[]>();
  private static readonly CELL = 0.5;

  constructor(cities: readonly C[]) {
    for (const c of cities) {
      const key = CityIndex.key(c.lat, c.lng);
      const list = this.cells.get(key);
      if (list) list.push(c);
      else this.cells.set(key, [c]);
    }
  }

  private static key(lat: number, lng: number): string {
    return `${Math.floor(lat / CityIndex.CELL)}:${Math.floor(lng / CityIndex.CELL)}`;
  }

  /** Nearest city within `maxKm` (optionally in one state); null when none. */
  nearest(p: { lat: number; lng: number }, maxKm: number, state?: string): C | null {
    const cy = Math.floor(p.lat / CityIndex.CELL);
    const cx = Math.floor(p.lng / CityIndex.CELL);
    // A cell is ~55 km tall and 55 km * cos(lat) wide.
    const reachY = Math.max(1, Math.ceil(maxKm / 55));
    const cos = Math.max(Math.cos((p.lat * Math.PI) / 180), 0.05);
    const reachX = Math.max(1, Math.ceil(maxKm / (55 * cos)));
    let best: C | null = null;
    let bestD = Infinity;
    for (let dy = -reachY; dy <= reachY; dy++) {
      for (let dx = -reachX; dx <= reachX; dx++) {
        for (const c of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          if (state && c.state !== state) continue;
          const d = haversineKm(p, c);
          if (d <= maxKm && d < bestD) {
            best = c;
            bestD = d;
          }
        }
      }
    }
    return best;
  }
}
