import { describe, expect, it } from "vitest";
import {
  parseTopCoursesFile,
  resolveTopCourses,
  topCoursesAsNotable,
  type PoolCourse,
  type TopCourse,
} from "../src/topcourses/list.ts";

function entry(over: Partial<TopCourse> = {}): TopCourse {
  return {
    name: "Winged Foot Golf Club (West)",
    city: "Mamaroneck",
    state: "NY",
    country: "US",
    course_type: "private",
    website: null,
    osm_ref: null,
    searched_for_outings: null,
    ...over,
  };
}

function course(over: Partial<PoolCourse> & Pick<PoolCourse, "id" | "name">): PoolCourse {
  return {
    aliases: [],
    state: "NY",
    city: "Mamaroneck",
    lat: 40.95,
    lng: -73.75,
    osm_ref: `way/${over.id.replace(/\D/g, "") || "1"}`,
    website: null,
    ...over,
  };
}

const NOWHERE = (): null => null;

describe("parseTopCoursesFile", () => {
  it("accepts a valid file", () => {
    const f = parseTopCoursesFile(JSON.stringify({ version: "2026-11-19", notes: "x", courses: [entry()] }));
    expect(f.courses).toHaveLength(1);
  });

  it("rejects ranking fields so ranks never reach the public repo", () => {
    const bad = { version: "v", notes: "x", courses: [{ ...entry(), lists: ["gd-100"] }] };
    expect(() => parseTopCoursesFile(JSON.stringify(bad))).toThrow();
    const ranked = { version: "v", notes: "x", courses: [{ ...entry(), rank: 3 }] };
    expect(() => parseTopCoursesFile(JSON.stringify(ranked))).toThrow();
  });

  it("rejects an unknown course type, a bad state and a bad osm_ref", () => {
    for (const over of [{ course_type: "unknown" }, { state: "New York" }, { osm_ref: "way:1" }]) {
      const f = { version: "v", notes: "x", courses: [{ ...entry(), ...over }] };
      expect(() => parseTopCoursesFile(JSON.stringify(f))).toThrow();
    }
  });

  it("rejects duplicate name and state pairs", () => {
    const f = { version: "v", notes: "x", courses: [entry(), entry()] };
    expect(() => parseTopCoursesFile(JSON.stringify(f))).toThrow(/duplicate/i);
  });
});

describe("resolveTopCourses", () => {
  it("matches by name in the same city and fills osm_ref and website", () => {
    const pool = [course({ id: "crs_1", name: "Winged Foot Golf Club", website: "https://www.wfgc.org/" })];
    const [r] = resolveTopCourses([entry()], pool, NOWHERE);
    expect(r?.kind).toBe("matched");
    expect(r?.entry.osm_ref).toBe("way/1");
    expect(r?.entry.website).toBe("https://www.wfgc.org/");
  });

  it("keeps an osm_ref already in the file, even when the name would not match", () => {
    const pool = [course({ id: "crs_7", name: "Something Else", osm_ref: "way/7" })];
    const [r] = resolveTopCourses([entry({ osm_ref: "way/7" })], pool, NOWHERE);
    expect(r?.kind).toBe("pinned");
    expect(r?.course?.id).toBe("crs_7");
  });

  it("reports a pinned osm_ref that is no longer in the pool", () => {
    const [r] = resolveTopCourses([entry({ osm_ref: "way/99" })], [], NOWHERE);
    expect(r?.kind).toBe("missing");
  });

  it("sends a same-name club with a different club word to review (Pine Valley)", () => {
    // Pine Valley Country Club (Pine Hill) is 3 km from Pine Valley Golf Club, and the
    // two normalize to the same name, so matchCourse alone would pin the wrong club.
    const pool = [
      course({ id: "crs_2", name: "Pine Valley Country Club", state: "NJ", city: "Pine Hill", lat: 39.78, lng: -74.99 }),
    ];
    const pv = entry({ name: "Pine Valley Golf Club", city: "Pine Valley", state: "NJ" });
    const [r] = resolveTopCourses([pv], pool, () => ({ lat: 39.787, lng: -74.972 }));
    expect(r?.kind).toBe("review");
    expect(r?.entry.osm_ref).toBeNull();
  });

  it("matches a course listed under a neighboring town within the city radius", () => {
    const pool = [
      course({ id: "crs_4", name: "Whistling Straits", state: "WI", city: "Sheboygan", lat: 43.85, lng: -87.73 }),
    ];
    const ws = entry({ name: "Whistling Straits (Straits)", city: "Haven", state: "WI", course_type: "resort" });
    const [r] = resolveTopCourses([ws], pool, () => ({ lat: 43.86, lng: -87.73 }));
    expect(r?.kind).toBe("matched");
  });

  it("does not overwrite a website already in the file", () => {
    const pool = [course({ id: "crs_1", name: "Winged Foot Golf Club", website: "https://osm.example/" })];
    const [r] = resolveTopCourses([entry({ website: "https://www.wfgc.org/" })], pool, NOWHERE);
    expect(r?.entry.website).toBe("https://www.wfgc.org/");
  });

  it("reports ambiguous matches with their candidates", () => {
    const pool = [
      course({ id: "crs_1", name: "Winged Foot Golf Club", lat: 40.95, lng: -73.75 }),
      course({ id: "crs_3", name: "Winged Foot Golf Club", lat: 41.5, lng: -73.75 }),
    ];
    const [r] = resolveTopCourses([entry()], pool, NOWHERE);
    expect(r?.kind).toBe("ambiguous");
    expect(r?.candidates.length).toBe(2);
  });

  it("takes a clear winner out of an ambiguous match (Augusta Country Club vs Augusta National)", () => {
    const pool = [
      course({ id: "crs_10", name: "Augusta Country Club", state: "GA", city: "Augusta", lat: 33.49, lng: -82.02 }),
      course({ id: "crs_11", name: "Augusta National Golf Club", state: "GA", city: "Augusta", lat: 33.5, lng: -82.02 }),
      course({ id: "crs_12", name: "Augusta Municipal Golf Course", state: "GA", city: "Augusta", lat: 33.43, lng: -82.06 }),
    ];
    const [r] = resolveTopCourses([entry({ name: "Augusta Country Club", city: "Augusta", state: "GA" })], pool, NOWHERE);
    expect(r?.kind).toBe("matched");
    expect(r?.course?.id).toBe("crs_10");
  });

  it("falls back to a near-exact, unique name in the state when the city finds nothing", () => {
    const pool = [course({ id: "crs_4", name: "Whistling Straits", state: "WI", city: "Sheboygan", lat: 43.85, lng: -87.73 })];
    const ws = entry({ name: "Whistling Straits (Straits)", city: "Haven", state: "WI", course_type: "resort" });
    const [r] = resolveTopCourses([ws], pool, NOWHERE);
    expect(r?.kind).toBe("statewide");
    expect(r?.entry.osm_ref).toBe("way/4");
  });

  it("does not fall back statewide when the name is common in the state", () => {
    const pool = [
      course({ id: "crs_20", name: "Brookside Country Club", state: "OH", city: "Columbus", lat: 40.0, lng: -83.0 }),
      course({ id: "crs_21", name: "Brookside Golf Club", state: "OH", city: "Ashland", lat: 40.8, lng: -82.3 }),
    ];
    const [r] = resolveTopCourses([entry({ name: "Brookside Country Club", city: "Canton", state: "OH" })], pool, NOWHERE);
    expect(r?.kind).not.toBe("statewide");
    expect(r?.entry.osm_ref).toBeNull();
  });

  it("keeps Philadelphia Cricket Club and Jupiter Hills off the Country Clubs that share their first word", () => {
    const pool = [
      course({ id: "crs_30", name: "Philadelphia Country Club", state: "PA", city: "Flourtown", lat: 40.1, lng: -75.2 }),
      course({ id: "crs_31", name: "Jupiter Country Club", state: "FL", city: "Tequesta", lat: 26.95, lng: -80.1 }),
    ];
    const rs = resolveTopCourses(
      [
        entry({ name: "Philadelphia Cricket Club (Wissahickon)", city: "Flourtown", state: "PA" }),
        entry({ name: "Jupiter Hills Club (Hills)", city: "Tequesta", state: "FL" }),
      ],
      pool,
      NOWHERE,
    );
    for (const r of rs) expect(r.entry.osm_ref).toBeNull();
  });
});

describe("topCoursesAsNotable", () => {
  it("flags every pinned entry by osm_ref, and never by name alone", () => {
    const f = parseTopCoursesFile(
      JSON.stringify({
        version: "2026-11-21",
        notes: "x",
        courses: [
          entry({ name: "Winged Foot Golf Club (West)", osm_ref: "way/122734591" }),
          entry({ name: "Pine Valley Golf Club", city: "Pine Valley", state: "NJ", osm_ref: null }),
          entry({ name: "Bethpage Black", city: "Farmingdale", course_type: "municipal", osm_ref: "way/29468839" }),
        ],
      }),
    );
    // A bare name would flag every same-named course in the country.
    expect(topCoursesAsNotable(f)).toEqual({ names: [], osmRefs: ["way/122734591", "way/29468839"] });
  });

  it("the committed list pins most entries", async () => {
    const { readFile } = await import("node:fs/promises");
    const { PATHS } = await import("../src/lib/paths.ts");
    const n = topCoursesAsNotable(parseTopCoursesFile(await readFile(PATHS.topCourses, "utf8")));
    expect(n.osmRefs.length).toBeGreaterThan(250);
    expect(new Set(n.osmRefs).size).toBe(n.osmRefs.length);
  });
});
