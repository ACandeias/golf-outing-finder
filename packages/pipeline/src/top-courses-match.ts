/**
 * `pnpm run top-courses:match --courses-db=<sqlite> [--write]`
 *
 * Ties each data/top-courses.json entry to a `courses` row (osm_ref) and fills
 * an empty website from the course row. Offline: reads a D1 SQLite file (a
 * backup of the full OSM course import) read-only. Prints what matched, what
 * needs a person (review, ambiguous, unmatched, missing) and, with --write,
 * writes the filled-in osm_ref and website values back to the list. Review and
 * unmatched entries are left alone: pin them by hand with an osm_ref.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fromInvocationDir, PATHS } from "./lib/paths.ts";
import { readPlaces } from "./places/files.ts";
import { PlaceLocator } from "./places/locator.ts";
import { parseTopCoursesFile, resolveTopCourses, type PoolCourse } from "./topcourses/list.ts";

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.string(),
  state: z.string(),
  city: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  osm_ref: z.string().nullable(),
  website: z.string().nullable(),
});

function readPool(file: string): PoolCourse[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, name, aliases, state, city, lat, lng, osm_ref, website FROM courses")
      .all()
      .map((raw) => {
        const r = rowSchema.parse(raw);
        return { ...r, aliases: z.array(z.string()).parse(JSON.parse(r.aliases)) };
      });
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: { "courses-db": { type: "string" }, write: { type: "boolean", default: false } },
  });
  if (!values["courses-db"]) throw new Error("--courses-db=<D1 .sqlite file> is required");
  const list = parseTopCoursesFile(await readFile(PATHS.topCourses, "utf8"));
  const pool = readPool(fromInvocationDir(values["courses-db"]));
  const { cities, zips } = await readPlaces(PATHS.places);
  const locator = new PlaceLocator(cities, zips);
  const results = resolveTopCourses(list.courses, pool, (s, c) => locator.cityCentroid(s, c));

  const count: Record<string, number> = {};
  for (const r of results) count[r.kind] = (count[r.kind] ?? 0) + 1;
  console.log(JSON.stringify(count));
  for (const r of results) {
    if (r.kind === "matched" || r.kind === "pinned") continue;
    if (r.kind === "statewide") {
      console.log(`statewide ${r.entry.name} (${r.entry.city}, ${r.entry.state})  ->  ${r.course.name} [${r.course.city ?? "?"}] ${r.course.osm_ref ?? ""}`);
      continue;
    }
    const cands = r.candidates
      .slice(0, 3)
      .map((c) => `${c.course.name} [${c.course.city ?? "?"}] ${c.course.osm_ref ?? ""} ${c.score.toFixed(2)}`)
      .join(" | ");
    console.log(`${r.kind.padEnd(9)} ${r.entry.name} (${r.entry.city}, ${r.entry.state})${cands ? `  ->  ${cands}` : ""}`);
  }

  if (values.write) {
    const courses = results.map((r) => r.entry);
    await writeFile(PATHS.topCourses, `${JSON.stringify({ ...list, courses }, null, 2)}\n`);
    console.log(`wrote ${PATHS.topCourses}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
