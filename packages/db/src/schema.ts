import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const series = sqliteTable("series", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  indexUrl: text("index_url").notNull(),
});

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
    courseType: text("course_type").notNull().default("unknown"),
    courseTypeSource: text("course_type_source"),
    courseTypeConfidence: real("course_type_confidence"),
    notable: integer("notable").notNull().default(0),
    website: text("website"),
    osmRef: text("osm_ref").unique(),
    outingCount: integer("outing_count").notNull().default(0),
    lastOutingDate: text("last_outing_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    courseTypeCk: check(
      "course_type_ck",
      sql`${t.courseType} IN ('municipal','public','semi_private','private','resort','unknown')`,
    ),
    coursesGeo: index("courses_geo").on(t.lat, t.lng),
    coursesStateCity: index("courses_state_city").on(t.state, t.city),
  }),
);

export const organizers = sqliteTable(
  "organizers",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    orgType: text("org_type").notNull(),
    ein: text("ein"),
    charityStatus: text("charity_status").notNull().default("unverified"),
    irsSubsection: text("irs_subsection"),
    website: text("website"),
    seriesId: text("series_id").references(() => series.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgTypeCk: check(
      "org_type_ck",
      sql`${t.orgType} IN ('charity','school','business_association','access_operator','tournament_operator','other')`,
    ),
    charityStatusCk: check(
      "charity_status_ck",
      sql`${t.charityStatus} IN ('501c3','other_nonprofit','not_nonprofit','unverified')`,
    ),
  }),
);

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
    outingType: text("outing_type").notNull(),
    audience: text("audience").notNull().default("open"),
    audienceNote: text("audience_note"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    shotgunTime: text("shotgun_time"),
    format: text("format"),
    singlePriceCents: integer("single_price_cents"),
    foursomePriceCents: integer("foursome_price_cents"),
    sponsorOnly: integer("sponsor_only").notNull().default(0),
    includes: text("includes").notNull().default("[]"),
    handicapRequired: integer("handicap_required"),
    status: text("status").notNull(),
    expectedMonth: text("expected_month"),
    registrationUrl: text("registration_url"),
    canonicalSourceUrl: text("canonical_source_url").notNull(),
    sourceGone: integer("source_gone").notNull().default(0),
    confidence: real("confidence").notNull(),
    published: integer("published").notNull().default(0),
    holdReason: text("hold_reason"),
    nextOutingId: text("next_outing_id"),
    firstSeen: text("first_seen").notNull(),
    lastVerified: text("last_verified").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    outingTypeCk: check(
      "outing_type_ck",
      sql`${t.outingType} IN ('charity','school_fundraiser','business_association','access_day','open_tournament','pro_am','other')`,
    ),
    audienceCk: check("audience_ck", sql`${t.audience} IN ('open','aimed_at_group')`),
    statusCk: check(
      "status_ck",
      sql`${t.status} IN ('open','waitlist','sold_out','cancelled','past','expected')`,
    ),
    outingsListing: index("outings_listing").on(t.published, t.status, t.startDate),
    outingsCourse: index("outings_course").on(t.courseId, t.startDate),
    outingsDedupe: uniqueIndex("outings_dedupe")
      .on(t.courseId, t.startDate, t.organizerId)
      .where(sql`${t.startDate} IS NOT NULL`),
  }),
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    outingId: text("outing_id").references(() => outings.id),
    url: text("url").notNull().unique(),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(),
    fetchedAt: text("fetched_at"),
    httpStatus: integer("http_status"),
    contentHash: text("content_hash"),
    extractedJson: text("extracted_json"),
    extractorVersion: text("extractor_version"),
    error: text("error"),
  },
  (t) => ({
    sourceKindCk: check(
      "source_kind_ck",
      sql`${t.kind} IN ('organizer','platform','directory','association','series','submission','search')`,
    ),
  }),
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

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  serpQueries: integer("serp_queries").notNull().default(0),
  fetches: integer("fetches").notNull().default(0),
  renders: integer("renders").notNull().default(0),
  extractions: integer("extractions").notNull().default(0),
  llmInputTokens: integer("llm_input_tokens").notNull().default(0),
  llmOutputTokens: integer("llm_output_tokens").notNull().default(0),
  pendingBatchId: text("pending_batch_id"),
  outingsNew: integer("outings_new").notNull().default(0),
  outingsUpdated: integer("outings_updated").notNull().default(0),
  outingsHeld: integer("outings_held").notNull().default(0),
  budgetHits: text("budget_hits").notNull().default("[]"),
  errors: text("errors").notNull().default("[]"),
  estCostCents: integer("est_cost_cents").notNull().default(0),
});

export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Outing = typeof outings.$inferSelect;
export type NewOuting = typeof outings.$inferInsert;
export type Organizer = typeof organizers.$inferSelect;
export type NewOrganizer = typeof organizers.$inferInsert;
export type Run = typeof runs.$inferSelect;
