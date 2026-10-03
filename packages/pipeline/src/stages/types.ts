import { z } from "zod";
import { BUDGET_CAPS, type Budget, type BudgetCap } from "@gof/shared/budget";
import { extractionEventSchema, holdReasonSchema, type HoldReason } from "@gof/shared/schemas";
import type { Overrides } from "../overrides/load.ts";
import {
  charityStatusSchema,
  courseRowSchema,
  orgTypeSchema,
  outingRowSchema,
  sourceKindSchema,
  sourceRowSchema,
  TABLE_NAMES,
  TABLE_OBJECT_SCHEMAS,
  TABLE_ROW_SCHEMAS,
  type CourseRow,
  type OutingRow,
  type RunRow,
  type SourceRow,
  type TableName,
  type TableRow,
} from "./rows.ts";

/**
 * Stage contracts for the nightly and monthly pipeline (SPEC.md 8.0 to 8.10).
 *
 * Every stage is a pure, synchronous function `(ctx, input) => { output, result }`.
 * Inputs and outputs are plain data with a zod schema; network, browser, LLM and
 * database I/O live in the edges (`Ports` below, `src/d1/`), which the runner
 * calls between stages. Stages never read the system clock (they use `ctx.now`),
 * never read env vars, and never import node:fs, node:net, undici, node:sqlite or
 * child_process (a test enforces this).
 */

// ---------------------------------------------------------------------------
// Context, built once at the edge
// ---------------------------------------------------------------------------

export type BudgetCaps = Readonly<Budget>;

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * Wall-clock time for durations only (MAX_FETCH_MINUTES, batch polling). Date
 * logic uses `Context.now`, which `PIPELINE_NOW` pins outside production.
 */
export interface Clock {
  nowMs(): number;
}

export interface Context {
  /** The run's logical "now" (SPEC.md 8.0). Course-local "today" derives from it. */
  readonly now: Date;
  readonly caps: BudgetCaps;
  readonly overrides: Overrides;
  readonly log: Logger;
  readonly clock: Clock;
}

// ---------------------------------------------------------------------------
// StageResult: what every stage reports, merged into the runs row
// ---------------------------------------------------------------------------

/** Counters stored as `runs` columns. */
export const RUN_COUNTERS = [
  "serp_queries",
  "fetches",
  "renders",
  "extractions",
  "course_classifications",
  "llm_input_tokens",
  "llm_output_tokens",
  "outings_new",
  "outings_updated",
  "outings_held",
] as const;
export type RunCounter = (typeof RUN_COUNTERS)[number];

/**
 * Counters reported in the run summary but not stored as columns.
 * `fetch_errors` (network failures and 5xx only, SPEC.md 8.3) drives the 20% rule.
 */
export const EXTRA_COUNTERS = [
  "fetch_errors",
  "fetch_not_found",
  "robots_blocked",
  "pages_unchanged",
  "urls_enqueued",
  "events_extracted",
  "events_excluded",
  "events_held",
  "indexnow_urls",
  "courses_imported",
  "irs_records",
] as const;
export type ExtraCounter = (typeof EXTRA_COUNTERS)[number];

export const COUNTERS = [...RUN_COUNTERS, ...EXTRA_COUNTERS] as const;
export type Counter = (typeof COUNTERS)[number];
export const counterSchema = z.enum(COUNTERS);
export type Counters = Partial<Record<Counter, number>>;
export const countersSchema = z.record(counterSchema, z.number().int().min(0));

export const budgetCapSchema = z.enum(BUDGET_CAPS);

export const budgetHitSchema = z.object({
  stage: z.string().min(1),
  cap: budgetCapSchema,
  limit: z.number().int().min(0),
  at: z.string(),
  detail: z.string().optional(),
});
export type BudgetHit = z.infer<typeof budgetHitSchema>;

export const stageErrorKindSchema = z.enum([
  "network",
  "http_5xx",
  "validation",
  "llm",
  "budget",
  "not_implemented",
  "forced",
  "internal",
]);
export type StageErrorKind = z.infer<typeof stageErrorKindSchema>;

export const stageErrorSchema = z.object({
  stage: z.string().min(1),
  kind: stageErrorKindSchema,
  message: z.string(),
  url: z.string().optional(),
});
export type StageError = z.infer<typeof stageErrorSchema>;

/** A held event or outing (SPEC.md 7.1 hold reasons). */
export const holdSchema = z.object({
  scope: z.enum(["source", "outing"]),
  /** Source URL for scope "source", outing id for scope "outing". */
  key: z.string().min(1),
  reason: holdReasonSchema,
  /** Index of the event within the page's extraction, for source holds. */
  event_index: z.number().int().min(0).optional(),
});
export type Hold = z.infer<typeof holdSchema>;

export const stageResultSchema = z.object({
  counters: countersSchema,
  budgetHits: z.array(budgetHitSchema),
  errors: z.array(stageErrorSchema),
  holds: z.array(holdSchema),
});
export type StageResult = z.infer<typeof stageResultSchema>;

export function emptyResult(): StageResult {
  return { counters: {}, budgetHits: [], errors: [], holds: [] };
}

export interface StageOutput<O> {
  output: O;
  result: StageResult;
}

/** The shape of every pure stage. */
export type Stage<I, O> = (ctx: Context, input: I) => StageOutput<O>;

/**
 * Remaining units of each per-run cap when the stage starts, computed by the
 * runner from the BudgetGuard. A stage that would exceed one stops, returns a
 * BudgetHit, and lets the remaining stages run (SPEC.md 8.0).
 */
export const allowanceSchema = z.record(budgetCapSchema, z.number().int().min(0));
export type Allowance = Partial<Record<BudgetCap, number>>;

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "http or https URL");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// 8.2 Discover
// ---------------------------------------------------------------------------

export const foundViaSchema = z.enum([
  "recheck",
  "submission",
  "series",
  "platform",
  "association",
  "directory",
  "search_place",
  "search_course",
  "held_retry",
]);
export type FoundVia = z.infer<typeof foundViaSchema>;

/** One URL to fetch. `bypass_dedupe` is true for series pages and rechecks. */
export const queueEntrySchema = z.object({
  url: httpUrl,
  found_via: foundViaSchema,
  kind: sourceKindSchema,
  priority: z.number().int(),
  bypass_dedupe: z.boolean(),
  /** The outing a recheck refreshes. */
  recheck_outing_id: z.string().nullable(),
  /** Directory event pages remember the directory host (SPEC.md 8.2 item 6). */
  directory_host: z.string().nullable(),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

export const recheckCandidateSchema = z.object({
  outing_id: z.string(),
  url: httpUrl,
  status: z.enum(["open", "waitlist"]),
  start_date: isoDate,
  last_verified: isoTimestamp,
  time_zone: z.string(),
});
export type RecheckCandidate = z.infer<typeof recheckCandidateSchema>;

export const serpQuerySchema = z.object({
  kind: z.enum(["place", "course"]),
  q: z.string().min(1),
  /** Metro "City, ST" or course id the query was built from. */
  subject: z.string(),
});
export type SerpQuery = z.infer<typeof serpQuerySchema>;

export const serpResultSchema = z.object({
  query: serpQuerySchema,
  rank: z.number().int().min(1),
  url: httpUrl,
  title: z.string(),
  snippet: z.string(),
});
export type SerpResult = z.infer<typeof serpResultSchema>;

/** A link found on a series index, platform listing, association calendar or directory. */
export const listingLinkSchema = z.object({
  found_via: z.enum(["series", "platform", "association", "directory"]),
  /** Series id, platform name, association name or directory host. */
  origin: z.string(),
  url: httpUrl,
  title: z.string().nullable(),
  text: z.string().nullable(),
  /** Directory event pages: the off-directory registration link, when shown. */
  registration_url: httpUrl.nullable(),
});
export type ListingLink = z.infer<typeof listingLinkSchema>;

export const searchPlanInputSchema = z.object({
  metros: z.array(z.object({ name: z.string(), state: z.string(), population: z.number() })),
  courses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      outing_count: z.number().int(),
      notable: z.boolean(),
    }),
  ),
  allowance: allowanceSchema,
});
export type SearchPlanInput = z.infer<typeof searchPlanInputSchema>;
export const searchPlanOutputSchema = z.object({ queries: z.array(serpQuerySchema) });
export type SearchPlanOutput = z.infer<typeof searchPlanOutputSchema>;

export const discoverInputSchema = z.object({
  recheck: z.array(recheckCandidateSchema),
  submissions: z.array(z.object({ id: z.string(), url: z.string(), created_at: isoTimestamp })),
  listings: z.array(listingLinkSchema),
  serpResults: z.array(serpResultSchema),
  /** Sources fetched in the last 7 days (the discovery dedupe window). */
  recentlyFetched: z.array(z.object({ url: httpUrl, fetched_at: isoTimestamp })),
  /** Held sources whose `held_until` is still ahead: retried to find a second source. */
  heldSources: z.array(z.object({ url: httpUrl, held_until: isoDate })),
  allowance: allowanceSchema,
});
export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export const discoverOutputSchema = z.object({
  queue: z.array(queueEntrySchema),
  skipped: z.array(
    z.object({
      url: z.string(),
      reason: z.enum(["excluded", "recent", "duplicate", "invalid", "not_golf"]),
    }),
  ),
  /** Submissions consumed by this run, to mark processed. */
  processedSubmissionIds: z.array(z.string()),
});
export type DiscoverOutput = z.infer<typeof discoverOutputSchema>;

// ---------------------------------------------------------------------------
// 8.3 Fetch (plan) and the FetchedPage the fetcher edge returns
// ---------------------------------------------------------------------------

export const fetchPlanItemSchema = queueEntrySchema.extend({
  /** Render with Playwright up front (host in js-platforms.yaml). */
  render: z.boolean(),
  host: z.string(),
});
export type FetchPlanItem = z.infer<typeof fetchPlanItemSchema>;

export const fetchPlanInputSchema = z.object({
  queue: z.array(queueEntrySchema),
  allowance: allowanceSchema,
});
export type FetchPlanInput = z.infer<typeof fetchPlanInputSchema>;

export const fetchPlanOutputSchema = z.object({
  items: z.array(fetchPlanItemSchema),
  /** Left for a later run (caps, recheck share above 40%, per-host cap). */
  deferred: z.array(queueEntrySchema),
});
export type FetchPlanOutput = z.infer<typeof fetchPlanOutputSchema>;

/**
 * Network failures and 5xx count toward the 20% rule; not_found, gone and
 * robots_blocked are expected outcomes (SPEC.md 8.3).
 */
export const fetchOutcomeSchema = z.enum([
  "ok",
  "not_modified",
  "not_found",
  "gone",
  "robots_blocked",
  "ssrf_blocked",
  "too_large",
  "unsupported_type",
  "network_error",
  "timeout",
  "server_error",
  "client_error",
]);
export type FetchOutcome = z.infer<typeof fetchOutcomeSchema>;

export const COUNTS_AS_FETCH_ERROR: ReadonlySet<FetchOutcome> = new Set([
  "network_error",
  "timeout",
  "server_error",
]);

export const fetchedPageSchema = z.object({
  requested_url: httpUrl,
  /** After redirects. */
  url: httpUrl,
  kind: sourceKindSchema,
  found_via: foundViaSchema,
  fetched_at: isoTimestamp,
  http_status: z.number().int().min(100).max(599).nullable(),
  outcome: fetchOutcomeSchema,
  content_type: z.string().nullable(),
  /** Raw HTML (capped at 5 MB by the fetcher), or null for PDFs and failures. */
  html: z.string().nullable(),
  /** Text from pdfjs-dist for PDFs of 2 MB or less. */
  pdf_text: z.string().nullable(),
  rendered: z.boolean(),
  error: z.string().nullable(),
  recheck_outing_id: z.string().nullable(),
  directory_host: z.string().nullable(),
});
export type FetchedPage = z.infer<typeof fetchedPageSchema>;

// ---------------------------------------------------------------------------
// 8.3 Normalize
// ---------------------------------------------------------------------------

/** Name, start date and location from a schema.org Event block (SPEC.md 8.4). */
export const jsonLdEventSchema = z.object({
  name: z.string().nullable(),
  start_date: isoDate.nullable(),
  start_time: z.string().nullable(),
  location_name: z.string().nullable(),
  location_address: z.string().nullable(),
});
export type JsonLdEvent = z.infer<typeof jsonLdEventSchema>;

export const NORMALIZED_TEXT_MAX = 12_000;
export const RENDER_TEXT_MIN = 400;

/**
 * A page ready for extraction. The recorded fixtures in tests/fixtures/pages are
 * this shape minus the derived fields; the golden harness adds them.
 */
export const normalizedPageSchema = z.object({
  url: httpUrl,
  kind: sourceKindSchema,
  found_via: foundViaSchema,
  fetched_at: isoTimestamp,
  http_status: z.number().int().nullable(),
  /** Readability main text, at most 12,000 characters. */
  text: z.string().max(NORMALIZED_TEXT_MAX),
  /** Every schema.org JSON-LD block, as parsed JSON. */
  jsonld: z.array(z.unknown()),
  jsonld_events: z.array(jsonLdEventSchema),
  /** sha256 hex of `text`. */
  hash: sha256,
  /** Hash equals the source's last `content_hash`: skip extraction, touch last_verified. */
  unchanged: z.boolean(),
  /** Text under 400 characters from a plain fetch: render and normalize again. */
  needs_render: z.boolean(),
  rendered: z.boolean(),
  recheck_outing_id: z.string().nullable(),
  directory_host: z.string().nullable(),
});
export type NormalizedPage = z.infer<typeof normalizedPageSchema>;

export const normalizeInputSchema = z.object({
  pages: z.array(fetchedPageSchema),
  /** Last `sources.content_hash` by URL. */
  previousHashes: z.record(z.string(), sha256),
});
export type NormalizeInput = z.infer<typeof normalizeInputSchema>;

export const normalizeOutputSchema = z.object({
  pages: z.array(normalizedPageSchema),
  /** Pages that failed or were not HTML/PDF; carried to the source updates. */
  failed: z.array(fetchedPageSchema),
});
export type NormalizeOutput = z.infer<typeof normalizeOutputSchema>;

// ---------------------------------------------------------------------------
// 8.4 Extract: request build, (edge: batch submit and poll), collect
// ---------------------------------------------------------------------------

/** Message Batches custom_id rules: 1 to 64 of [a-zA-Z0-9_-]. */
export const customIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const extractionRequestSchema = z.object({
  custom_id: customIdSchema,
  page_url: httpUrl,
  /** Estimated input tokens, checked against MAX_LLM_INPUT_TOKENS_PER_RUN. */
  est_input_tokens: z.number().int().min(0),
  /** The Messages API params (model, max_tokens, temperature, system, messages, output format). */
  params: z.record(z.string(), z.unknown()),
});
export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;

/** What collect needs about each request besides the model's answer. */
export const extractionRequestMetaSchema = z.object({
  custom_id: customIdSchema,
  page_url: httpUrl,
  kind: sourceKindSchema,
  hash: sha256,
  jsonld_events: z.array(jsonLdEventSchema),
  directory_host: z.string().nullable(),
});
export type ExtractionRequestMeta = z.infer<typeof extractionRequestMetaSchema>;

export const extractRequestBuildInputSchema = z.object({
  pages: z.array(normalizedPageSchema),
  allowance: allowanceSchema,
});
export type ExtractRequestBuildInput = z.infer<typeof extractRequestBuildInputSchema>;

export const extractRequestBuildOutputSchema = z.object({
  requests: z.array(extractionRequestSchema),
  meta: z.array(extractionRequestMetaSchema),
  /** Pages not sent because a cap was reached; they stay queued. */
  deferred: z.array(httpUrl),
});
export type ExtractRequestBuildOutput = z.infer<typeof extractRequestBuildOutputSchema>;

/** One line of a Message Batches results file. */
export const batchResultSchema = z.object({
  custom_id: customIdSchema,
  result: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("succeeded"),
      message: z
        .object({
          content: z.array(
            z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
          ),
          stop_reason: z.string().nullable(),
          usage: z
            .object({ input_tokens: z.number().int(), output_tokens: z.number().int() })
            .passthrough(),
        })
        .passthrough(),
    }),
    z.object({ type: z.literal("errored"), error: z.unknown() }),
    z.object({ type: z.literal("canceled") }),
    z.object({ type: z.literal("expired") }),
  ]),
});
export type BatchResult = z.infer<typeof batchResultSchema>;

/**
 * One validated event (shared extraction schema) plus what collect derives:
 * prices in cents, the kept registration URL, confidence, and provenance.
 */
export const extractedEventSchema = extractionEventSchema.extend({
  source_url: httpUrl,
  source_kind: sourceKindSchema,
  event_index: z.number().int().min(0).max(24),
  single_price_cents: z.number().int().min(0).max(2_500_000).nullable(),
  foursome_price_cents: z.number().int().min(0).max(2_500_000).nullable(),
  /** After the A5 allowlist; null means "See site". */
  registration_url: httpUrl.nullable(),
  confidence: z.number().min(0).max(1),
  jsonld_start_date: isoDate.nullable(),
  directory_host: z.string().nullable(),
});
export type ExtractedEvent = z.infer<typeof extractedEventSchema>;

export const extractedPageSchema = z.object({
  url: httpUrl,
  hash: sha256,
  extractor_version: z.string(),
  /** The raw `{ events }` JSON as returned, for `sources.extracted_json`. */
  extracted_json: z.string(),
  events: z.array(extractedEventSchema).max(25),
  /** Events that failed zod post-validation, with the reason. */
  rejected: z.array(z.object({ event_index: z.number().int(), reason: z.string() })),
});
export type ExtractedPage = z.infer<typeof extractedPageSchema>;

export const extractCollectInputSchema = z.object({
  results: z.array(batchResultSchema),
  meta: z.array(extractionRequestMetaSchema),
});
export type ExtractCollectInput = z.infer<typeof extractCollectInputSchema>;

export const extractCollectOutputSchema = z.object({
  pages: z.array(extractedPageSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  /** custom_ids that errored or expired; their pages stay queued. */
  failed: z.array(customIdSchema),
});
export type ExtractCollectOutput = z.infer<typeof extractCollectOutputSchema>;

// ---------------------------------------------------------------------------
// 8.5 Classify
// ---------------------------------------------------------------------------

/** One IRS Business Master File record (the columns the lookup keeps). */
export const irsRecordSchema = z.object({
  ein: z.string().regex(/^\d{9}$/),
  name: z.string().min(1),
  city: z.string(),
  state: z.string().regex(/^[A-Z]{2}$/),
  subsection: z.string().regex(/^\d{2}$/),
  /** BMF SORT_NAME: a secondary name (a DBA such as "BCNY"), or null. */
  sort_name: z.string().nullable(),
});
export type IrsRecord = z.infer<typeof irsRecordSchema>;

export const classifiedOutingSchema = extractedEventSchema.extend({
  excluded: z.boolean(),
  exclude_reason: z
    .enum([
      "not_outing",
      "not_golf",
      "past",
      "members_only",
      "resort_package",
      "qualifier",
      "no_date",
      "other",
      "lodging_required",
    ])
    .nullable(),
  outing_type: z.enum([
    "charity",
    "school_fundraiser",
    "business_association",
    "access_day",
    "open_tournament",
    "pro_am",
    "other",
  ]),
  org_type: orgTypeSchema,
  charity_status: charityStatusSchema,
  irs: irsRecordSchema.nullable(),
  irs_match: z.enum(["ein", "state_name", "national_name", "none"]),
  /** Registrable domain of the canonical source URL. */
  organizer_domain: z.string(),
});
export type ClassifiedOuting = z.infer<typeof classifiedOutingSchema>;

export const classifyInputSchema = z.object({ events: z.array(extractedEventSchema) });
export type ClassifyInput = z.infer<typeof classifyInputSchema> & {
  /** Read-only IRS lookup (in-memory in tests, node:sqlite in runs). */
  irs: IrsLookup;
};
export const classifyOutputSchema = z.object({ outings: z.array(classifiedOutingSchema) });
export type ClassifyOutput = z.infer<typeof classifyOutputSchema>;

/**
 * Read-only IRS lookup. Deterministic and side-effect free, so passing it into a
 * stage keeps the stage pure. `candidates` returns records whose names share a
 * token with `name` (state-limited when `state` is set); the stage scores them.
 */
export interface IrsLookup {
  byEin(ein: string): IrsRecord | null;
  candidates(name: string, state: string | null, limit: number): IrsRecord[];
}

// ---------------------------------------------------------------------------
// 8.6 Match
// ---------------------------------------------------------------------------

export const placeCitySchema = z.object({
  name: z.string(),
  state: z.string(),
  lat: z.number(),
  lng: z.number(),
});
export type PlaceCity = z.infer<typeof placeCitySchema>;

export const matchInputSchema = z.object({
  outings: z.array(classifiedOutingSchema),
  courses: z.array(courseRowSchema),
  /** City centroids (cities table plus ZIP place names) for the 25 km rule. */
  places: z.array(placeCitySchema),
});
export type MatchInput = z.infer<typeof matchInputSchema>;

export const courseMatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("matched"),
    course_id: z.string(),
    course_name: z.string(),
    time_zone: z.string(),
    score: z.number(),
    facility: z.boolean(),
    aliases_to_add: z.array(z.string()),
  }),
  z.object({ kind: z.literal("unmatched"), candidates: z.array(z.string()) }),
  z.object({ kind: z.literal("ambiguous"), candidates: z.array(z.string()) }),
]);
export type CourseMatch = z.infer<typeof courseMatchSchema>;

export const matchedOutingSchema = classifiedOutingSchema.extend({ match: courseMatchSchema });
export type MatchedOuting = z.infer<typeof matchedOutingSchema>;

export const matchOutputSchema = z.object({ outings: z.array(matchedOutingSchema) });
export type MatchOutput = z.infer<typeof matchOutputSchema>;

// ---------------------------------------------------------------------------
// UpsertPlan: every database write a stage wants, applied by src/d1
// ---------------------------------------------------------------------------

type Columns<T extends TableName> = keyof TableRow<T> & string;

export interface UpsertOp<T extends TableName = TableName> {
  op: "upsert";
  table: T;
  rows: TableRow<T>[];
  /** Conflict target; defaults to the primary key. */
  conflict?: Columns<T>[];
  /** Columns overwritten on conflict; empty means DO NOTHING. Defaults to every non-key column. */
  update?: Columns<T>[];
}

export interface UpdateOp<T extends TableName = TableName> {
  op: "update";
  table: T;
  set: Partial<TableRow<T>>;
  /** Equality on every listed column (AND). Must not be empty. */
  where: Partial<TableRow<T>>;
}

export interface DeleteOp<T extends TableName = TableName> {
  op: "delete";
  table: T;
  where: Partial<TableRow<T>>;
}

export type TableOp = { [T in TableName]: UpsertOp<T> | UpdateOp<T> | DeleteOp<T> }[TableName];

export interface UpsertPlan {
  /** Applied in order, so parents come before children. */
  ops: TableOp[];
}

function opSchemaFor(table: TableName) {
  const object: z.AnyZodObject = TABLE_OBJECT_SCHEMAS[table];
  const rows: z.ZodTypeAny = TABLE_ROW_SCHEMAS[table];
  const columns = Object.keys(object.shape) as [string, ...string[]];
  const col = z.enum(columns);
  const partial = object.partial().strict();
  return z.discriminatedUnion("op", [
    z.object({
      op: z.literal("upsert"),
      table: z.literal(table),
      rows: z.array(rows),
      conflict: z.array(col).min(1).optional(),
      update: z.array(col).optional(),
    }),
    z.object({
      op: z.literal("update"),
      table: z.literal(table),
      set: partial.refine((s) => Object.keys(s).length > 0, "set must not be empty"),
      where: partial.refine((w) => Object.keys(w).length > 0, "where must not be empty"),
    }),
    z.object({
      op: z.literal("delete"),
      table: z.literal(table),
      where: partial.refine((w) => Object.keys(w).length > 0, "where must not be empty"),
    }),
  ]);
}

const [op0, op1, ...opRest] = TABLE_NAMES.map((t) => opSchemaFor(t));
export const tableOpSchema = z.union([op0!, op1!, ...opRest]);
export const upsertPlanSchema = z.object({ ops: z.array(tableOpSchema) });

export function emptyPlan(): UpsertPlan {
  return { ops: [] };
}

/** Validates a plan against the table schemas (throws a ZodError naming the bad op). */
export function parseUpsertPlan(plan: unknown): UpsertPlan {
  upsertPlanSchema.parse(plan);
  return plan as UpsertPlan;
}

// ---------------------------------------------------------------------------
// 8.7 Dedupe and upsert
// ---------------------------------------------------------------------------

export const existingOrganizerSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  ein: z.string().nullable(),
  charity_status: charityStatusSchema,
});
export type ExistingOrganizer = z.infer<typeof existingOrganizerSchema>;

export const dedupeUpsertInputSchema = z.object({
  outings: z.array(matchedOutingSchema),
  existing: z.object({
    outings: z.array(outingRowSchema),
    organizers: z.array(existingOrganizerSchema),
    sources: z.array(sourceRowSchema),
    /** Slugs already taken (outings, organizers), for `-2`, `-3` suffixes. */
    outingSlugs: z.array(z.string()),
    organizerSlugs: z.array(z.string()),
  }),
  /** Pages whose hash was unchanged: only `last_verified` moves (SPEC.md 8.3). */
  unchanged: z.array(z.object({ url: httpUrl, recheck_outing_id: z.string().nullable() })),
  /** Fetch outcomes per source URL, for `sources` bookkeeping (status, consecutive_gone, error). */
  fetches: z.array(
    z.object({
      url: httpUrl,
      kind: sourceKindSchema,
      http_status: z.number().int().nullable(),
      outcome: fetchOutcomeSchema,
      hash: sha256.nullable(),
      extracted_json: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type DedupeUpsertInput = z.infer<typeof dedupeUpsertInputSchema>;

export const upsertOutcomeSchema = z.object({
  source_url: httpUrl,
  event_index: z.number().int(),
  action: z.enum(["insert", "update", "merge", "confirm_expected", "held", "excluded"]),
  outing_id: z.string().nullable(),
  hold_reason: holdReasonSchema.nullable(),
});
export type UpsertOutcome = z.infer<typeof upsertOutcomeSchema>;

export interface DedupeUpsertOutput {
  plan: UpsertPlan;
  outcomes: UpsertOutcome[];
}

// ---------------------------------------------------------------------------
// 8.8 Publish
// ---------------------------------------------------------------------------

export const publishDecisionSchema = z.object({
  outing_id: z.string(),
  publish: z.boolean(),
  hold_reason: holdReasonSchema.nullable(),
  /** Why, for the run log: "removed", "past", "low_confidence", "second_source", ... */
  why: z.string(),
  /** Event JSON-LD only when status is open, waitlist, sold_out or cancelled. */
  event_markup: z.boolean(),
  /** Ping IndexNow (published, or materially changed). */
  indexnow: z.boolean(),
});
export type PublishDecision = z.infer<typeof publishDecisionSchema>;

export const publishInputSchema = z.object({
  /** Outings after this run's upserts, with their course's time zone. */
  outings: z.array(
    z.object({ outing: outingRowSchema, time_zone: z.string(), source_urls: z.array(httpUrl) }),
  ),
  /** Held sources, for the second-independent-source rule. */
  heldSources: z.array(sourceRowSchema),
  /** Outing ids whose content changed in this run (IndexNow). */
  changed: z.array(z.string()),
});
export type PublishInput = z.infer<typeof publishInputSchema>;

export interface PublishOutput {
  decisions: PublishDecision[];
  plan: UpsertPlan;
  indexnowUrls: string[];
}

// ---------------------------------------------------------------------------
// 8.9 Recheck and roll forward
// ---------------------------------------------------------------------------

export const recheckRollForwardInputSchema = z.object({
  outings: z.array(
    z.object({ outing: outingRowSchema, time_zone: z.string(), source_urls: z.array(httpUrl) }),
  ),
  sources: z.array(sourceRowSchema),
  /** Slugs already taken, for new expected rows. */
  outingSlugs: z.array(z.string()),
});
export type RecheckRollForwardInput = z.infer<typeof recheckRollForwardInputSchema>;

export interface RecheckRollForwardOutput {
  plan: UpsertPlan;
  /** Outing ids set to past, rolled forward, bumped or staled. */
  past: string[];
  rolledForward: { from: string; to: string }[];
  expectedBumped: string[];
  expectedStale: string[];
  sourceGone: string[];
}

// ---------------------------------------------------------------------------
// 8.10 Report
// ---------------------------------------------------------------------------

export const stageStatusSchema = z.object({
  stage: z.string(),
  status: z.enum(["done", "not_implemented", "failed", "skipped"]),
  ms: z.number().int().min(0),
  message: z.string().optional(),
});
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const holdCountsSchema = z.record(holdReasonSchema, z.number().int().min(0));
export type HoldCounts = Partial<Record<HoldReason, number>>;

export interface ReportInput {
  run: RunRow;
  mode: "dry-run" | "live";
  stages: StageStatus[];
  counters: Counters;
  /** Holds by reason across `sources` and `outings` after the run (SPEC.md 8.10). */
  holds: { sources: HoldCounts; outings: HoldCounts };
  strict: boolean;
}

export interface ReportOutput {
  markdown: string;
  failed: boolean;
  failures: string[];
  fetchErrorRate: number;
}

// ---------------------------------------------------------------------------
// Monthly job (SPEC.md 8.1)
// ---------------------------------------------------------------------------

export const osmFeatureInputSchema = z.object({
  osm_ref: z.string().regex(/^(node|way|relation)\/\d+$/),
  state: z.string().regex(/^[A-Z]{2}$/),
  lat: z.number(),
  lng: z.number(),
  tags: z.record(z.string(), z.string()),
});
export type OsmFeatureInput = z.infer<typeof osmFeatureInputSchema>;

export const coursesInputSchema = z.object({
  features: z.array(osmFeatureInputSchema),
  existing: z.array(courseRowSchema),
  places: z.array(placeCitySchema),
  /** Website classifications collected from the course-types batch, by osm_ref. */
  websiteTypes: z.record(z.string(), z.object({ course_type: z.string(), confidence: z.number() })),
});
export type CoursesInput = z.infer<typeof coursesInputSchema> & {
  /** Time zone from lat/lng (tz-lookup); pure. */
  timeZoneAt: (lat: number, lng: number) => string;
};
export interface CoursesOutput {
  plan: UpsertPlan;
  dropped: { osm_ref: string; reason: string }[];
}

export const irsInputSchema = z.object({
  /** BMF CSV rows including the header row, from every regional file. */
  rows: z.array(z.array(z.string())),
});
export type IrsInput = z.infer<typeof irsInputSchema>;
export const irsOutputSchema = z.object({
  records: z.array(irsRecordSchema),
  skipped: z.number().int().min(0),
});
export type IrsOutput = z.infer<typeof irsOutputSchema>;

export const courseTypePageSchema = z.object({
  course_id: z.string(),
  url: httpUrl,
  text: z.string().max(NORMALIZED_TEXT_MAX),
});
export const courseTypesRequestBuildInputSchema = z.object({
  /** Courses still `unknown` with a website, those with outings first. */
  courses: z.array(courseRowSchema),
  pages: z.array(courseTypePageSchema),
  allowance: allowanceSchema,
});
export type CourseTypesRequestBuildInput = z.infer<typeof courseTypesRequestBuildInputSchema>;
export interface CourseTypesRequestBuildOutput {
  requests: ExtractionRequest[];
  deferred: string[];
}
export const courseTypesCollectInputSchema = z.object({
  results: z.array(batchResultSchema),
  courses: z.array(courseRowSchema),
});
export type CourseTypesCollectInput = z.infer<typeof courseTypesCollectInputSchema>;
export interface CourseTypesCollectOutput {
  plan: UpsertPlan;
  accepted: { course_id: string; course_type: string; confidence: number }[];
  rejected: { course_id: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Stage signatures
// ---------------------------------------------------------------------------

export type SearchPlanStage = Stage<SearchPlanInput, SearchPlanOutput>;
export type DiscoverStage = Stage<DiscoverInput, DiscoverOutput>;
export type FetchPlanStage = Stage<FetchPlanInput, FetchPlanOutput>;
export type NormalizeStage = Stage<NormalizeInput, NormalizeOutput>;
export type ExtractRequestBuildStage = Stage<ExtractRequestBuildInput, ExtractRequestBuildOutput>;
export type ExtractCollectStage = Stage<ExtractCollectInput, ExtractCollectOutput>;
export type ClassifyStage = Stage<ClassifyInput, ClassifyOutput>;
export type MatchStage = Stage<MatchInput, MatchOutput>;
export type DedupeUpsertStage = Stage<DedupeUpsertInput, DedupeUpsertOutput>;
export type PublishStage = Stage<PublishInput, PublishOutput>;
export type RecheckRollForwardStage = Stage<RecheckRollForwardInput, RecheckRollForwardOutput>;
export type ReportStage = Stage<ReportInput, ReportOutput>;
export type CoursesStage = Stage<CoursesInput, CoursesOutput>;
export type IrsStage = Stage<IrsInput, IrsOutput>;
export type CourseTypesRequestBuildStage = Stage<
  CourseTypesRequestBuildInput,
  CourseTypesRequestBuildOutput
>;
export type CourseTypesCollectStage = Stage<CourseTypesCollectInput, CourseTypesCollectOutput>;

// ---------------------------------------------------------------------------
// Edge ports (implemented outside src/stages; never called by a stage)
// ---------------------------------------------------------------------------

/** Paid-call gate the edges consult before every paid request (src/budget.ts). */
export interface BudgetCheck {
  check(cap: BudgetCap, amount?: number, stage?: string): boolean;
  monthlySpendOk(stage: string): boolean;
}

/** DataForSEO behind an adapter (amendment A6); a fixture adapter backs dry runs. */
export interface SerpAdapter {
  search(query: SerpQuery, budget: BudgetCheck): Promise<SerpResult[]>;
}

/** Fetches one URL behind the SSRF guard, robots cache and per-host spacing. */
export interface PageFetcher {
  fetchPage(item: FetchPlanItem, budget: BudgetCheck): Promise<FetchedPage>;
}

/** Collects listing links from series, platform, association and directory pages. */
export interface ListingSource {
  links(budget: BudgetCheck): Promise<ListingLink[]>;
}

export const batchStateSchema = z.object({
  batch_id: z.string(),
  status: z.enum(["in_progress", "canceling", "ended"]),
});
export type BatchState = z.infer<typeof batchStateSchema>;

/** Message Batches client: submit, poll every 60 s up to 45 min, collect. */
export interface BatchClient {
  submit(requests: ExtractionRequest[]): Promise<BatchState>;
  poll(batchId: string): Promise<BatchState>;
  results(batchId: string): Promise<BatchResult[]>;
}

export interface IndexNowClient {
  ping(urls: string[]): Promise<void>;
}

export interface Ports {
  serp: SerpAdapter;
  fetcher: PageFetcher;
  listings: ListingSource;
  batch: BatchClient;
  indexnow: IndexNowClient;
}

// Re-exports so stage implementers import one module.
export type { CourseRow, OutingRow, RunRow, SourceRow, TableName, TableRow };
export { holdReasonSchema };
