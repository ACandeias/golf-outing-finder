/**
 * `pnpm run seed [--include-test-entries] [--sql-out=<dir>] [--persist-to=<dir>]`
 *
 * Loads seed/outings.json into the local D1 (SPEC.md 13, Phase 1): cities and
 * ZIPs from data/places, courses for the ten seed states from the recorded
 * Overpass fixture with course-types.yaml applied, then organizers, outings,
 * sources and source_outings. Every entry must match a course (SPEC.md 8.6) or the
 * run fails listing the ones that don't. Writes literal SQL in D1-sized files and
 * runs them with `wrangler d1 execute gof --local --file`. With --sql-out it only
 * writes the files (the Docker image builds them this way).
 *
 * `--check` exits 0: the Docker entrypoint's contract for "the loader exists".
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pipelineNow } from "./lib/clock.ts";
import { PATHS, fromInvocationDir } from "./lib/paths.ts";
import { executeLocalD1, writeSqlFiles } from "./lib/wrangler.ts";
import { readRegistrationHosts, readRemovals } from "./overrides/files.ts";
import { loadCourseContext } from "./seed/context.ts";
import { buildSeedPlan, SeedMatchError, type SeedPlan } from "./seed/plan.ts";
import { readSeedFile } from "./seed/seed-file.ts";
import { seedStatements } from "./sql/tables.ts";

export const SEED_IMPLEMENTED = true;

export interface SeedBuild {
  plan: SeedPlan;
  statements: string[];
  counts: Record<string, number>;
}

/** Everything the seed writes, as statements. Used by the CLI and the tests. */
export async function buildSeed(opts: { now: number; includeTestEntries: boolean }): Promise<SeedBuild> {
  const ctx = await loadCourseContext({ now: opts.now });
  const seed = await readSeedFile(PATHS.seed);
  const plan = buildSeedPlan({
    seed,
    courses: ctx.courses,
    locator: ctx.locator,
    now: opts.now,
    includeTestEntries: opts.includeTestEntries,
    registrationHosts: await readRegistrationHosts(PATHS.registrationHosts),
    removals: await readRemovals(PATHS.removals),
  });
  const statements = seedStatements(plan, { cities: ctx.cities, zips: ctx.zips });
  return {
    plan,
    statements,
    counts: {
      cities: ctx.cities.length,
      zips: ctx.zips.length,
      courses: plan.courses.length,
      organizers: plan.organizers.length,
      outings: plan.outings.length,
      published: plan.outings.filter((o) => o.published === 1).length,
      held: plan.outings.filter((o) => o.holdReason !== null).length,
      sources: plan.sources.length,
      source_outings: plan.sourceOutings.length,
      skipped: plan.skipped.length,
    },
  };
}

export async function runSeed(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      check: { type: "boolean", default: false },
      "include-test-entries": { type: "boolean", default: false },
      "sql-out": { type: "string" },
      "persist-to": { type: "string" },
      local: { type: "boolean", default: true },
    },
    allowPositionals: true,
  });
  if (values.check) return 0;

  let build: SeedBuild;
  try {
    build = await buildSeed({ now: pipelineNow(), includeTestEntries: values["include-test-entries"] });
  } catch (err) {
    if (err instanceof SeedMatchError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  for (const m of build.plan.matches) {
    console.log(`  ${m.seedId.padEnd(40)} -> ${m.courseName}${m.facility ? " (facility)" : ""} [${m.score.toFixed(3)}]`);
  }
  if (build.plan.skipped.length > 0) {
    console.log(`skipped test entries (use --include-test-entries): ${build.plan.skipped.join(", ")}`);
  }

  const dir = values["sql-out"] ? fromInvocationDir(values["sql-out"]) : join(PATHS.cache, "seed-sql");
  const files = await writeSqlFiles(build.statements, dir, "seed");
  console.log(`wrote ${build.statements.length} statements in ${files.length} file(s) to ${dir}`);
  if (!values["sql-out"]) {
    executeLocalD1(files, { persistTo: values["persist-to"] && fromInvocationDir(values["persist-to"]) });
    console.log("applied to the local D1 (gof)");
  }
  console.log(JSON.stringify(build.counts));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
