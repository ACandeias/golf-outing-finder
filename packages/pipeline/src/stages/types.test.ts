import { describe, expect, it } from "vitest";
import {
  batchResultSchema,
  extractedEventSchema,
  normalizedPageSchema,
  parseUpsertPlan,
  queueEntrySchema,
  stageResultSchema,
} from "./types.ts";

const event = {
  is_outing: true,
  reject_reason: null,
  title: "Grady Charity Golf Scramble",
  organizer_name: "Grady Dad's Club",
  organizer_ein: null,
  beneficiary: null,
  course_name: "Rocky Point Golf Course",
  venue_address: null,
  venue_city: "Tampa",
  venue_state: "FL",
  start_date: "2026-11-07",
  end_date: null,
  shotgun_time: "08:30",
  format: "scramble",
  single_price_usd: 150,
  foursome_price_usd: 600,
  sponsor_only: false,
  includes: [],
  handicap_required: null,
  status: "open",
  registration_url: null,
  outing_type_hint: "school_fundraiser",
  audience: "open",
  audience_note: null,
  lodging_required: false,
  summary: "A four-person scramble that raises money for the school.",
  evidence: {
    date: "Saturday, November 7, 2026",
    price: "$150 per golfer",
    venue: "Rocky Point Golf Course",
  },
  source_url: "https://scramblehunter.com/event/grady-charity-golf-scramble-2026/",
  source_kind: "directory",
  event_index: 0,
  single_price_cents: 15000,
  foursome_price_cents: 60000,
  confidence: 1,
  jsonld_start_date: null,
  directory_host: "scramblehunter.com",
};

describe("boundary schemas", () => {
  it("ExtractedEvent extends the shared extraction schema", () => {
    expect(extractedEventSchema.parse(event).single_price_cents).toBe(15000);
    expect(extractedEventSchema.safeParse({ ...event, venue_state: "Florida" }).success).toBe(
      false,
    );
    expect(extractedEventSchema.safeParse({ ...event, confidence: 1.2 }).success).toBe(false);
    expect(extractedEventSchema.safeParse({ ...event, event_index: 25 }).success).toBe(false);
  });

  it("NormalizedPage caps text at 12,000 characters and needs a sha256", () => {
    const page = {
      url: "https://example.org/golf",
      kind: "organizer",
      found_via: "search_place",
      fetched_at: "2026-09-28T12:00:00.000Z",
      http_status: 200,
      text: "Golf outing",
      jsonld: [],
      jsonld_events: [],
      hash: "a".repeat(64),
      unchanged: false,
      needs_render: true,
      rendered: false,
      recheck_outing_id: null,
      directory_host: null,
    };
    expect(normalizedPageSchema.safeParse(page).success).toBe(true);
    expect(normalizedPageSchema.safeParse({ ...page, text: "x".repeat(12_001) }).success).toBe(
      false,
    );
    expect(normalizedPageSchema.safeParse({ ...page, hash: "abc" }).success).toBe(false);
    expect(normalizedPageSchema.safeParse({ ...page, url: "file:///etc/passwd" }).success).toBe(
      false,
    );
  });

  it("QueueEntry only takes http(s) URLs", () => {
    const q = {
      url: "https://example.org/",
      found_via: "series",
      kind: "series",
      priority: 3,
      bypass_dedupe: true,
      recheck_outing_id: null,
      directory_host: null,
    };
    expect(queueEntrySchema.safeParse(q).success).toBe(true);
    expect(queueEntrySchema.safeParse({ ...q, url: "gopher://example.org/" }).success).toBe(false);
  });

  it("BatchResult follows the Message Batches result union", () => {
    expect(
      batchResultSchema.safeParse({
        custom_id: "s06-nkf-winged-foot",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: '{"events":[]}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 4000, output_tokens: 200 },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      batchResultSchema.safeParse({ custom_id: "x", result: { type: "expired" } }).success,
    ).toBe(true);
    expect(
      batchResultSchema.safeParse({ custom_id: "has space", result: { type: "expired" } }).success,
    ).toBe(false);
  });

  it("StageResult validates counters by name", () => {
    expect(
      stageResultSchema.safeParse({
        counters: { fetches: 3 },
        budgetHits: [],
        errors: [],
        holds: [],
      }).success,
    ).toBe(true);
    expect(
      stageResultSchema.safeParse({
        counters: { fetchez: 3 },
        budgetHits: [],
        errors: [],
        holds: [],
      }).success,
    ).toBe(false);
  });
});

describe("UpsertPlan validation", () => {
  it("accepts upsert, update and delete ops on known tables", () => {
    const plan = {
      ops: [
        {
          op: "upsert",
          table: "source_outings",
          rows: [{ source_id: "src_1", outing_id: "out_1" }],
        },
        {
          op: "update",
          table: "outings",
          set: { published: 0, hold_reason: "removed" },
          where: { id: "out_1" },
        },
        { op: "delete", table: "discovery_queue", where: { url: "https://example.org/" } },
      ],
    };
    expect(parseUpsertPlan(plan).ops).toHaveLength(3);
  });

  it("rejects unknown tables, unknown columns, empty where and bad rows", () => {
    expect(() =>
      parseUpsertPlan({ ops: [{ op: "delete", table: "users", where: { id: "x" } }] }),
    ).toThrow();
    expect(() =>
      parseUpsertPlan({
        ops: [{ op: "update", table: "outings", set: { bogus: 1 }, where: { id: "x" } }],
      }),
    ).toThrow();
    expect(() =>
      parseUpsertPlan({ ops: [{ op: "delete", table: "outings", where: {} }] }),
    ).toThrow();
    expect(() =>
      parseUpsertPlan({
        ops: [{ op: "upsert", table: "source_outings", rows: [{ source_id: "", outing_id: "o" }] }],
      }),
    ).toThrow();
    expect(() =>
      parseUpsertPlan({
        ops: [{ op: "upsert", table: "source_outings", rows: [], conflict: ["nope"] }],
      }),
    ).toThrow();
  });
});
