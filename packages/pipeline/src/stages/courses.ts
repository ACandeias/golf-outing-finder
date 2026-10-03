import { notImplemented } from "./not-implemented.ts";
import type { CoursesStage } from "./types.ts";

/**
 * SPEC.md 8.1 steps 1 to 4, workstream D (monthly). Wraps
 * src/courses/import.ts#buildCourses over Overpass features and emits course
 * upserts by osm_ref.
 */
export const courses: CoursesStage = notImplemented("courses");
