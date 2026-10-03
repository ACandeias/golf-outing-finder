/**
 * `pnpm run places:build [--all] [--states=NY,NJ] [--refresh]`
 *
 * Downloads GeoNames cities1000 and US postal codes (free, CC BY 4.0), keeps US
 * rows, and writes data/places/cities.csv.gz and zips.csv.gz for the ten seed
 * states (or every state with --all), plus metros.yaml from the 500 most populous
 * US cities. Downloads are cached in .cache/geonames/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SEED_STATES, US_STATES } from "@gof/shared/places";
import { downloadBuffer } from "../lib/download.ts";
import { PATHS } from "../lib/paths.ts";
import { writeMetros, writePlaces } from "./files.ts";
import { buildPlaces, parseCitiesTsv, parsePostalTsv, selectMetros } from "./geonames.ts";
import { readZipEntry } from "./zip.ts";

const CITIES_URL = "https://download.geonames.org/export/dump/cities1000.zip";
const POSTAL_URL = "https://download.geonames.org/export/zip/US.zip";
export const METRO_COUNT = 500;

async function cached(url: string, name: string, refresh: boolean, userAgent: string): Promise<Buffer> {
  const dir = join(PATHS.cache, "geonames");
  const file = join(dir, name);
  if (!refresh && existsSync(file)) return readFile(file);
  console.log(`downloading ${url}`);
  const buf = await downloadBuffer(url, { userAgent });
  await mkdir(dir, { recursive: true });
  await writeFile(file, buf);
  return buf;
}

export async function runPlacesBuild(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      all: { type: "boolean", default: false },
      states: { type: "string" },
      refresh: { type: "boolean", default: false },
      out: { type: "string" },
    },
    allowPositionals: true,
  });
  const states = values.all
    ? new Set(Object.keys(US_STATES))
    : new Set((values.states?.split(",") ?? [...SEED_STATES]).map((s) => s.trim().toUpperCase()));
  for (const s of states) if (!Object.hasOwn(US_STATES, s)) throw new Error(`unknown state ${s}`);
  const out = values.out ?? PATHS.places;
  const ua = `GolfOutingFinderBot/1.0 (+${process.env.PUBLIC_SITE_URL ?? "http://localhost:8787"}/bot)`;

  const citiesZip = await cached(CITIES_URL, "cities1000.zip", values.refresh, ua);
  const postalZip = await cached(POSTAL_URL, "US.zip", values.refresh, ua);
  const citiesText = readZipEntry(citiesZip, "cities1000.txt").toString("utf8");
  const postalText = readZipEntry(postalZip, "US.txt").toString("utf8");

  const allUs = parseCitiesTsv(citiesText, null);
  const geoCities = allUs.filter((c) => states.has(c.state));
  const postals = parsePostalTsv(postalText, states);
  const { cities, zips } = buildPlaces(geoCities, postals);
  await writePlaces(out, { cities, zips });
  const metros = selectMetros(allUs, METRO_COUNT);
  await writeMetros(out, metros);
  const linked = zips.filter((z) => z.cityId !== null).length;
  console.log(
    `places: ${cities.length} cities, ${zips.length} ZIPs (${linked} linked to a city) for ${states.size} states; ${metros.length} metros -> ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlacesBuild(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
