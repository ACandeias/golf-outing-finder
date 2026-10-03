import tzLookup from "tz-lookup";
import { describe, expect, it } from "vitest";
import { isUlid } from "@gof/shared/ids";
import type { CityRow } from "../places/geonames.ts";
import { buildCourses, type ImportContext } from "./import.ts";
import type { OsmFeature } from "./overpass.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");

const city = (id: number, name: string, state: string, lat: number, lng: number, population = 5000): CityRow => ({
  id,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  state,
  lat,
  lng,
  population,
  timeZone: "America/New_York",
});

const CITIES: CityRow[] = [
  city(1, "Mamaroneck", "NY", 40.94871, -73.73263),
  city(2, "Scarsdale", "NY", 41.0051, -73.78458),
  city(3, "Greenwich", "CT", 41.02649, -73.62846),
  city(4, "Phoenix", "AZ", 33.44838, -112.07404, 1_600_000),
  city(5, "White Plains", "NY", 41.03399, -73.76291),
];

const f = (osmRef: string, state: string, lat: number, lng: number, tags: Record<string, string>): OsmFeature => ({
  osmRef,
  state,
  lat,
  lng,
  tags: { leisure: "golf_course", ...tags },
});

function ctx(over: Partial<ImportContext> = {}): ImportContext {
  return {
    now: NOW,
    cities: CITIES,
    overrides: [],
    timeZoneAt: (lat, lng) => tzLookup(lat, lng),
    ...over,
  };
}

describe("buildCourses", () => {
  it("drops excluded features and reports them", () => {
    const { courses, dropped } = buildCourses(
      [
        f("way/1", "NY", 40.96, -73.75, { name: "Winged Foot Golf Club" }),
        f("way/2", "NY", 40.96, -73.75, { name: "Mini Golf Land" }),
        f("node/3", "NY", 40.96, -73.75, {}),
      ],
      ctx(),
    );
    expect(courses.map((c) => c.osmRef)).toEqual(["way/1"]);
    expect(dropped.map((d) => d.osmRef).sort()).toEqual(["node/3", "way/2"]);
  });

  it("uses addr:city, else the nearest same-state city within 30 km, else null", () => {
    const { courses } = buildCourses(
      [
        f("way/1", "NY", 40.9625, -73.7539, { name: "Winged Foot Golf Club" }),
        f("way/2", "NY", 41.0366, -73.8002, { name: "Metropolis Country Club", "addr:city": "white plains" }),
        // Closer to Greenwich CT than to any NY city, but the city must be in NY.
        f("way/3", "NY", 41.02, -73.66, { name: "Border Golf Club" }),
        f("way/4", "NY", 43.0, -75.0, { name: "Far Away Golf Club" }),
      ],
      ctx(),
    );
    const byRef = new Map(courses.map((c) => [c.osmRef, c]));
    expect(byRef.get("way/1")?.city).toBe("Mamaroneck");
    expect(byRef.get("way/2")?.city).toBe("White Plains");
    expect(byRef.get("way/3")?.city).not.toBe("Greenwich");
    expect(byRef.get("way/4")?.city).toBeNull();
  });

  it("ignores an addr:city that is an address fragment and uses the nearest city instead", () => {
    const { courses } = buildCourses(
      [
        // Real OSM data for Peachtree Golf Club has addr:city "NE  Suite 2800".
        f("way/5", "NY", 40.9625, -73.7539, { name: "Fragment Golf Club", "addr:city": "NE  Suite 2800" }),
        f("way/6", "NY", 40.9625, -73.7539, { name: "Unknown Town Golf Club", "addr:city": "Larchmont Manor" }),
      ],
      ctx(),
    );
    const byRef = new Map(courses.map((c) => [c.osmRef, c]));
    expect(byRef.get("way/5")?.city).toBe("Mamaroneck");
    expect(byRef.get("way/6")?.city).toBe("Larchmont Manor");
  });

  it("builds {state}/{kebab(name)} slugs, adding the city on a collision, then -2", () => {
    const { courses } = buildCourses(
      [
        f("way/10", "NY", 40.95, -73.73, { name: "Twin Oaks Golf Course" }),
        f("way/11", "NY", 41.0, -73.78, { name: "Twin Oaks Golf Course" }),
        f("way/12", "NY", 41.001, -73.781, { name: "Twin Oaks Golf Course" }),
      ],
      ctx(),
    );
    expect(courses.map((c) => c.slug)).toEqual([
      "ny/twin-oaks-golf-course",
      "ny/twin-oaks-golf-course-scarsdale",
      "ny/twin-oaks-golf-course-scarsdale-2",
    ]);
  });

  it("keeps the id and slug of a course already in the database", () => {
    const { courses } = buildCourses([f("way/1", "NY", 40.96, -73.75, { name: "Winged Foot Golf Club" })], ctx({
      existing: [{ id: "crs_EXISTING", slug: "ny/winged-foot", osmRef: "way/1" }],
    }));
    expect(courses[0]?.id).toBe("crs_EXISTING");
    expect(courses[0]?.slug).toBe("ny/winged-foot");
  });

  it("does not reuse a slug that an existing course holds", () => {
    const { courses } = buildCourses([f("way/2", "NY", 40.96, -73.75, { name: "Winged Foot Golf Club" })], ctx({
      existing: [{ id: "crs_X", slug: "ny/winged-foot-golf-club", osmRef: "way/1" }],
    }));
    expect(courses[0]?.slug).toBe("ny/winged-foot-golf-club-mamaroneck");
  });

  it("makes deterministic crs_ ULIDs", () => {
    const a = buildCourses([f("way/1", "NY", 40.96, -73.75, { name: "A Golf Club" })], ctx()).courses[0];
    const b = buildCourses([f("way/1", "NY", 40.96, -73.75, { name: "A Golf Club" })], ctx()).courses[0];
    expect(a?.id).toBe(b?.id);
    expect(a?.id.startsWith("crs_")).toBe(true);
    expect(isUlid(a?.id.slice(4) ?? "")).toBe(true);
  });

  it("sets course_type: override, then OSM tags, then the website hook, then unknown", () => {
    const { courses } = buildCourses(
      [
        f("way/1", "AZ", 33.47, -112.09, { name: "Encanto 18 Golf Course", operator: "City of Phoenix", access: "private" }),
        f("way/2", "AZ", 33.47, -112.09, { name: "Encanto 9 Golf Course", operator: "City of Phoenix" }),
        f("way/3", "AZ", 33.5, -112.0, { name: "Private Club", access: "private" }),
        f("way/4", "AZ", 33.5, -112.0, { name: "Hook Course", website: "https://hook.example/" }),
        f("way/5", "AZ", 33.5, -112.0, { name: "Low Confidence Course", website: "https://low.example/" }),
        f("way/6", "AZ", 33.5, -112.0, { name: "Plain Course" }),
      ],
      ctx({
        overrides: [{ osm_ref: "way/1", course_type: "municipal", reason: "seed" }],
        websiteClassifications: new Map([
          ["way/4", { courseType: "semi_private", confidence: 0.82 }],
          ["way/5", { courseType: "resort", confidence: 0.5 }],
        ]),
      }),
    );
    const t = Object.fromEntries(courses.map((c) => [c.osmRef, [c.courseType, c.courseTypeSource, c.courseTypeConfidence]]));
    expect(t).toEqual({
      "way/1": ["municipal", "override", 1],
      "way/2": ["municipal", "osm", null],
      "way/3": ["private", "osm", null],
      "way/4": ["semi_private", "website_llm", 0.82],
      "way/5": ["unknown", null, null],
      "way/6": ["unknown", null, null],
    });
  });

  it("applies a course_id override to an existing course", () => {
    const { courses } = buildCourses([f("way/1", "NY", 40.96, -73.75, { name: "A Golf Club" })], ctx({
      existing: [{ id: "crs_KEEP", slug: "ny/a-golf-club", osmRef: "way/1" }],
      overrides: [{ course_id: "crs_KEEP", course_type: "resort", reason: "owner" }],
    }));
    expect(courses[0]?.courseType).toBe("resort");
  });

  it("fills time zone, street, zip, website, aliases and notable", () => {
    const { courses } = buildCourses(
      [
        f("way/1", "AZ", 33.4752, -112.0897, {
          name: "Encanto 18 Golf Course",
          "addr:housenumber": "2775",
          "addr:street": "North 15th Avenue",
          "addr:postcode": "85007-1234",
          website: "javascript:alert(1)",
          "contact:website": "https://www.phoenix.gov/parks/golf",
          alt_name: "Encanto Golf Course;Encanto Park Golf",
        }),
      ],
      ctx({ notable: { names: ["Encanto 18 Golf Course"], osmRefs: [] } }),
    );
    const c = courses[0];
    expect(c?.timeZone).toBe("America/Phoenix");
    expect(c?.street).toBe("2775 North 15th Avenue");
    expect(c?.zip).toBe("85007");
    expect(c?.website).toBe("https://www.phoenix.gov/parks/golf");
    expect(c?.aliases).toEqual(["Encanto Golf Course", "Encanto Park Golf"]);
    expect(c?.notable).toBe(1);
    expect(c?.outingCount).toBe(0);
    expect(c?.createdAt).toBe("2026-09-28T12:00:00.000Z");
  });

  it("keeps one row per osm_ref when a feature appears in two states", () => {
    const { courses } = buildCourses(
      [
        f("way/1", "NY", 41.0, -73.66, { name: "Border Golf Club" }),
        f("way/1", "CT", 41.0, -73.66, { name: "Border Golf Club" }),
      ],
      ctx(),
    );
    expect(courses).toHaveLength(1);
    expect(courses[0]?.state).toBe("NY");
  });
});
