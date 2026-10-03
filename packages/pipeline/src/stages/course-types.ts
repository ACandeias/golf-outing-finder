import { notImplemented } from "./not-implemented.ts";
import type { CourseTypesCollectStage, CourseTypesRequestBuildStage } from "./types.ts";

/**
 * SPEC.md 8.1 step 4.3, workstream D (monthly). Batch requests that classify a
 * course from its homepage and an about or membership page (prompt in
 * prompts/course-type.md), within MAX_COURSE_CLASSIFICATIONS_PER_RUN, courses
 * with outings first; collect accepts confidence 0.7 or higher.
 */
export const courseTypesRequestBuild: CourseTypesRequestBuildStage = notImplemented("course-types");
export const courseTypesCollect: CourseTypesCollectStage = notImplemented("course-types");
