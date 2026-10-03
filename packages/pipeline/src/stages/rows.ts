import { z } from "zod";
import {
  audienceSchema,
  courseTypeSchema,
  formatSchema,
  holdReasonSchema,
  outingStatusSchema,
  outingTypeSchema,
} from "@gof/shared/schemas";

/**
 * zod mirrors of the D1 tables the pipeline writes (SPEC.md 7.1, migration
 * packages/db/migrations/0000_init.sql). Column names are snake_case exactly as
 * in SQL so an UpsertPlan row maps 1:1 onto an INSERT. A test compares every
 * schema here with the migrated table, so a schema change without a migration
 * fails CI.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "ISO 8601 UTC timestamp");
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const bool01 = z.union([z.literal(0), z.literal(1)]);
const cents = z.number().int().min(0).max(2_500_000);
const jsonArrayText = z.string().refine((s) => {
  try {
    return Array.isArray(JSON.parse(s));
  } catch {
    return false;
  }
}, "JSON array text");
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "http or https URL");

export const charityStatusSchema = z.enum([
  "501c3",
  "other_nonprofit",
  "not_nonprofit",
  "unverified",
]);
export const orgTypeSchema = z.enum([
  "charity",
  "school",
  "business_association",
  "access_operator",
  "tournament_operator",
  "other",
]);
export const sourceKindSchema = z.enum([
  "organizer",
  "platform",
  "directory",
  "association",
  "series",
  "submission",
  "search",
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const courseTypeSourceSchema = z.enum(["override", "osm", "website_llm"]);
export const runKindSchema = z.enum(["nightly", "monthly"]);

export const seriesRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  index_url: httpUrl,
});

export const courseRowSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  aliases: jsonArrayText,
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().regex(/^[A-Z]{2}$/),
  zip: z.string().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  time_zone: z.string().min(1),
  course_type: courseTypeSchema,
  course_type_source: courseTypeSourceSchema.nullable(),
  course_type_confidence: z.number().min(0).max(1).nullable(),
  notable: bool01,
  website: z.string().nullable(),
  osm_ref: z.string().nullable(),
  outing_count: z.number().int().min(0),
  last_outing_date: isoDate.nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export const organizerRowSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  org_type: orgTypeSchema,
  ein: z
    .string()
    .regex(/^\d{9}$/)
    .nullable(),
  charity_status: charityStatusSchema,
  irs_subsection: z
    .string()
    .regex(/^\d{2}$/)
    .nullable(),
  website: z.string().nullable(),
  series_id: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export const outingObjectSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  course_id: z.string().min(1),
  organizer_id: z.string().nullable(),
  title: z.string().min(1),
  summary: z.string().max(300).nullable(),
  outing_type: outingTypeSchema,
  audience: audienceSchema,
  audience_note: z.string().nullable(),
  start_date: isoDate.nullable(),
  end_date: isoDate.nullable(),
  shotgun_time: hhmm.nullable(),
  format: formatSchema.nullable(),
  single_price_cents: cents.nullable(),
  foursome_price_cents: cents.nullable(),
  sponsor_only: bool01,
  includes: jsonArrayText,
  handicap_required: bool01.nullable(),
  status: outingStatusSchema,
  expected_month: yearMonth.nullable(),
  registration_url: httpUrl.nullable(),
  canonical_source_url: httpUrl,
  source_gone: bool01,
  confidence: z.number().min(0).max(1),
  published: bool01,
  hold_reason: holdReasonSchema.nullable(),
  expected_misses: z.number().int().min(0).max(2),
  next_outing_id: z.string().nullable(),
  first_seen: isoTimestamp,
  last_verified: isoTimestamp,
  updated_at: isoTimestamp,
});

export const outingRowSchema = outingObjectSchema
  .refine((o) => o.start_date !== null || o.status === "expected", {
    message: "start_date may be null only when status = 'expected'",
  })
  .refine((o) => o.end_date === null || (o.start_date !== null && o.end_date >= o.start_date), {
    message: "end_date needs start_date and must not precede it",
  });

export const sourceRowSchema = z.object({
  id: z.string().min(1),
  url: httpUrl,
  domain: z.string().min(1),
  kind: sourceKindSchema,
  fetched_at: isoTimestamp.nullable(),
  http_status: z.number().int().min(100).max(599).nullable(),
  consecutive_gone: z.number().int().min(0),
  content_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  extracted_json: z.string().nullable(),
  extractor_version: z.string().nullable(),
  hold_reason: holdReasonSchema.nullable(),
  held_until: isoDate.nullable(),
  error: z.string().nullable(),
});

export const sourceOutingRowSchema = z.object({
  source_id: z.string().min(1),
  outing_id: z.string().min(1),
});

export const discoveryQueueRowSchema = z.object({
  url: httpUrl,
  found_via: z.string().min(1),
  found_at: isoTimestamp,
  priority: z.number().int(),
  next_attempt_at: isoTimestamp.nullable(),
  attempts: z.number().int().min(0),
});

export const submissionRowSchema = z.object({
  id: z.string().min(1),
  url: z.string().max(2048),
  note: z.string().max(1000).nullable(),
  created_at: isoTimestamp,
  processed: bool01,
});

export const runRowSchema = z.object({
  id: z.string().min(1),
  kind: runKindSchema,
  started_at: isoTimestamp,
  finished_at: isoTimestamp.nullable(),
  stages_done: jsonArrayText,
  serp_queries: z.number().int().min(0),
  fetches: z.number().int().min(0),
  renders: z.number().int().min(0),
  extractions: z.number().int().min(0),
  course_classifications: z.number().int().min(0),
  llm_input_tokens: z.number().int().min(0),
  llm_output_tokens: z.number().int().min(0),
  pending_batch_id: z.string().nullable(),
  outings_new: z.number().int().min(0),
  outings_updated: z.number().int().min(0),
  outings_held: z.number().int().min(0),
  budget_hits: jsonArrayText,
  errors: jsonArrayText,
  est_cost_cents: z.number().int().min(0),
});

/** Plain object schemas (no cross-field refinements), keyed by table. */
export const TABLE_OBJECT_SCHEMAS = {
  series: seriesRowSchema,
  courses: courseRowSchema,
  organizers: organizerRowSchema,
  outings: outingObjectSchema,
  sources: sourceRowSchema,
  source_outings: sourceOutingRowSchema,
  discovery_queue: discoveryQueueRowSchema,
  submissions: submissionRowSchema,
  runs: runRowSchema,
} as const;

/** Every table an UpsertPlan may touch, with its full row schema (CHECKs included). */
export const TABLE_ROW_SCHEMAS = {
  series: seriesRowSchema,
  courses: courseRowSchema,
  organizers: organizerRowSchema,
  outings: outingRowSchema,
  sources: sourceRowSchema,
  source_outings: sourceOutingRowSchema,
  discovery_queue: discoveryQueueRowSchema,
  submissions: submissionRowSchema,
  runs: runRowSchema,
} as const;

export type TableName = keyof typeof TABLE_ROW_SCHEMAS;
export const TABLE_NAMES = Object.keys(TABLE_ROW_SCHEMAS) as TableName[];
export type TableRow<T extends TableName> = z.infer<(typeof TABLE_ROW_SCHEMAS)[T]>;

export type SeriesRow = TableRow<"series">;
export type CourseRow = TableRow<"courses">;
export type OrganizerRow = TableRow<"organizers">;
export type OutingRow = TableRow<"outings">;
export type SourceRow = TableRow<"sources">;
export type SourceOutingRow = TableRow<"source_outings">;
export type DiscoveryQueueRow = TableRow<"discovery_queue">;
export type SubmissionRow = TableRow<"submissions">;
export type RunRow = TableRow<"runs">;
export type CharityStatus = z.infer<typeof charityStatusSchema>;
export type OrgType = z.infer<typeof orgTypeSchema>;

/** Column names of a table's row schema (for the SQL writer and drift tests). */
export function tableColumns(table: TableName): string[] {
  return Object.keys(TABLE_OBJECT_SCHEMAS[table].shape);
}

/** Primary-key columns per table (SPEC.md 7.1), used as the default conflict target. */
export const TABLE_PRIMARY_KEYS: Readonly<Record<TableName, readonly string[]>> = Object.freeze({
  series: ["id"],
  courses: ["id"],
  organizers: ["id"],
  outings: ["id"],
  sources: ["id"],
  source_outings: ["source_id", "outing_id"],
  discovery_queue: ["url"],
  submissions: ["id"],
  runs: ["id"],
});
