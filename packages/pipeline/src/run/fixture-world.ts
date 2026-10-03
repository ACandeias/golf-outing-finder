import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MemoryD1 } from "../d1/memory.ts";
import { normalizeUrl } from "../discovery/url.ts";
import { sourceIdForUrl } from "../extract/ids.ts";
import { fixturePageUrl, type FixtureDoc } from "../fetch/fixture-fetch.ts";
import { REPO_ROOT, PATHS } from "../lib/paths.ts";
import { FixtureBatchClient } from "../llm/fixture-batch-client.ts";
import { parseCsv } from "../places/csv.ts";
import { loadCourseContext } from "../seed/context.ts";
import { readSeedFile, type SeedEntry } from "../seed/seed-file.ts";
import { seedStatements } from "../sql/tables.ts";
import { irs as irsStage } from "../stages/irs.ts";
import { memoryIrsLookup } from "../stages/irs-memory.ts";
import type {
  Context,
  IrsLookup,
  ListingLink,
  ListingSource,
} from "../stages/types.ts";

/**
 * The offline world a `--dry-run` runs in (workstream E). Nothing here opens a
 * socket or spends money:
 *
 * - `loadFixtureWorld` fills an empty in-memory D1 with what the monthly job
 *   would have built: the GeoNames places for the seed states and the courses
 *   from tests/fixtures/courses.json through the Phase 1 importer (with
 *   course-types.yaml). No outings, organizers or sources, so every seed page
 *   is discovered, fetched and extracted as new.
 * - `seedListingSource` stands in for discovery's listing sources: one link per
 *   open, excluded or synthetic seed entry whose page the fixture fetcher can
 *   serve, with the entry's source kind.
 * - `fixtureExtractionClient` replays tests/fixtures/llm/{id}.json keyed by the
 *   request's custom_id (the source id, `sourceIdForUrl` of the fixture page's
 *   URL), falling back to the page URL.
 * - `fixtureIrsLookup` is an in-memory lookup over tests/fixtures/irs-subset.csv.
 */

export const FIXTURES_DIR = join(REPO_ROOT, "tests/fixtures");
export const FIXTURE_PAGES_DIR = join(FIXTURES_DIR, "pages");
export const FIXTURE_LLM_DIR = join(FIXTURES_DIR, "llm");
export const FIXTURE_IRS_CSV = join(FIXTURES_DIR, "irs-subset.csv");

const countRow = z.object({ n: z.number().int() });
const pageUrlSchema = z.object({ url: z.string().nullable() });

/**
 * Loads places and fixture courses into an in-memory D1 whose `courses` table
 * is empty; a D1 that already has courses is left alone. Returns the number of
 * courses loaded.
 */
export async function loadFixtureWorld(d1: MemoryD1, nowMs: number): Promise<number> {
  const [row] = (await d1.query("SELECT count(*) AS n FROM courses", countRow)) ?? [];
  if (row && row.n > 0) return 0;
  const ctx = await loadCourseContext({ now: nowMs });
  const statements = seedStatements(
    {
      courses: ctx.courses,
      organizers: [],
      outings: [],
      sources: [],
      sourceOutings: [],
      matches: [],
      skipped: [],
    },
    { cities: ctx.cities, zips: ctx.zips },
  );
  d1.db.exec(`BEGIN;\n${statements.join("\n")}\nCOMMIT;`);
  return ctx.courses.length;
}

/** Fixture page id to the URL it stands for (synthetic stand-ins win, as in the golden harness). */
export function fixturePageUrls(pagesDir = FIXTURE_PAGES_DIR): Map<string, string> {
  const out = new Map<string, string>();
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".json")).sort();
  const ordered = [
    ...files.filter((f) => !f.endsWith(".synthetic.json")),
    ...files.filter((f) => f.endsWith(".synthetic.json")),
  ];
  for (const f of ordered) {
    const id = f.replace(/\.synthetic\.json$|\.json$/, "");
    const page = pageUrlSchema.parse(JSON.parse(readFileSync(join(pagesDir, f), "utf8")));
    out.set(id, fixturePageUrl(id, page.url));
  }
  return out;
}

function foundViaFor(entry: SeedEntry): Pick<ListingLink, "found_via" | "kind"> {
  switch (entry.source_kind) {
    case "directory":
      return { found_via: "directory" };
    case "association":
      return { found_via: "association" };
    case "platform":
      return { found_via: "platform" };
    default:
      // Organizer pages have no listing of their own: list them like a series
      // page (daily, past the 7-day dedupe) and keep the organizer kind.
      return { found_via: "series", kind: entry.source_kind ?? "organizer" };
  }
}

/**
 * Discovery's stand-in for a dry run: a link per open, excluded or synthetic
 * seed entry (SPEC.md 11: expected entries never run through extraction) whose
 * page `docs` can serve.
 */
export async function seedListingSource(
  docs: ReadonlyMap<string, FixtureDoc>,
  pagesDir = FIXTURE_PAGES_DIR,
): Promise<ListingSource> {
  const seed = await readSeedFile(PATHS.seed);
  const urls = fixturePageUrls(pagesDir);
  const links: ListingLink[] = [];
  for (const entry of seed.outings) {
    if (entry.status === "expected") continue;
    const url = urls.get(entry.id);
    if (!url || !docs.has(url)) continue;
    links.push({
      ...foundViaFor(entry),
      origin: "seed-fixtures",
      url,
      title: entry.title,
      text: null,
      registration_url: null,
    });
  }
  return {
    async links() {
      return links;
    },
  };
}

/** Two listing sources as one: `first`'s links, then `second`'s. */
export function concatListings(first: ListingSource, second: ListingSource): ListingSource {
  return {
    async links(budget) {
      return [...(await first.links(budget)), ...(await second.links(budget))];
    },
  };
}

/**
 * custom_id (and page URL) to the fixture id whose LLM recording answers it. A
 * URL that two seed entries share (s01 and s09, the azgolf calendar) maps to
 * the entry that has a recording.
 */
export function llmFixtureIndex(
  pagesDir = FIXTURE_PAGES_DIR,
  llmDir = FIXTURE_LLM_DIR,
): { byCustomId: Map<string, string>; byUrl: Map<string, string> } {
  const byCustomId = new Map<string, string>();
  const byUrl = new Map<string, string>();
  for (const [id, url] of fixturePageUrls(pagesDir)) {
    if (!existsSync(join(llmDir, `${id}.json`))) continue;
    for (const u of new Set([url, normalizeUrl(url) ?? url])) {
      byUrl.set(u, id);
      byCustomId.set(sourceIdForUrl(u), id);
    }
  }
  return { byCustomId, byUrl };
}

/** The dry run's Message Batches client: recorded results, matched by custom_id. */
export function fixtureExtractionClient(
  pagesDir = FIXTURE_PAGES_DIR,
  llmDir = FIXTURE_LLM_DIR,
): FixtureBatchClient {
  const { byCustomId, byUrl } = llmFixtureIndex(pagesDir, llmDir);
  return new FixtureBatchClient({
    llmDir,
    resolve: (r) =>
      byCustomId.get(r.custom_id) ??
      byUrl.get(r.page_url) ??
      byUrl.get(normalizeUrl(r.page_url) ?? r.page_url) ??
      null,
  });
}

/** In-memory IRS lookup over the synthetic BMF subset (the dry run's stand-in for .cache/irs). */
export function fixtureIrsLookup(ctx: Context, csvPath = FIXTURE_IRS_CSV): IrsLookup {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  return memoryIrsLookup(irsStage(ctx, { rows }).output.records);
}
