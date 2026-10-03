/**
 * `pnpm run courses:import --states=NY,NJ [--live] [--sql-out=<dir>] [--persist-to=<dir>] [--fresh]`
 *
 * Imports golf courses (SPEC.md 8.1 steps 1, 2 and 4) into the local D1. Without
 * --live it reads tests/fixtures/courses.json; with --live it queries the free
 * Overpass API one state at a time with backoff. Existing rows (by osm_ref) keep
 * their id, slug, aliases and outing counts; --fresh skips reading them.
 * Step 3 (website classification by LLM) is Phase 2: `buildCourses` accepts its
 * results through `websiteClassifications`.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SEED_STATES, isUsStateCode } from "@gof/shared/places";
import { pipelineNow } from "../lib/clock.ts";
import { PATHS, fromInvocationDir } from "../lib/paths.ts";
import { executeLocalD1, queryLocalD1, writeSqlFiles } from "../lib/wrangler.ts";
import { loadCourseContext } from "../seed/context.ts";
import { courseStatements } from "../sql/tables.ts";
import type { ExistingCourse } from "./import.ts";
import { fetchOverpass, stateQuery, toOsmFeatures, type OsmFeature } from "./overpass.ts";

async function liveFeatures(states: readonly string[]): Promise<OsmFeature[]> {
  const ua = `GolfOutingFinderBot/1.0 (+${process.env.PUBLIC_SITE_URL ?? "http://localhost:8787"}/bot)`;
  const out: OsmFeature[] = [];
  for (const [i, state] of states.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 10_000));
    console.log(`[${state}] querying Overpass`);
    const res = await fetchOverpass(stateQuery(state), { userAgent: ua });
    const feats = toOsmFeatures(res, state);
    console.log(`[${state}] ${feats.length} features`);
    out.push(...feats);
  }
  return out;
}

function existingFromD1(persistTo: string | undefined): ExistingCourse[] {
  try {
    return queryLocalD1("SELECT id, slug, osm_ref FROM courses", { persistTo }).map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      osmRef: typeof r.osm_ref === "string" ? r.osm_ref : null,
    }));
  } catch (err) {
    console.warn(`could not read existing courses from the local D1 (${String(err)}); treating as empty`);
    return [];
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      states: { type: "string" },
      live: { type: "boolean", default: false },
      "sql-out": { type: "string" },
      "persist-to": { type: "string" },
      fresh: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const states = (values.states?.split(",") ?? [...SEED_STATES]).map((s) => s.trim().toUpperCase());
  for (const s of states) if (!isUsStateCode(s)) throw new Error(`unknown state ${s}`);
  const existing = values.fresh || values["sql-out"] ? [] : existingFromD1(values["persist-to"] && fromInvocationDir(values["persist-to"]));
  const features = values.live ? await liveFeatures(states) : undefined;
  const ctx = await loadCourseContext({ now: pipelineNow(), states, features, existing });
  const counts = new Map<string, number>();
  for (const c of ctx.courses) counts.set(c.courseType, (counts.get(c.courseType) ?? 0) + 1);
  console.log(
    `${ctx.courses.length} courses in ${states.join(", ")}; types: ${[...counts].map(([t, n]) => `${t} ${n}`).join(", ")}`,
  );
  const statements = courseStatements(ctx.courses, "upsert");
  const dir = values["sql-out"] ? fromInvocationDir(values["sql-out"]) : join(PATHS.cache, "courses-sql");
  const files = await writeSqlFiles(statements, dir, "courses");
  console.log(`wrote ${statements.length} statements in ${files.length} file(s) to ${dir}`);
  if (!values["sql-out"]) {
    executeLocalD1(files, { persistTo: values["persist-to"] && fromInvocationDir(values["persist-to"]) });
    console.log("applied to the local D1 (gof)");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
