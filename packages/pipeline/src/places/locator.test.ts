import { describe, expect, it } from "vitest";
import type { CityRow, ZipRow } from "./geonames.ts";
import { PlaceLocator } from "./locator.ts";

const cities: CityRow[] = [
  { id: 1, slug: "mamaroneck", name: "Mamaroneck", state: "NY", lat: 40.9487, lng: -73.7326, population: 19375, timeZone: "America/New_York" },
  { id: 2, slug: "saint-louis", name: "Saint Louis", state: "MO", lat: 38.627, lng: -90.1994, population: 300000, timeZone: "America/Chicago" },
];
const zips: ZipRow[] = [
  { zip: "19035", lat: 40.04, lng: -75.28, cityId: null, place: "Gladwyne", state: "PA" },
  { zip: "19036", lat: 40.06, lng: -75.3, cityId: null, place: "Gladwyne", state: "PA" },
];

describe("PlaceLocator.cityCentroid", () => {
  const loc = new PlaceLocator(cities, zips);
  it("finds a city by name in its state", () => {
    expect(loc.cityCentroid("NY", "Mamaroneck")).toEqual({ lat: 40.9487, lng: -73.7326 });
    expect(loc.cityCentroid("CT", "Mamaroneck")).toBeNull();
  });
  it("treats St. and Saint alike", () => {
    expect(loc.cityCentroid("MO", "St. Louis")).toEqual({ lat: 38.627, lng: -90.1994 });
  });
  it("falls back to the mean of ZIP centroids with that place name", () => {
    const c = loc.cityCentroid("PA", "Gladwyne");
    expect(c?.lat).toBeCloseTo(40.05, 5);
    expect(c?.lng).toBeCloseTo(-75.29, 5);
  });
  it("returns null for an unknown place", () => {
    expect(loc.cityCentroid("PA", "Nowhere")).toBeNull();
  });
});
