/**
 * Golden-test harness (SPEC.md 11). Loads every fixture the golden cases need and
 * exposes helpers that run seed entries through the stage contracts:
 *
 *   seed/outings.json                       expected_* fields per entry
 *   tests/fixtures/pages/{id}.json          recorded normalized pages (Phase 0)
 *   tests/fixtures/pages/{id}.synthetic.json  hand-written stand-ins, preferred when present
 *   tests/fixtures/llm/{id}.json            recorded Message Batches results (Phase 2, owner-gated)
 *   tests/fixtures/courses.json             recorded Overpass subset
 *   tests/fixtures/irs-subset.csv           synthetic IRS BMF rows
 *
 * Nothing here touches the network or the clock: the context pins now to
 * 2026-09-28 (PIPELINE_NOW).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { z } from "zod";
import { resolveBudget } from "@gof/shared/budget";
import { dollarsToCents } from "@gof/shared/money";
import { llmRecordingSchema, type LlmRecording } from "../../src/llm/recording.ts";
import { memoryLogger } from "../../src/lib/logger.ts";
import { PATHS, REPO_ROOT } from "../../src/lib/paths.ts";
import { loadOverrides, type Overrides } from "../../src/overrides/load.ts";
import { parseCsv } from "../../src/places/csv.ts";
import { loadCourseContext } from "../../src/seed/context.ts";
import { readSeedFile, type SeedEntry, type SeedFile } from "../../src/seed/seed-file.ts";
import { courseRow } from "../../src/sql/tables.ts";
import { memoryIrsLookup } from "../../src/stages/irs-memory.ts";
import { isImplemented } from "../../src/stages/not-implemented.ts";
import { stageImplemented, type StageName } from "../../src/stages/registry.ts";
import { courseRowSchema, type CourseRow, type SourceKind } from "../../src/stages/rows.ts";
import {
  extractedEventSchema,
  irsRecordSchema,
  normalizedPageSchema,
  type Context,
  type ExtractedEvent,
  type FoundVia,
  type IrsLookup,
  type IrsRecord,
  type NormalizedPage,
  type PlaceCity,
} from "../../src/stages/types.ts";

export const FIXTURES = join(REPO_ROOT, "tests/fixtures");
export const PAGES_DIR = join(FIXTURES, "pages");
export const LLM_DIR = join(FIXTURES, "llm");
export const IRS_SUBSET = join(FIXTURES, "irs-subset.csv");

/** SPEC.md 11: fixtures pin now to 2026-09-28 (noon UTC, as PIPELINE_NOW=2026-09-28 resolves). */
export const GOLDEN_NOW = new Date("2026-09-28T12:00:00.000Z");

/** Golden cases in SPEC.md 11 order. */
export const GOLDEN_CASES = [
  "gc1-panther-national",
  "gc2-fordham",
  "gc3-builders-institute",
  "gc4-encanto",
  "gc5-grady",
  "gc6-two-man-links",
  "gc7-oakmont-glendale",
  "gc8-nkf-winged-foot",
] as const;
export type GoldenCase = (typeof GOLDEN_CASES)[number];

/** Messages the harness logs (synthetic fixture used, no recording, ...). */
export const harnessLog: string[] = [];
function note(line: string): void {
  harnessLog.push(line);
  console.info(`[golden] ${line}`);
}

// Seed --------------------------------------------------------------------------

let seedCache: SeedFile | null = null;
export async function loadSeed(): Promise<SeedFile> {
  seedCache ??= await readSeedFile(PATHS.seed);
  return seedCache;
}

export async function goldenEntry(gc: GoldenCase): Promise<SeedEntry> {
  const e = (await loadSeed()).outings.find((o) => o.golden_case === gc);
  if (!e) throw new Error(`seed has no entry for ${gc}`);
  return e;
}

/** Entries that run through extraction in golden tests: open, excluded and synthetic (SPEC.md 11). */
export async function extractableEntries(): Promise<SeedEntry[]> {
  return (await loadSeed()).outings.filter((o) => o.status !== "expected");
}

// Pages ------------------------------------------------------------------------

export const pageFixtureSchema = z
  .object({
    url: z.string().url().nullable(),
    fetched_at: z.string(),
    http_status: z.number().int().nullable(),
    text: z.string(),
    jsonld: z.array(z.unknown()),
    synthetic: z.literal(true).optional(),
    note: z.string().optional(),
  })
  .strict();
export type PageFixture = z.infer<typeof pageFixtureSchema>;

export interface LoadedPage {
  id: string;
  fixture: PageFixture;
  synthetic: boolean;
  path: string;
}

/** `{id}.synthetic.json` wins over `{id}.json` when both exist; the harness logs which it used. */
export async function loadPageFixture(id: string): Promise<LoadedPage> {
  const synthetic = join(PAGES_DIR, `${id}.synthetic.json`);
  const recorded = join(PAGES_DIR, `${id}.json`);
  const useSynthetic = existsSync(synthetic);
  const path = useSynthetic ? synthetic : recorded;
  if (!existsSync(path))
    throw new Error(`no page fixture for ${id} (see tests/fixtures/MISSING.md)`);
  const fixture = pageFixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (useSynthetic)
    note(`${id}: using synthetic fixture tests/fixtures/pages/${id}.synthetic.json`);
  return { id, fixture, synthetic: useSynthetic, path };
}

/** A stand-in URL for fixtures without one (s15): the reserved .invalid TLD. */
export function fixtureUrl(entry: SeedEntry, page?: PageFixture): string {
  return page?.url ?? entry.source_url ?? `https://fixtures.invalid/${entry.id}`;
}

function sourceKindOf(entry: SeedEntry): SourceKind {
  return entry.source_kind ?? "organizer";
}

function foundViaOf(kind: SourceKind): FoundVia {
  switch (kind) {
    case "directory":
      return "directory";
    case "association":
      return "association";
    case "platform":
      return "platform";
    default:
      return "search_place";
  }
}

/**
 * The page as the normalize stage would emit it: the recorded text and JSON-LD
 * plus the derived fields. `jsonld_events` stays empty here; normalize (B)
 * derives it, and goldens that need it run normalize first.
 */
export function toNormalizedPage(entry: SeedEntry, loaded: LoadedPage): NormalizedPage {
  const kind = sourceKindOf(entry);
  const url = fixtureUrl(entry, loaded.fixture);
  return normalizedPageSchema.parse({
    url,
    kind,
    found_via: foundViaOf(kind),
    fetched_at: GOLDEN_NOW.toISOString(),
    http_status: loaded.fixture.http_status,
    text: loaded.fixture.text.slice(0, 12_000),
    jsonld: loaded.fixture.jsonld,
    jsonld_events: [],
    hash: createHash("sha256").update(loaded.fixture.text.slice(0, 12_000)).digest("hex"),
    unchanged: false,
    needs_render: false,
    rendered: entry.render_required ?? false,
    recheck_outing_id: null,
    directory_host: kind === "directory" ? new URL(url).hostname : null,
  });
}

// LLM recordings ---------------------------------------------------------------

/** tests/fixtures/llm/{id}.json (src/llm/recording.ts): recorded, or hand-written with `recorded: false`. */
export { llmRecordingSchema, type LlmRecording };

export type RecordingLookup =
  | { status: "recorded"; recording: LlmRecording; path: string }
  | { status: "missing"; path: string; message: string };

export async function loadLlmRecording(id: string): Promise<RecordingLookup> {
  const path = join(LLM_DIR, `${id}.json`);
  if (!existsSync(path)) {
    const message = `no recording: tests/fixtures/llm/${id}.json (record with pnpm run test:live-extract after the owner approves)`;
    note(`${id}: ${message}`);
    return { status: "missing", path, message };
  }
  return {
    status: "recorded",
    recording: llmRecordingSchema.parse(JSON.parse(await readFile(path, "utf8"))),
    path,
  };
}

export function hasRecording(id: string): boolean {
  return existsSync(join(LLM_DIR, `${id}.json`));
}

// Courses and places -----------------------------------------------------------

export interface CourseFixtures {
  courses: CourseRow[];
  places: PlaceCity[];
}

let courseCache: CourseFixtures | null = null;
/** Courses from tests/fixtures/courses.json through the Phase 1 importer, with course-types.yaml. */
export async function loadCourses(): Promise<CourseFixtures> {
  if (!courseCache) {
    const ctx = await loadCourseContext({ now: GOLDEN_NOW.getTime() });
    courseCache = {
      courses: ctx.courses.map((c) => courseRowSchema.parse(courseRow(c))),
      places: ctx.cities.map((c) => ({ name: c.name, state: c.state, lat: c.lat, lng: c.lng })),
    };
  }
  return courseCache;
}

// IRS --------------------------------------------------------------------------

/** The 28 columns of the BMF extract, in order. */
export const BMF_COLUMNS = [
  "EIN",
  "NAME",
  "ICO",
  "STREET",
  "CITY",
  "STATE",
  "ZIP",
  "GROUP",
  "SUBSECTION",
  "AFFILIATION",
  "CLASSIFICATION",
  "RULING",
  "DEDUCTIBILITY",
  "FOUNDATION",
  "ACTIVITY",
  "ORGANIZATION",
  "STATUS",
  "TAX_PERIOD",
  "ASSET_CD",
  "INCOME_CD",
  "FILING_REQ_CD",
  "PF_FILING_REQ_CD",
  "ACCT_PD",
  "ASSET_AMT",
  "INCOME_AMT",
  "REVENUE_AMT",
  "NTEE_CD",
  "SORT_NAME",
] as const;

/** Parses BMF CSV text into IrsRecords (the columns the lookup keeps). */
export function parseBmfCsv(text: string): IrsRecord[] {
  const [header, ...rows] = parseCsv(text);
  if (!header || header.join(",") !== BMF_COLUMNS.join(","))
    throw new Error("not a BMF extract header");
  const col = (name: (typeof BMF_COLUMNS)[number]): number => BMF_COLUMNS.indexOf(name);
  return rows
    .filter((r) => r.length > 1)
    .map((r) =>
      irsRecordSchema.parse({
        ein: r[col("EIN")],
        name: r[col("NAME")],
        city: r[col("CITY")],
        state: r[col("STATE")],
        subsection: r[col("SUBSECTION")],
        sort_name: r[col("SORT_NAME")] || null,
      }),
    );
}

export async function loadIrsSubset(): Promise<IrsRecord[]> {
  return parseBmfCsv(await readFile(IRS_SUBSET, "utf8"));
}

export async function irsLookup(): Promise<IrsLookup> {
  return memoryIrsLookup(await loadIrsSubset());
}

// Context ----------------------------------------------------------------------

let overridesCache: Overrides | null = null;
export async function goldenContext(): Promise<Context & { log: ReturnType<typeof memoryLogger> }> {
  overridesCache ??= await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
  return {
    now: GOLDEN_NOW,
    caps: resolveBudget("nightly"),
    overrides: overridesCache,
    log: memoryLogger(),
    clock: { nowMs: () => 0 },
  };
}

// Seed facts as an extracted event ----------------------------------------------

/**
 * The event an ideal extraction of the entry's page would produce, from the
 * seed's own fields. `outing_type_hint` defaults to "other" so classify tests
 * prove the rule that fires (university, IRS 06, operator domain), not the hint.
 */
export function eventFromSeed(
  entry: SeedEntry,
  patch: Partial<ExtractedEvent> = {},
): ExtractedEvent {
  const kind = sourceKindOf(entry);
  const url = fixtureUrl(entry);
  const single = entry.single_price_usd ?? null;
  const foursome = entry.foursome_price_usd ?? null;
  const extra = entry as SeedEntry & {
    beneficiary?: string | null;
    expected_lodging_required?: boolean;
  };
  return extractedEventSchema.parse({
    is_outing: true,
    reject_reason: null,
    title: entry.title,
    organizer_name: entry.organizer_name ?? null,
    organizer_ein: null,
    beneficiary: extra.beneficiary ?? null,
    course_name: entry.course_name,
    venue_address: entry.course_address ?? null,
    venue_city: entry.course_city,
    venue_state: entry.course_state,
    start_date: entry.start_date ?? null,
    end_date: entry.end_date ?? null,
    shotgun_time: entry.shotgun_time ?? null,
    format: entry.format ?? null,
    single_price_usd: single,
    foursome_price_usd: foursome,
    sponsor_only: entry.sponsor_only ?? false,
    includes: [],
    handicap_required: null,
    status: "open",
    registration_url: entry.registration_url ?? null,
    outing_type_hint: "other",
    audience: entry.audience ?? "open",
    audience_note: entry.audience_note ?? null,
    lodging_required: extra.expected_lodging_required ?? false,
    summary: "",
    evidence: {
      date: entry.start_date ? "seed" : null,
      price: single !== null ? "seed" : null,
      venue: "seed",
    },
    source_url: url,
    source_kind: kind,
    event_index: 0,
    single_price_cents: single === null ? null : dollarsToCents(single),
    foursome_price_cents: foursome === null ? null : dollarsToCents(foursome),
    confidence: 1,
    jsonld_start_date: null,
    directory_host: kind === "directory" ? new URL(url).hostname : null,
    ...patch,
  });
}

// Gating -----------------------------------------------------------------------

export interface Gate {
  run: boolean;
  /** Why the test is a todo, e.g. "classify not implemented; no recording for s04-...". */
  reason: string;
}

/** Runs when every listed stage is implemented and, if given, the entry's LLM recording exists. */
export function gate(stages: readonly StageName[], recordingId?: string): Gate {
  const missing: string[] = stages
    .filter((s) => !stageImplemented(s))
    .map((s) => `${s} not implemented`);
  if (recordingId && !hasRecording(recordingId)) missing.push(`no recording for ${recordingId}`);
  return { run: missing.length === 0, reason: missing.join("; ") };
}

/** Same as `gate`, for a single pure function rather than a whole stage. */
export function gateFn(fn: unknown, label: string): Gate {
  return isImplemented(fn)
    ? { run: true, reason: "" }
    : { run: false, reason: `${label} not implemented` };
}

/** `test` when the gate is open, else `test.todo` with the reason in the title. */
export function goldenTest(name: string, g: Gate, fn: () => Promise<void> | void): void {
  if (g.run) test(name, fn);
  else test.todo(`${name} [todo: ${g.reason}]`);
}
