/**
 * `pnpm run top-course-research <results.json> [more.json ...] [--entries=data/top-course-outings.json] [--today=YYYY-MM-DD]`
 *
 * Formats hand-research results (JSON arrays of researchItemSchema, one per
 * research batch) as seed entries and appends them to the entries file.
 * Rejected items are listed with the reason. Offline.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { PATHS, fromInvocationDir } from "./lib/paths.ts";
import { seedFileSchema } from "./seed/seed-file.ts";
import { convertResearch, researchItemSchema } from "./topcourses/research.ts";

export async function runTopCourseResearch(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      entries: { type: "string", default: "data/top-course-outings.json" },
      today: { type: "string", default: new Date().toISOString().slice(0, 10) },
    },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    console.error("usage: top-course-research <results.json> [...] [--entries=<json>] [--today=YYYY-MM-DD]");
    return 2;
  }
  const entriesPath = fromInvocationDir(values.entries);
  const file = seedFileSchema.parse(JSON.parse(await readFile(entriesPath, "utf8")));
  const items = [];
  for (const p of positionals) {
    items.push(...z.array(researchItemSchema).parse(JSON.parse(await readFile(fromInvocationDir(p), "utf8"))));
  }
  // Seed outings count as existing too, so research doesn't duplicate them.
  const seed = seedFileSchema.parse(JSON.parse(await readFile(PATHS.seed, "utf8")));
  const { entries, rejected } = convertResearch(items, {
    today: values.today,
    existing: [...file.outings, ...seed.outings.map((e) => ({ ...e, id: `seed-${e.id}` }))],
  });
  const next = seedFileSchema.parse({ ...file, outings: [...file.outings, ...entries] });
  await writeFile(entriesPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`top-course-research: ${items.length} items, ${entries.length} added, ${rejected.length} rejected`);
  for (const e of entries) console.log(`  + ${e.id}`);
  for (const r of rejected) console.log(`  - ${r.title} (${r.course}): ${r.reason}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTopCourseResearch(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
