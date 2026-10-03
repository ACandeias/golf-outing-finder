/**
 * One-time recorder for tests/fixtures/courses.json (Phase 1). Free Overpass API
 * only. For each seed state it (1) locates the seed courses and decoys by name,
 * then (2) records every golf course inside a box around each one, so the fixture
 * holds the seed courses, their multi-course siblings, their neighbours and the
 * decoys, in the same per-state shape the live import gets.
 *
 * Usage: node --experimental-strip-types packages/pipeline/scripts/record-courses-fixture.ts [--states=NY,CA]
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bboxAround } from "@gof/shared/places";
import { SEED_STATES } from "@gof/shared/places";
import {
  OVERPASS_ENDPOINT,
  bboxQuery,
  fetchOverpass,
  nameQuery,
  toOsmFeatures,
  type OverpassElement,
} from "../src/courses/overpass.ts";
import {
  COURSES_FIXTURE_VERSION,
  readCoursesFixture,
  type CoursesFixture,
} from "../src/courses/fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = join(ROOT, "tests/fixtures/courses.json");
const SITE_URL = process.env.PUBLIC_SITE_URL ?? "http://localhost:8787";
const USER_AGENT = `GolfOutingFinderBot/1.0 (+${SITE_URL}/bot)`;
const BOX_KM = 4;
const PAUSE_MS = 12_000;

/**
 * Name patterns per state: every seed course (all 32 entries), plus decoys:
 * Oakmont CC in Glendale CA and Oakmont GC in Santa Rosa CA against Oakmont PA,
 * Riviera CC in Coral Gables FL against Riviera CA, and Ridgewood in CT against
 * Ridgewood NJ.
 */
const LOCATE: Readonly<Record<string, string>> = {
  NY: "Winged Foot|Bethpage|Metropolis|Maidstone|Deepdale|Piping Rock|Quaker Ridge",
  NJ: "Ridgewood|Baltusrol|Plainfield",
  CT: "Ridgewood",
  PA: "Philadelphia Country|Oakmont",
  CA: "Harding Park|Riviera Country|Torrey Pines|Oakmont",
  FL: "Rocky Point|Panther National|Bear.?s Club|Riviera Country",
  AZ: "Encanto|Arizona Biltmore|McCormick Ranch",
  MO: "Whitmoor",
  IL: "Medinah",
  GA: "Peachtree",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { states: { type: "string" }, merge: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const states = values.states ? values.states.split(",").map((s) => s.trim().toUpperCase()) : [...SEED_STATES];
  // --merge keeps the states already recorded and replaces only the ones named.
  const previous = values.merge && existsSync(OUT) ? (await readCoursesFixture(OUT)).states : {};
  const fixture: CoursesFixture = {
    version: COURSES_FIXTURE_VERSION,
    recorded_at: new Date().toISOString(),
    source: OVERPASS_ENDPOINT,
    attribution: "© OpenStreetMap contributors. Data available under the Open Database License (ODbL 1.0).",
    note: "Recorded by packages/pipeline/scripts/record-courses-fixture.ts: leisure=golf_course features in boxes around each seed course and decoy, grouped by state. Do not edit by hand.",
    states: { ...previous },
  };
  const client = { userAgent: USER_AGENT, endpoint: OVERPASS_ENDPOINT };
  let first = true;
  for (const state of states) {
    const pattern = LOCATE[state];
    if (!pattern) throw new Error(`no locate pattern for ${state}`);
    if (!first) await sleep(PAUSE_MS);
    first = false;
    console.log(`[${state}] locating ${pattern}`);
    const located = toOsmFeatures(await fetchOverpass(nameQuery(state, pattern), client), state);
    if (located.length === 0) throw new Error(`[${state}] nothing located`);
    for (const f of located) console.log(`  ${f.osmRef} ${f.tags.name ?? "(no name)"}`);
    const boxes = located.map((f) => bboxAround(f, BOX_KM));
    await sleep(PAUSE_MS);
    const query = bboxQuery(state, boxes);
    const res = await fetchOverpass(query, client);
    const elements: OverpassElement[] = [...res.elements].sort((a, b) =>
      a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1,
    );
    console.log(`[${state}] ${elements.length} features`);
    fixture.states[state] = { query, elements };
    // Written after every state so an interrupted run keeps what it recorded.
    const ordered = Object.fromEntries(
      Object.entries(fixture.states).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    await writeFile(OUT, JSON.stringify({ ...fixture, states: ordered }, null, 1) + "\n");
    console.log(`wrote ${OUT}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
