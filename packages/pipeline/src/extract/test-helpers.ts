/** Builders shared by workstream C's unit tests (not imported by runtime code). */
import { resolveBudget } from "@gof/shared/budget";
import { emptyOverrides, type Overrides } from "../overrides/load.ts";
import {
  extractedEventSchema,
  type BatchResult,
  type Context,
  type ExtractedEvent,
  type ExtractionRequestMeta,
  type MatchedOuting,
  type OutingRow,
  type SourceRow,
} from "../stages/types.ts";

export const NOW = new Date("2026-09-28T12:00:00.000Z");
export const HASH = "a".repeat(64);

export function testCtx(overrides: Partial<Overrides> = {}, now: Date = NOW): Context {
  return {
    now,
    caps: resolveBudget("nightly"),
    overrides: emptyOverrides({
      registrationHosts: ["golfstatus.com", "qgiv.com"],
      accessOperators: ["golfwithaccess.com"],
      tournamentOperators: ["amateurgolf.com"],
      ...overrides,
    }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { nowMs: () => 0 },
  };
}

/** A raw event as the model returns it. */
export function rawEvent(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    is_outing: true,
    reject_reason: null,
    title: "Spring Charity Scramble",
    organizer_name: "Friends of the Park",
    organizer_ein: null,
    beneficiary: null,
    course_name: "Encanto 18 Golf Course",
    venue_address: null,
    venue_city: "Phoenix",
    venue_state: "AZ",
    start_date: "2026-10-03",
    end_date: null,
    shotgun_time: "07:00",
    format: "scramble",
    single_price_usd: 125,
    foursome_price_usd: 500,
    sponsor_only: false,
    includes: ["lunch"],
    handicap_required: null,
    status: "open",
    registration_url: null,
    outing_type_hint: "charity",
    audience: "open",
    audience_note: null,
    lodging_required: false,
    summary: "A four-person scramble at Encanto 18.",
    evidence: { date: "Saturday, October 3rd, 2026", price: "$125 per player", venue: "Encanto 18" },
    ...patch,
  };
}

export function succeeded(customId: string, json: unknown, stop = "end_turn"): BatchResult {
  return {
    custom_id: customId,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
        stop_reason: stop,
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    },
  };
}

export function meta(patch: Partial<ExtractionRequestMeta> = {}): ExtractionRequestMeta {
  return {
    custom_id: "src_1",
    page_url: "https://example.org/golf",
    kind: "organizer",
    hash: HASH,
    jsonld_events: [],
    directory_host: null,
    ...patch,
  };
}

export function extracted(patch: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return extractedEventSchema.parse({
    ...rawEvent(),
    source_url: "https://example.org/golf",
    source_kind: "organizer",
    event_index: 0,
    single_price_cents: 12_500,
    foursome_price_cents: 50_000,
    registration_url: null,
    confidence: 1,
    jsonld_start_date: null,
    directory_host: null,
    hold_reason: null,
    ...patch,
  });
}

export function matched(
  patch: Partial<MatchedOuting> = {},
  course: { id: string; name: string } | null = { id: "crs_encanto", name: "Encanto 18 Golf Course" },
): MatchedOuting {
  return {
    ...extracted(),
    excluded: false,
    exclude_reason: null,
    outing_type: "charity",
    org_type: "charity",
    charity_status: "unverified",
    irs: null,
    irs_match: "none",
    organizer_domain: "example.org",
    match: course
      ? {
          kind: "matched",
          course_id: course.id,
          course_name: course.name,
          time_zone: "America/Phoenix",
          score: 1,
          facility: false,
          aliases_to_add: [],
        }
      : { kind: "unmatched", candidates: [] },
    ...patch,
  };
}

export function outingRow(patch: Partial<OutingRow> = {}): OutingRow {
  return {
    id: "out_1",
    slug: "2026/spring-charity-scramble-encanto-18",
    course_id: "crs_encanto",
    organizer_id: "org_1",
    title: "Spring Charity Scramble",
    summary: null,
    outing_type: "charity",
    audience: "open",
    audience_note: null,
    start_date: "2026-10-03",
    end_date: null,
    shotgun_time: null,
    format: null,
    single_price_cents: null,
    foursome_price_cents: null,
    sponsor_only: 0,
    includes: "[]",
    handicap_required: null,
    status: "open",
    expected_month: null,
    registration_url: null,
    canonical_source_url: "https://example.org/golf",
    source_gone: 0,
    confidence: 1,
    published: 0,
    hold_reason: null,
    expected_misses: 0,
    next_outing_id: null,
    first_seen: "2026-09-01T00:00:00.000Z",
    last_verified: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...patch,
  };
}

export function sourceRow(patch: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "src_1",
    url: "https://example.org/golf",
    domain: "example.org",
    kind: "organizer",
    fetched_at: null,
    http_status: 200,
    consecutive_gone: 0,
    content_hash: null,
    extracted_json: null,
    extractor_version: null,
    hold_reason: null,
    held_until: null,
    error: null,
    ...patch,
  };
}
