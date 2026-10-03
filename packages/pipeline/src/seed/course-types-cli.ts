/**
 * `pnpm run seed:course-types`: a one-time script (SPEC.md 13, Phase 1) that
 * matches each seed entry to a course from the recorded Overpass fixture and adds
 * its `expected_course_type` to data/overrides/course-types.yaml, keyed by
 * osm_ref. Entries already in the file are never replaced. The seed loader itself
 * never writes the file.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pipelineNow } from "../lib/clock.ts";
import { PATHS } from "../lib/paths.ts";
import { matchCourse } from "../match/match-course.ts";
import {
  mergeCourseTypeOverrides,
  readCourseTypeOverrides,
  renderCourseTypesYaml,
  type CourseTypeOverride,
} from "../overrides/course-types.ts";
import { loadCourseContext } from "./context.ts";
import { readSeedFile, type SeedFile } from "./seed-file.ts";
import type { CourseRecord } from "../courses/import.ts";
import type { PlaceLocator } from "../places/locator.ts";

/** Pure: seed entries with an expected_course_type -> override entries. Throws on conflicts. */
export function seedCourseTypeOverrides(
  seed: SeedFile,
  courses: readonly CourseRecord[],
  locator: PlaceLocator,
): CourseTypeOverride[] {
  const byRef = new Map<string, CourseTypeOverride & { seedIds: string[] }>();
  const problems: string[] = [];
  for (const e of seed.outings) {
    if (!e.expected_course_type) continue;
    const r = matchCourse({ name: e.course_name, state: e.course_state, city: e.course_city }, courses, {
      cityCentroid: locator.cityCentroid(e.course_state, e.course_city),
    });
    if (r.kind !== "matched") {
      problems.push(`${e.id}: "${e.course_name}" is ${r.kind}`);
      continue;
    }
    const ref = r.course.osmRef;
    const prev = byRef.get(ref);
    if (prev) {
      if (prev.course_type !== e.expected_course_type) {
        problems.push(`${e.id}: ${r.course.name} is ${e.expected_course_type} here but ${prev.course_type} in ${prev.seedIds.join(", ")}`);
      }
      prev.seedIds.push(e.id);
      continue;
    }
    byRef.set(ref, { osm_ref: ref, course_type: e.expected_course_type, reason: "", seedIds: [e.id] });
  }
  if (problems.length > 0) throw new Error(`seed:course-types found problems:\n  ${problems.join("\n  ")}`);
  return [...byRef.values()].map(({ seedIds, osm_ref, course_type }) => {
    const name = courses.find((c) => c.osmRef === osm_ref)?.name ?? osm_ref;
    return {
      osm_ref,
      course_type,
      reason: `${name}: expected_course_type of seed ${seedIds.join(", ")} (Phase 1 one-time import)`,
    };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, allowPositionals: true });
  const ctx = await loadCourseContext({ now: pipelineNow(), withOverrides: false });
  const seed = await readSeedFile(PATHS.seed);
  const generated = seedCourseTypeOverrides(seed, ctx.courses, ctx.locator);
  const existing = await readCourseTypeOverrides(PATHS.courseTypes);
  const { merged, kept } = mergeCourseTypeOverrides(existing, generated);
  for (const k of kept) console.log(`kept the existing entry for ${k}`);
  console.log(`${generated.length} seed entries, ${merged.length - existing.length} added`);
  if (values["dry-run"]) {
    console.log(renderCourseTypesYaml(merged));
    return;
  }
  await writeFile(PATHS.courseTypes, renderCourseTypesYaml(merged));
  console.log(`wrote ${PATHS.courseTypes}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
