/**
 * Course import and matching against the recorded Overpass fixture
 * (tests/fixtures/courses.json). Offline.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SEED_STATES } from "@gof/shared/places";
import { readCoursesFixture, type CoursesFixture } from "../src/courses/fixture.ts";
import type { CourseRecord } from "../src/courses/import.ts";
import { PATHS } from "../src/lib/paths.ts";
import { matchCourse } from "../src/match/match-course.ts";
import { seedCourseTypeOverrides } from "../src/seed/course-types-cli.ts";
import { loadCourseContext, type CourseContext } from "../src/seed/context.ts";
import { readSeedFile, type SeedFile } from "../src/seed/seed-file.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");

// OSM ids in the recorded fixture.
const REF = {
  wingedFoot: "way/122734591",
  quakerRidge: "way/122734578",
  bethpage: "way/29468839",
  bethpageBlack: "node/2854158382",
  torreyNorth: "way/35679009",
  torreySouth: "way/35679036",
  rivieraCA: "way/44652700",
  oakmontPA: "relation/6174192",
  oakmontGlendale: "way/369572200",
  oakmontSantaRosa: "relation/2626831",
  medinah: "way/143789356",
  ridgewoodNJ: "way/44108723",
  ridgewoodCT: "way/43434044",
} as const;

let fixture: CoursesFixture;
let ctx: CourseContext;
let seed: SeedFile;

beforeAll(async () => {
  fixture = await readCoursesFixture(PATHS.coursesFixture);
  ctx = await loadCourseContext({ now: NOW });
  seed = await readSeedFile(PATHS.seed);
});

const byRef = (ref: string): CourseRecord | undefined => ctx.courses.find((c) => c.osmRef === ref);

function match(id: string) {
  const e = seed.outings.find((o) => o.id === id);
  if (!e) throw new Error(`no seed entry ${id}`);
  return matchCourse({ name: e.course_name, state: e.course_state, city: e.course_city }, ctx.courses, {
    cityCentroid: ctx.locator.cityCentroid(e.course_state, e.course_city),
  });
}

describe("tests/fixtures/courses.json", () => {
  it("has every seed state, recorded from Overpass with attribution", () => {
    expect(Object.keys(fixture.states).sort()).toEqual([...SEED_STATES].sort());
    expect(fixture.attribution).toContain("OpenStreetMap contributors");
  });

  it("holds the decoys: Oakmont PA and Glendale CA, Riviera FL, Ridgewood CT, Encanto 9", () => {
    expect(byRef(REF.oakmontPA)?.state).toBe("PA");
    expect(byRef(REF.oakmontGlendale)?.state).toBe("CA");
    // OSM has no addr:city for it; the nearest GeoNames place (SPEC 8.1) is La Crescenta-Montrose.
    expect(byRef(REF.oakmontGlendale)?.city).toBe("La Crescenta-Montrose");
    expect(byRef(REF.ridgewoodCT)?.state).toBe("CT");
    expect(ctx.courses.filter((c) => c.state === "FL" && /riviera country club/i.test(c.name)).length).toBeGreaterThan(0);
    // OSM names Encanto 18 "Encanto Golf Course" and Encanto 9 "Encanto 9 Hole Executive Golf Course".
    expect(ctx.courses.some((c) => c.state === "AZ" && /^encanto 9/i.test(c.name))).toBe(true);
    expect(ctx.courses.some((c) => c.state === "AZ" && c.name === "Encanto Golf Course")).toBe(true);
  });

  it("imports with time zones, slugs and cities", () => {
    const wf = byRef(REF.wingedFoot);
    expect(wf).toMatchObject({ slug: "ny/winged-foot-golf-club", city: "Mamaroneck", timeZone: "America/New_York" });
    expect(byRef(REF.medinah)?.timeZone).toBe("America/Chicago");
    expect(ctx.courses.find((c) => c.name === "Encanto Golf Course")?.timeZone).toBe("America/Phoenix");
    expect(new Set(ctx.courses.map((c) => c.slug)).size).toBe(ctx.courses.length);
    expect(new Set(ctx.courses.map((c) => c.osmRef)).size).toBe(ctx.courses.length);
  });

  it("drops mini golf, putting courses, Topgolf and driving ranges", () => {
    for (const c of ctx.courses) {
      expect(c.name).not.toMatch(/mini ?golf|miniature|\bputt(-putt|ing)?\b|topgolf|driving range/i);
    }
  });
});

describe("matcher on the fixture (SPEC 8.6)", () => {
  it("gc7: Oakmont Country Club, Glendale CA matches the Glendale course, never Oakmont PA", () => {
    const r = match("s15-synthetic-oakmont-glendale");
    expect(r.kind === "matched" && r.course.osmRef).toBe(REF.oakmontGlendale);
    expect(r.candidates.map((c) => c.course.osmRef)).not.toContain(REF.oakmontPA);
    expect(r.candidates.map((c) => c.course.osmRef)).not.toContain(REF.oakmontSantaRosa);
  });

  it("matches Oakmont PA for the Oakmont, PA entries", () => {
    for (const id of ["e01-st-anthony-oakmont", "e02-presbyterian-seniorcare-oakmont"]) {
      const r = match(id);
      expect(r.kind === "matched" && r.course.osmRef).toBe(REF.oakmontPA);
    }
  });

  it("Winged Foot Golf Club matches Winged Foot, not Quaker Ridge next door", () => {
    for (const id of ["s04-fordham-winged-foot", "s06-nkf-winged-foot", "e08-autism-speaks-winged-foot"]) {
      const r = match(id);
      expect(r.kind === "matched" && r.course.osmRef).toBe(REF.wingedFoot);
    }
  });

  it("Torrey Pines Golf Course (South) picks the South course", () => {
    const r = match("s13-two-man-links-torrey-pines");
    expect(r.kind === "matched" && r.course.osmRef).toBe(REF.torreySouth);
    expect(r.kind === "matched" && r.facility).toBe(true);
    expect(r.kind === "matched" && r.aliasesToAdd).toContain("Torrey Pines North Course");
  });

  it("Bethpage State Park (Red Course) matches the state park facility", () => {
    const r = match("e13-scholarship-classic-bethpage-red");
    expect(r.kind === "matched" && r.course.osmRef).toBe(REF.bethpage);
  });

  it("Encanto 18 Golf Course matches Encanto Golf Course, not the 9-hole course (gc4)", () => {
    const r = match("s01-encanto-pejatc");
    expect(r.kind === "matched" && r.course.name).toBe("Encanto Golf Course");
  });

  it("Medinah Country Club (No. 3) matches Medinah Country Club", () => {
    const r = match("e11-acs-medinah");
    expect(r.kind === "matched" && r.course.osmRef).toBe(REF.medinah);
  });

  it("Ridgewood Country Club, Paramus NJ never matches Ridgewood in Connecticut", () => {
    const r = match("e05-valley-hospital-ridgewood");
    expect(r.kind === "matched" && r.course.osmRef).toBe(REF.ridgewoodNJ);
  });

  it("Riviera Country Club, Pacific Palisades never matches the Florida Riviera", () => {
    for (const id of ["s11-legends-on-the-links-riviera", "e16-pepperdine-riviera"]) {
      const r = match(id);
      expect(r.kind === "matched" && r.course.osmRef).toBe(REF.rivieraCA);
    }
  });

  it("an Oakmont Country Club in California with no city is ambiguous (no match)", () => {
    const r = matchCourse({ name: "Oakmont Country Club", state: "CA" }, ctx.courses, {});
    expect(r.kind).toBe("ambiguous");
  });

  it("matches every one of the 32 seed entries to a course", () => {
    const failures = seed.outings.flatMap((e) => (match(e.id).kind === "matched" ? [] : [e.id]));
    expect(failures).toEqual([]);
    expect(seed.outings).toHaveLength(32);
  });
});

describe("course types (SPEC 8.1 step 4)", () => {
  it("course-types.yaml gives every seed course its expected_course_type", () => {
    for (const e of seed.outings) {
      if (!e.expected_course_type) continue;
      const r = match(e.id);
      if (r.kind !== "matched") throw new Error(`${e.id} unmatched`);
      expect([e.id, r.course.courseType, r.course.courseTypeSource]).toEqual([e.id, e.expected_course_type, "override"]);
    }
  });

  it("the committed overrides equal what seed:course-types generates", async () => {
    const plain = await loadCourseContext({ now: NOW, withOverrides: false });
    const generated = seedCourseTypeOverrides(seed, plain.courses, plain.locator);
    const committed = new Map(ctx.overrides.map((o) => [o.osm_ref, o.course_type]));
    for (const g of generated) expect([g.osm_ref, committed.get(g.osm_ref ?? "")]).toEqual([g.osm_ref, g.course_type]);
  });
});
