import { readFile } from "node:fs/promises";
import { z } from "zod";
import { overpassElementSchema, toOsmFeatures, type OsmFeature } from "./overpass.ts";

/** tests/fixtures/courses.json: recorded Overpass responses grouped by state. */
export const COURSES_FIXTURE_VERSION = 1;

export const coursesFixtureSchema = z.object({
  version: z.literal(COURSES_FIXTURE_VERSION),
  recorded_at: z.string(),
  source: z.string().url(),
  attribution: z.string(),
  note: z.string(),
  states: z.record(
    z.string().regex(/^[A-Z]{2}$/),
    z.object({ query: z.string(), elements: z.array(overpassElementSchema) }),
  ),
});
export type CoursesFixture = z.infer<typeof coursesFixtureSchema>;

export async function readCoursesFixture(path: string): Promise<CoursesFixture> {
  return coursesFixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Features for the requested states; a state missing from the fixture is an error. */
export function fixtureFeatures(fixture: CoursesFixture, states: readonly string[]): OsmFeature[] {
  const out: OsmFeature[] = [];
  for (const state of states) {
    const entry = fixture.states[state];
    if (!entry) throw new Error(`courses fixture has no ${state}; record it with scripts/record-courses-fixture.ts`);
    out.push(...toOsmFeatures({ elements: entry.elements }, state));
  }
  return out;
}
