/**
 * Drizzle mirror of SPEC.md v1.1 section 7.1. The migration in
 * ../migrations/0000_init.sql is the source of truth for constraints and indexes;
 * tests/migration.test.ts checks that every table and column here exists there.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const COURSE_TYPES = [
  "municipal",
  "public",
  "semi_private",
  "private",
  "resort",
  "unknown",
] as const;
export const COURSE_TYPE_SOURCES = ["override", "osm", "website_llm"] as const;
export const ORG_TYPES = [
  "charity",
  "school",
  "business_association",
  "access_operator",
  "tournament_operator",
  "other",
] as const;
export const CHARITY_STATUSES = ["501c3", "other_nonprofit", "not_nonprofit", "unverified"] as const;
export const OUTING_TYPES = [
  "charity",
  "school_fundraiser",
  "business_association",
  "access_day",
  "open_tournament",
  "pro_am",
  "other",
] as const;
export const AUDIENCES = ["open", "aimed_at_group"] as const;
export const FORMATS = ["scramble", "best_ball", "shamble", "stroke", "other"] as const;
export const OUTING_STATUSES = [
  "open",
  "waitlist",
  "sold_out",
  "cancelled",
  "past",
  "expected",
] as const;
export const HOLD_REASONS = [
  "course_unmatched",
  "low_confidence",
  "status_unknown",
  "no_date",
  "expected_stale",
  "removed",
] as const;
export const SOURCE_KINDS = [
  "organizer",
  "platform",
  "directory",
  "association",
  "series",
  "submission",
  "search",
] as const;
export const RUN_KINDS = ["nightly", "monthly"] as const;

export const series = sqliteTable("series", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  indexUrl: text("index_url").notNull(),
});

export const cities = sqliteTable(
  "cities",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    population: integer("population").notNull().default(0),
    timeZone: text("time_zone").notNull(),
  },
  (t) => [
    uniqueIndex("cities_state_slug").on(t.state, t.slug),
    index("cities_geo").on(t.lat, t.lng),
  ],
);

export const zips = sqliteTable(
  "zips",
  {
    zip: text("zip").primaryKey(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    cityId: integer("city_id").references(() => cities.id),
  },
  (t) => [check("zip_len", sql`length(${t.zip}) = 5`)],
);

export const courses = sqliteTable(
  "courses",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    aliases: text("aliases").notNull().default("[]"),
    street: text("street"),
    city: text("city"),
    state: text("state").notNull(),
    zip: text("zip"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    timeZone: text("time_zone").notNull(),
    courseType: text("course_type", { enum: COURSE_TYPES }).notNull().default("unknown"),
    courseTypeSource: text("course_type_source", { enum: COURSE_TYPE_SOURCES }),
    courseTypeConfidence: real("course_type_confidence"),
    notable: integer("notable").notNull().default(0),
    website: text("website"),
    osmRef: text("osm_ref").unique(),
    outingCount: integer("outing_count").notNull().default(0),
    lastOutingDate: text("last_outing_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("courses_geo").on(t.lat, t.lng), index("courses_state_city").on(t.state, t.city)],
);

export const organizers = sqliteTable("organizers", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  orgType: text("org_type", { enum: ORG_TYPES }).notNull(),
  ein: text("ein"),
  charityStatus: text("charity_status", { enum: CHARITY_STATUSES }).notNull().default("unverified"),
  irsSubsection: text("irs_subsection"),
  website: text("website"),
  seriesId: text("series_id").references(() => series.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const outings = sqliteTable(
  "outings",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id),
    organizerId: text("organizer_id").references(() => organizers.id),
    title: text("title").notNull(),
    summary: text("summary"),
    outingType: text("outing_type", { enum: OUTING_TYPES }).notNull(),
    audience: text("audience", { enum: AUDIENCES }).notNull().default("open"),
    audienceNote: text("audience_note"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    shotgunTime: text("shotgun_time"),
    format: text("format", { enum: FORMATS }),
    singlePriceCents: integer("single_price_cents"),
    foursomePriceCents: integer("foursome_price_cents"),
    sponsorOnly: integer("sponsor_only").notNull().default(0),
    includes: text("includes").notNull().default("[]"),
    handicapRequired: integer("handicap_required"),
    status: text("status", { enum: OUTING_STATUSES }).notNull(),
    expectedMonth: text("expected_month"),
    registrationUrl: text("registration_url"),
    canonicalSourceUrl: text("canonical_source_url").notNull(),
    sourceGone: integer("source_gone").notNull().default(0),
    confidence: real("confidence").notNull(),
    published: integer("published").notNull().default(0),
    holdReason: text("hold_reason", { enum: HOLD_REASONS }),
    expectedMisses: integer("expected_misses").notNull().default(0),
    nextOutingId: text("next_outing_id").references((): AnySQLiteColumn => outings.id),
    firstSeen: text("first_seen").notNull(),
    lastVerified: text("last_verified").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("outings_listing").on(t.published, t.status, t.startDate),
    index("outings_course").on(t.courseId, t.startDate),
    index("outings_organizer").on(t.organizerId),
    uniqueIndex("outings_dedupe")
      .on(t.courseId, t.startDate, sql`COALESCE(${t.organizerId}, '')`)
      .where(sql`${t.startDate} IS NOT NULL`),
    uniqueIndex("outings_expected")
      .on(t.courseId, t.organizerId, t.expectedMonth)
      .where(sql`${t.status} = 'expected'`),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull().unique(),
    domain: text("domain").notNull(),
    kind: text("kind", { enum: SOURCE_KINDS }).notNull(),
    fetchedAt: text("fetched_at"),
    httpStatus: integer("http_status"),
    consecutiveGone: integer("consecutive_gone").notNull().default(0),
    contentHash: text("content_hash"),
    extractedJson: text("extracted_json"),
    extractorVersion: text("extractor_version"),
    holdReason: text("hold_reason", { enum: HOLD_REASONS }),
    heldUntil: text("held_until"),
    error: text("error"),
  },
  (t) => [index("sources_hold").on(t.holdReason).where(sql`${t.holdReason} IS NOT NULL`)],
);

export const sourceOutings = sqliteTable(
  "source_outings",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    outingId: text("outing_id")
      .notNull()
      .references(() => outings.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.outingId] }),
    index("source_outings_outing").on(t.outingId),
  ],
);

export const discoveryQueue = sqliteTable("discovery_queue", {
  url: text("url").primaryKey(),
  foundVia: text("found_via").notNull(),
  foundAt: text("found_at").notNull(),
  priority: integer("priority").notNull().default(5),
  nextAttemptAt: text("next_attempt_at"),
  attempts: integer("attempts").notNull().default(0),
});

export const submissions = sqliteTable("submissions", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  processed: integer("processed").notNull().default(0),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    stagesDone: text("stages_done").notNull().default("[]"),
    serpQueries: integer("serp_queries").notNull().default(0),
    fetches: integer("fetches").notNull().default(0),
    renders: integer("renders").notNull().default(0),
    extractions: integer("extractions").notNull().default(0),
    courseClassifications: integer("course_classifications").notNull().default(0),
    llmInputTokens: integer("llm_input_tokens").notNull().default(0),
    llmOutputTokens: integer("llm_output_tokens").notNull().default(0),
    pendingBatchId: text("pending_batch_id"),
    outingsNew: integer("outings_new").notNull().default(0),
    outingsUpdated: integer("outings_updated").notNull().default(0),
    outingsHeld: integer("outings_held").notNull().default(0),
    budgetHits: text("budget_hits").notNull().default("[]"),
    errors: text("errors").notNull().default("[]"),
    estCostCents: integer("est_cost_cents").notNull().default(0),
  },
  (t) => [index("runs_started").on(t.startedAt)],
);

export const allTables = {
  series,
  cities,
  zips,
  courses,
  organizers,
  outings,
  sources,
  source_outings: sourceOutings,
  discovery_queue: discoveryQueue,
  submissions,
  runs,
} as const;

export type City = typeof cities.$inferSelect;
export type NewCity = typeof cities.$inferInsert;
export type Zip = typeof zips.$inferSelect;
export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Organizer = typeof organizers.$inferSelect;
export type NewOrganizer = typeof organizers.$inferInsert;
export type Outing = typeof outings.$inferSelect;
export type NewOuting = typeof outings.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceOuting = typeof sourceOutings.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type HoldReason = (typeof HOLD_REASONS)[number];
