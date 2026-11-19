/**
 * `pnpm run top-course-outings --courses-db=<sqlite> --target=<json> --sql-out=<dir>
 *   [--entries=data/top-course-outings.json]`
 *
 * Turns the hand-researched outings at courses in data/top-courses.json into append-only SQL
 * for a database that already holds data (the Docker site's D1). Offline: no
 * network calls.
 *
 * --courses-db  a D1 SQLite file to read candidate courses from (read-only),
 *               e.g. a backup of the full OSM course import
 * --target      JSON snapshot of the database being loaded, from
 *               docker/load-top-course-outings.sh: { courses, organizers, outings }
 * --sql-out     where to write the SQL files
 *
 * The load itself (`wrangler d1 execute --file`) is done by the shell script.
 */
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { courseTypeSchema, type CourseType } from "@gof/shared/schemas";
import type { CourseRecord, CourseTypeSource } from "./courses/import.ts";
import { pipelineNow } from "./lib/clock.ts";
import { PATHS, fromInvocationDir } from "./lib/paths.ts";
import { writeSqlFiles } from "./lib/wrangler.ts";
import { readCourseTypeOverrides } from "./overrides/course-types.ts";
import { readRegistrationHosts, readRemovals } from "./overrides/files.ts";
import { readPlaces } from "./places/files.ts";
import { PlaceLocator } from "./places/locator.ts";
import { readSeedFile } from "./seed/seed-file.ts";
import { buildAppendPlan, targetSnapshotSchema, type TargetSnapshot } from "./topcourses/plan.ts";

const courseRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  aliases: z.string(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().length(2),
  zip: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  time_zone: z.string(),
  course_type: courseTypeSchema,
  course_type_source: z.enum(["override", "osm", "website_llm"]).nullable(),
  course_type_confidence: z.number().nullable(),
  notable: z.union([z.literal(0), z.literal(1)]),
  website: z.string().nullable(),
  osm_ref: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Courses in the given states from a D1 SQLite file, opened read-only. */
export function readPoolCourses(file: string, states: readonly string[]): CourseRecord[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const marks = states.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, slug, name, aliases, street, city, state, zip, lat, lng, time_zone, course_type,
                course_type_source, course_type_confidence, notable, website, osm_ref, created_at, updated_at
           FROM courses WHERE osm_ref IS NOT NULL AND state IN (${marks})`,
      )
      .all(...states);
    return rows.map((raw) => {
      const r = courseRowSchema.parse(raw);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        aliases: z.array(z.string()).parse(JSON.parse(r.aliases)),
        street: r.street,
        city: r.city,
        state: r.state,
        zip: r.zip,
        lat: r.lat,
        lng: r.lng,
        timeZone: r.time_zone,
        courseType: r.course_type,
        courseTypeSource: r.course_type_source as CourseTypeSource | null,
        courseTypeConfidence: r.course_type_confidence,
        notable: r.notable,
        website: r.website,
        osmRef: r.osm_ref,
        outingCount: 0,
        lastOutingDate: null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  } finally {
    db.close();
  }
}

export async function runTopCourseOutings(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      entries: { type: "string", default: "data/top-course-outings.json" },
      "courses-db": { type: "string" },
      target: { type: "string" },
      "sql-out": { type: "string" },
    },
    allowPositionals: true,
  });
  if (!values["courses-db"] || !values.target || !values["sql-out"]) {
    console.error("usage: top-course-outings --courses-db=<sqlite> --target=<json> --sql-out=<dir> [--entries=<json>]");
    return 2;
  }
  const now = pipelineNow();
  const seed = await readSeedFile(fromInvocationDir(values.entries));
  const target: TargetSnapshot = targetSnapshotSchema.parse(JSON.parse(await readFile(fromInvocationDir(values.target), "utf8")));
  const states = [...new Set(seed.outings.map((e) => e.course_state))];

  // course-types.yaml wins over whatever the courses database recorded.
  const overrides = await readCourseTypeOverrides(PATHS.courseTypes);
  const byOsm = new Map(overrides.filter((o) => o.osm_ref).map((o) => [o.osm_ref as string, o.course_type]));
  const byId = new Map(overrides.filter((o) => o.course_id).map((o) => [o.course_id as string, o.course_type]));
  const pool = readPoolCourses(fromInvocationDir(values["courses-db"]), states).map((c) => {
    const t: CourseType | undefined = byOsm.get(c.osmRef) ?? byId.get(c.id);
    return t ? { ...c, courseType: t, courseTypeSource: "override" as const, courseTypeConfidence: 1 } : c;
  });

  const { cities, zips } = await readPlaces(PATHS.places);
  const result = buildAppendPlan({
    seed,
    pool,
    target,
    locator: new PlaceLocator(cities, zips),
    now,
    registrationHosts: await readRegistrationHosts(PATHS.registrationHosts),
    removals: await readRemovals(PATHS.removals),
  });

  const files = await writeSqlFiles(result.statements, fromInvocationDir(values["sql-out"]), "top-course-outings");
  const published = result.plan.outings.filter((o) => o.published === 1).length;
  console.log(
    `top-course-outings: ${result.plan.outings.length} outings (${published} published), ` +
      `${result.plan.organizers.length} new organizers, ${result.newCourses.length} new courses, ` +
      `${result.skipped.length} skipped; ${files.length} SQL file(s) in ${values["sql-out"]}`,
  );
  for (const o of result.plan.outings) console.log(`  + ${o.slug}${o.published ? "" : ` (held: ${o.holdReason})`}`);
  for (const s of result.skipped) console.log(`  - ${s.seedId}: ${s.reason}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTopCourseOutings(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
