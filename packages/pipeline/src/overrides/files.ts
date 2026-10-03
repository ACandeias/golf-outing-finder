import { readFile } from "node:fs/promises";
import {
  OVERRIDE_FILES,
  parseHostsYaml,
  parseNotableCoursesYaml,
  parseRemovalsYaml,
  type NotableCourses,
  type Removals,
} from "./load.ts";

/** Single-file readers the Phase 1 loaders use; the schemas live in ./load.ts. */

export async function readRemovals(path: string): Promise<Removals> {
  return parseRemovalsYaml(await readFile(path, "utf8"));
}

export async function readRegistrationHosts(path: string): Promise<string[]> {
  return parseHostsYaml(await readFile(path, "utf8"), OVERRIDE_FILES.registrationHosts);
}

/** notable-courses.yaml: course names or osm_refs, no ranks. */
export async function readNotableCourses(path: string): Promise<NotableCourses> {
  return parseNotableCoursesYaml(await readFile(path, "utf8"));
}
