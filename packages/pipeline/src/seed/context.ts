import tzLookup from "tz-lookup";
import { SEED_STATES } from "@gof/shared/places";
import { fixtureFeatures, readCoursesFixture } from "../courses/fixture.ts";
import { buildCourses, type CourseRecord, type ExistingCourse } from "../courses/import.ts";
import type { OsmFeature } from "../courses/overpass.ts";
import { readCourseTypeOverrides, type CourseTypeOverride } from "../overrides/course-types.ts";
import { readNotableCourses } from "../overrides/files.ts";
import { PATHS } from "../lib/paths.ts";
import { readPlaces } from "../places/files.ts";
import type { CityRow, ZipRow } from "../places/geonames.ts";
import { PlaceLocator } from "../places/locator.ts";

/** Time zone from lat/lng (tz-lookup), validated as an IANA zone. */
export function timeZoneAt(lat: number, lng: number): string {
  const tz = tzLookup(lat, lng);
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
  return tz;
}

export interface CourseContext {
  cities: CityRow[];
  zips: ZipRow[];
  locator: PlaceLocator;
  courses: CourseRecord[];
  overrides: CourseTypeOverride[];
}

/**
 * Places plus courses imported from the recorded Overpass fixture (or the given
 * features) for the seed states, with course-types.yaml applied unless
 * `withOverrides` is false.
 */
export async function loadCourseContext(opts: {
  now: number;
  states?: readonly string[];
  features?: readonly OsmFeature[];
  withOverrides?: boolean;
  existing?: readonly ExistingCourse[];
  fixturePath?: string;
}): Promise<CourseContext> {
  const { cities, zips } = await readPlaces(PATHS.places);
  const states = opts.states ?? [...SEED_STATES];
  const features = opts.features ?? fixtureFeatures(await readCoursesFixture(opts.fixturePath ?? PATHS.coursesFixture), states);
  const overrides = opts.withOverrides === false ? [] : await readCourseTypeOverrides(PATHS.courseTypes);
  const notable = await readNotableCourses(PATHS.notable);
  const { courses } = buildCourses(features, {
    now: opts.now,
    cities,
    overrides,
    notable,
    timeZoneAt,
    existing: opts.existing,
  });
  return { cities, zips, locator: new PlaceLocator(cities, zips), courses, overrides };
}
