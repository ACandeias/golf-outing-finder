import { describe, expect, it } from "vitest";
import {
  buildPlaces,
  parseCitiesTsv,
  parsePostalTsv,
  selectMetros,
  type GeoCity,
  type GeoPostal,
} from "./geonames.ts";

const tsv = (cols: (string | number)[]): string => cols.join("\t");

// geonameid, name, asciiname, alternatenames, lat, lng, class, code, country, cc2,
// admin1, admin2, admin3, admin4, population, elevation, dem, timezone, modified
function cityLine(
  id: number,
  name: string,
  state: string,
  lat: number,
  lng: number,
  pop: number,
  code = "PPL",
  country = "US",
  tz = "America/New_York",
): string {
  return tsv([id, name, name, "", lat, lng, "P", code, country, "", state, "", "", "", pop, "", 10, tz, "2024-01-01"]);
}

// country, zip, place, state name, state code, county, county code, admin3, admin3 code, lat, lng, accuracy
function zipLine(zip: string, place: string, state: string, lat: number | "", lng: number | ""): string {
  return tsv(["US", zip, place, "X", state, "C", "1", "", "", lat, lng, 4]);
}

describe("parseCitiesTsv", () => {
  it("keeps US rows in the requested states", () => {
    const text = [
      cityLine(5126183, "Mamaroneck", "NY", 40.94871, -73.73263, 19375),
      cityLine(1, "Toronto", "08", 43.7, -79.4, 2_700_000, "PPLA", "CA", "America/Toronto"),
      cityLine(2, "Phoenix", "AZ", 33.44838, -112.07404, 1_600_000, "PPLA", "US", "America/Phoenix"),
    ].join("\n");
    const rows = parseCitiesTsv(text, new Set(["NY"]));
    expect(rows).toEqual([
      {
        id: 5126183,
        name: "Mamaroneck",
        state: "NY",
        lat: 40.94871,
        lng: -73.73263,
        population: 19375,
        timeZone: "America/New_York",
        featureCode: "PPL",
      },
    ]);
  });
  it("skips malformed rows instead of throwing", () => {
    expect(parseCitiesTsv("garbage\n\n", null)).toEqual([]);
  });
});

describe("parsePostalTsv", () => {
  it("keeps five-digit ZIPs with coordinates", () => {
    const text = [
      zipLine("10543", "Mamaroneck", "NY", 40.9529, -73.7363),
      zipLine("09001", "APO", "AE", "", ""),
      zipLine("1234", "Bad", "NY", 1, 1),
    ].join("\n");
    expect(parsePostalTsv(text, null)).toEqual([
      { zip: "10543", place: "Mamaroneck", state: "NY", lat: 40.9529, lng: -73.7363 },
    ]);
  });
});

describe("buildPlaces", () => {
  const cities: GeoCity[] = [
    { id: 10, name: "Springfield", state: "NJ", lat: 40.7, lng: -74.32, population: 14429, timeZone: "America/New_York", featureCode: "PPL" },
    { id: 11, name: "Springfield", state: "NJ", lat: 40.0, lng: -74.7, population: 1200, timeZone: "America/New_York", featureCode: "PPL" },
    { id: 12, name: "Paramus", state: "NJ", lat: 40.94, lng: -74.07, population: 26974, timeZone: "America/New_York", featureCode: "PPL" },
  ];
  const postals: GeoPostal[] = [
    { zip: "07081", place: "Springfield", state: "NJ", lat: 40.70, lng: -74.32 },
    { zip: "07652", place: "Paramus", state: "NJ", lat: 40.94, lng: -74.07 },
    { zip: "07035", place: "Lincoln Park", state: "NJ", lat: 40.92, lng: -74.30 },
    { zip: "08999", place: "Middle of Nowhere", state: "NJ", lat: 39.0, lng: -73.0 },
  ];

  it("keeps the most populous city for a duplicate state and slug", () => {
    const out = buildPlaces(cities, postals);
    const springfields = out.cities.filter((c) => c.slug === "springfield");
    expect(springfields).toHaveLength(1);
    expect(springfields[0]?.id).toBe(10);
  });

  it("links a ZIP to the same-name city, else the nearest within 30 km, else null", () => {
    const out = buildPlaces(cities, postals);
    const byZip = new Map(out.zips.map((z) => [z.zip, z]));
    expect(byZip.get("07081")?.cityId).toBe(10);
    expect(byZip.get("07652")?.cityId).toBe(12);
    expect(byZip.get("07035")?.cityId).toBe(12); // Paramus is ~19 km away
    expect(byZip.get("08999")?.cityId).toBeNull();
    expect(byZip.get("07035")?.place).toBe("Lincoln Park");
  });

  it("sorts cities by state then slug and ZIPs by ZIP", () => {
    const out = buildPlaces(cities, postals);
    expect(out.cities.map((c) => c.slug)).toEqual(["paramus", "springfield"]);
    expect(out.zips.map((z) => z.zip)).toEqual(["07035", "07081", "07652", "08999"]);
  });
});

describe("selectMetros", () => {
  it("takes the most populous cities, excluding neighbourhoods (PPLX)", () => {
    const rows: GeoCity[] = [
      { id: 1, name: "Big", state: "NY", lat: 1, lng: 1, population: 100, timeZone: "America/New_York", featureCode: "PPL" },
      { id: 2, name: "Hood", state: "NY", lat: 1, lng: 1, population: 1000, timeZone: "America/New_York", featureCode: "PPLX" },
      { id: 3, name: "Mid", state: "CA", lat: 1, lng: 1, population: 50, timeZone: "America/Los_Angeles", featureCode: "PPLA2" },
      { id: 4, name: "Small", state: "CA", lat: 1, lng: 1, population: 10, timeZone: "America/Los_Angeles", featureCode: "PPL" },
    ];
    expect(selectMetros(rows, 2).map((m) => m.name)).toEqual(["Big", "Mid"]);
  });
});
