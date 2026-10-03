/**
 * `pnpm run places:load [--sql-out=<dir>] [--persist-to=<dir>]`: fills the
 * `cities` and `zips` tables of the local D1 from data/places (amendment A4).
 * `pnpm run seed` also does this as part of the full reload.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PATHS, fromInvocationDir } from "../lib/paths.ts";
import { executeLocalD1, writeSqlFiles } from "../lib/wrangler.ts";
import { placesStatements } from "../sql/tables.ts";
import { readPlaces } from "./files.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "sql-out": { type: "string" }, "persist-to": { type: "string" } },
    allowPositionals: true,
  });
  const { cities, zips } = await readPlaces(PATHS.places);
  const statements = placesStatements(cities, zips);
  const dir = values["sql-out"] ? fromInvocationDir(values["sql-out"]) : join(PATHS.cache, "places-sql");
  const files = await writeSqlFiles(statements, dir, "places");
  console.log(`${cities.length} cities, ${zips.length} ZIPs: ${statements.length} statements in ${files.length} file(s)`);
  if (!values["sql-out"]) {
    executeLocalD1(files, { persistTo: values["persist-to"] && fromInvocationDir(values["persist-to"]) });
    console.log("applied to the local D1 (gof)");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
