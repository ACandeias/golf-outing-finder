import { describe, expect, it } from "vitest";
import { matchCourse, type MatchableCourse } from "./match-course.ts";

function course(
  id: string,
  name: string,
  state: string,
  city: string | null,
  lat: number,
  lng: number,
  aliases: string[] = [],
): MatchableCourse {
  return { id, name, state, city, lat, lng, aliases };
}

// Coordinates are the OSM centres recorded in tests/fixtures/courses.json.
const OAKMONT_PA = course("pa-oakmont", "Oakmont Country Club", "PA", "Oakmont", 40.529, -79.825);
const OAKMONT_GLENDALE = course("ca-oakmont", "Oakmont Country Club", "CA", "Glendale", 34.197, -118.2328);
const OAKMONT_SANTA_ROSA = course("ca-oakmont-sr", "Oakmont Golf Club", "CA", "Santa Rosa", 38.4325, -122.5898);
const WINGED_FOOT = course("ny-wf", "Winged Foot Golf Club", "NY", "Mamaroneck", 40.9625, -73.7539);
const QUAKER_RIDGE = course("ny-qr", "Quaker Ridge Golf Club", "NY", "Scarsdale", 40.9691, -73.7625);
const TORREY_NORTH = course("ca-tpn", "Torrey Pines North Course", "CA", "La Jolla", 32.9087, -117.249);
const TORREY_SOUTH = course("ca-tps", "Torrey Pines South Course", "CA", "La Jolla", 32.8971, -117.2476);
const BETHPAGE = course("ny-bsp", "Bethpage State Park Golf Courses", "NY", "Farmingdale", 40.7463, -73.4536);
const BETHPAGE_BLACK = course("ny-bb", "Bethpage Black", "NY", "Farmingdale", 40.7487, -73.4458);
const MEDINAH = course("il-med", "Medinah Country Club", "IL", "Medinah", 41.9681, -88.0475);
const RIVIERA_CA = course("ca-riv", "Riviera Country Club", "CA", "Pacific Palisades", 34.0453, -118.5022);
const RIVIERA_FL = course("fl-riv", "Riviera Country Club", "FL", "Coral Gables", 25.7302, -80.2823);

const ALL = [
  OAKMONT_PA,
  OAKMONT_GLENDALE,
  OAKMONT_SANTA_ROSA,
  WINGED_FOOT,
  QUAKER_RIDGE,
  TORREY_NORTH,
  TORREY_SOUTH,
  BETHPAGE,
  BETHPAGE_BLACK,
  MEDINAH,
  RIVIERA_CA,
  RIVIERA_FL,
];

const GLENDALE_CA = { lat: 34.14251, lng: -118.25508 };
const MAMARONECK = { lat: 40.94871, lng: -73.73263 };
const LA_JOLLA = { lat: 32.84727, lng: -117.2742 };
const FARMINGDALE = { lat: 40.73205, lng: -73.44540 };
const MEDINAH_IL = { lat: 41.97837, lng: -88.08035 };
const PACIFIC_PALISADES = { lat: 34.04806, lng: -118.52647 };

describe("matchCourse", () => {
  it("gc7: Oakmont Country Club, Glendale CA matches Glendale and never Oakmont PA", () => {
    const r = matchCourse({ name: "Oakmont Country Club", state: "CA", city: "Glendale" }, ALL, {
      cityCentroid: GLENDALE_CA,
    });
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.course.id).toBe("ca-oakmont");
    expect(r.candidates.map((c) => c.course.id)).not.toContain("pa-oakmont");
  });

  it("gc7: without a city, the two same-name California courses are ambiguous, never PA", () => {
    const r = matchCourse({ name: "Oakmont Country Club", state: "CA" }, ALL, {});
    expect(r.kind).toBe("ambiguous");
    expect(r.candidates.map((c) => c.course.id).sort()).toEqual(["ca-oakmont", "ca-oakmont-sr"]);
  });

  it("matches Oakmont PA only in Pennsylvania", () => {
    const r = matchCourse({ name: "Oakmont Country Club", state: "PA", city: "Oakmont" }, ALL, {
      cityCentroid: { lat: 40.52173, lng: -79.84227 },
    });
    expect(r.kind === "matched" && r.course.id).toBe("pa-oakmont");
  });

  it("Winged Foot Golf Club, Mamaroneck matches Winged Foot, not Quaker Ridge next door", () => {
    const r = matchCourse({ name: "Winged Foot Golf Club", state: "NY", city: "Mamaroneck" }, ALL, {
      cityCentroid: MAMARONECK,
    });
    expect(r.kind === "matched" && r.course.id).toBe("ny-wf");
  });

  it("Torrey Pines Golf Course (South) picks the South course and records North as an alias", () => {
    const r = matchCourse({ name: "Torrey Pines Golf Course (South)", state: "CA", city: "La Jolla" }, ALL, {
      cityCentroid: LA_JOLLA,
    });
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.course.id).toBe("ca-tps");
    expect(r.facility).toBe(true);
    expect(r.aliasesToAdd).toEqual(["Torrey Pines North Course"]);
  });

  it("Bethpage State Park (Red Course) matches the state park facility, not Bethpage Black", () => {
    const r = matchCourse(
      { name: "Bethpage State Park (Red Course)", state: "NY", city: "Farmingdale" },
      ALL,
      { cityCentroid: FARMINGDALE },
    );
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.course.id).toBe("ny-bsp");
    // "bethpage black" scores under 0.88 against "bethpage state park red", so it
    // is not a candidate at all.
    expect(r.candidates.map((c) => c.course.id)).toEqual(["ny-bsp"]);
  });

  it("Medinah Country Club (No. 3) matches Medinah Country Club", () => {
    const r = matchCourse({ name: "Medinah Country Club (No. 3)", state: "IL", city: "Medinah" }, ALL, {
      cityCentroid: MEDINAH_IL,
    });
    expect(r.kind === "matched" && r.course.id).toBe("il-med");
  });

  it("filters by state: Riviera Country Club in CA never matches the Florida one", () => {
    const r = matchCourse({ name: "Riviera Country Club", state: "CA", city: "Pacific Palisades" }, ALL, {
      cityCentroid: PACIFIC_PALISADES,
    });
    expect(r.kind === "matched" && r.course.id).toBe("ca-riv");
    const fl = matchCourse({ name: "Riviera Country Club", state: "FL" }, ALL, {});
    expect(fl.kind === "matched" && fl.course.id).toBe("fl-riv");
  });

  it("returns ambiguous (no match) for two same-name courses far apart in one state", () => {
    const a = course("nj-a", "Ridgewood Country Club", "NJ", "Paramus", 40.94, -74.06);
    const b = course("nj-b", "Ridgewood Country Club", "NJ", "Cape May", 38.95, -74.9);
    const r = matchCourse({ name: "Ridgewood Country Club", state: "NJ" }, [a, b], {});
    expect(r.kind).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  it("returns unmatched when the city is too far from every candidate", () => {
    const r = matchCourse({ name: "Winged Foot Golf Club", state: "NY", city: "Buffalo" }, ALL, {
      cityCentroid: { lat: 42.88645, lng: -78.87837 },
    });
    expect(r.kind).toBe("unmatched");
  });

  it("returns unmatched for an unknown course", () => {
    const r = matchCourse({ name: "Nowhere Hills Golf Club", state: "NY" }, ALL, {});
    expect(r.kind).toBe("unmatched");
  });

  it("accepts a course whose stored city equals the page city when no centroid is known", () => {
    const r = matchCourse({ name: "Winged Foot", state: "NY", city: "mamaroneck" }, ALL, {});
    expect(r.kind === "matched" && r.course.id).toBe("ny-wf");
  });

  it("matches through an alias", () => {
    const aliased = course("az-x", "Arizona Biltmore Golf Club", "AZ", "Phoenix", 33.52, -112.02, [
      "Adobe Course",
    ]);
    const r = matchCourse({ name: "Adobe Course", state: "AZ" }, [aliased], {});
    expect(r.kind).toBe("matched");
    if (r.kind !== "matched") return;
    expect(r.via).toBe("alias");
  });

  it("does not match below the 0.88 threshold", () => {
    const r = matchCourse({ name: "Sunset Hills Golf Club", state: "CA" }, [RIVIERA_CA], {});
    expect(r.kind).toBe("unmatched");
  });
});
