import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file (packages/pipeline/src/lib). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const PATHS = {
  seed: join(REPO_ROOT, "seed/outings.json"),
  places: join(REPO_ROOT, "data/places"),
  overrides: join(REPO_ROOT, "data/overrides"),
  courseTypes: join(REPO_ROOT, "data/overrides/course-types.yaml"),
  removals: join(REPO_ROOT, "data/overrides/removals.yaml"),
  notable: join(REPO_ROOT, "data/overrides/notable-courses.yaml"),
  registrationHosts: join(REPO_ROOT, "data/overrides/registration-hosts.yaml"),
  coursesFixture: join(REPO_ROOT, "tests/fixtures/courses.json"),
  site: join(REPO_ROOT, "apps/site"),
  cache: join(REPO_ROOT, ".cache"),
} as const;

/** Resolves a CLI path against the directory the user ran pnpm from (INIT_CWD). */
export function fromInvocationDir(p: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), p);
}
