import type { LatLng } from "@gof/shared/places";
import { normalizeCity } from "../match/course-name.ts";
import type { CityRow, ZipRow } from "./geonames.ts";

/**
 * City centroids for the 25 km matching rule (SPEC.md 8.6): the `cities` row when
 * the place is in cities1000, else the mean of the ZIP centroids whose postal place
 * name matches (catches places under 1,000 people, such as Gladwyne PA).
 */
export class PlaceLocator {
  private readonly cities = new Map<string, LatLng>();
  private readonly zipPlaces = new Map<string, LatLng>();

  constructor(cities: readonly CityRow[], zips: readonly ZipRow[]) {
    for (const c of cities) {
      const key = `${c.state}/${normalizeCity(c.name)}`;
      if (!this.cities.has(key)) this.cities.set(key, { lat: c.lat, lng: c.lng });
    }
    const sums = new Map<string, { lat: number; lng: number; n: number }>();
    for (const z of zips) {
      const key = `${z.state}/${normalizeCity(z.place)}`;
      const s = sums.get(key) ?? { lat: 0, lng: 0, n: 0 };
      s.lat += z.lat;
      s.lng += z.lng;
      s.n += 1;
      sums.set(key, s);
    }
    for (const [key, s] of sums) this.zipPlaces.set(key, { lat: s.lat / s.n, lng: s.lng / s.n });
  }

  cityCentroid(state: string, name: string): LatLng | null {
    const key = `${state.toUpperCase()}/${normalizeCity(name)}`;
    return this.cities.get(key) ?? this.zipPlaces.get(key) ?? null;
  }
}
