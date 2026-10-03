import { describe, expect, it } from "vitest";
import { sourceIdForUrl } from "../extract/ids.ts";
import { EXTRACT_MAX_TOKENS, EXTRACT_MODEL, EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.ts";
import { HASH, meta, rawEvent, succeeded, testCtx } from "../extract/test-helpers.ts";
import { extractCollect } from "./extract-collect.ts";
import { extractRequestBuild } from "./extract-request-build.ts";
import type { NormalizedPage } from "./types.ts";

function page(patch: Partial<NormalizedPage> = {}): NormalizedPage {
  return {
    url: "https://example.org/golf",
    kind: "organizer",
    found_via: "search_place",
    fetched_at: "2026-09-28T12:00:00.000Z",
    http_status: 200,
    text: "Spring Charity Scramble, Saturday, October 3, 2026 at Encanto 18. $125 per player.",
    jsonld: [],
    jsonld_events: [],
    hash: HASH,
    unchanged: false,
    needs_render: false,
    rendered: false,
    recheck_outing_id: null,
    directory_host: null,
    ...patch,
  };
}

const allowance = { MAX_EXTRACTIONS_PER_RUN: 600, MAX_LLM_INPUT_TOKENS_PER_RUN: 2_000_000 };

describe("extract-request-build", () => {
  it("builds one Haiku 4.5 batch request per changed page, no tools, cached system prompt", () => {
    const { output } = extractRequestBuild(testCtx(), {
      pages: [page(), page({ url: "https://example.org/same", unchanged: true })],
      allowance,
    });
    expect(output.requests).toHaveLength(1);
    const r = output.requests[0]!;
    expect(r.custom_id).toBe(sourceIdForUrl("https://example.org/golf"));
    expect(r.params).toMatchObject({
      model: EXTRACT_MODEL,
      max_tokens: EXTRACT_MAX_TOKENS,
      temperature: 0,
      system: [{ type: "text", text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema" } },
    });
    expect(r.params).not.toHaveProperty("tools");
    const content = (r.params.messages as { content: string }[])[0]!.content;
    expect(content.startsWith('<page url="https://example.org/golf" fetched="2026-09-28">')).toBe(true);
    expect(output.meta[0]).toMatchObject({ custom_id: r.custom_id, page_url: "https://example.org/golf", hash: HASH });
  });

  it("uses an existing source id as custom_id and passes Event JSON-LD as its own block", () => {
    const { output } = extractRequestBuild(testCtx(), {
      pages: [page({ jsonld: [{ "@type": "Event", name: "Spring", startDate: "2026-10-03" }] })],
      allowance,
      source_ids: { "https://example.org/golf": "src_01EXISTING" },
    });
    expect(output.requests[0]!.custom_id).toBe("src_01EXISTING");
    const content = (output.requests[0]!.params.messages as { content: string }[])[0]!.content;
    expect(content).toMatch(/<\/page>\n\n<jsonld>\n\[\{"@type":"Event"/);
  });

  it("stops at MAX_EXTRACTIONS_PER_RUN, records a hit and defers the rest", () => {
    const pages = [1, 2, 3].map((n) => page({ url: `https://example.org/${n}` }));
    const { output, result } = extractRequestBuild(testCtx(), {
      pages,
      allowance: { ...allowance, MAX_EXTRACTIONS_PER_RUN: 2 },
    });
    expect(output.requests).toHaveLength(2);
    expect(output.deferred).toEqual(["https://example.org/3"]);
    expect(result.budgetHits).toEqual([
      expect.objectContaining({ stage: "extract-request-build", cap: "MAX_EXTRACTIONS_PER_RUN", limit: 2 }),
    ]);
  });

  it("stops at MAX_LLM_INPUT_TOKENS_PER_RUN using the estimate", () => {
    const pages = [1, 2].map((n) => page({ url: `https://example.org/${n}` }));
    const one = extractRequestBuild(testCtx(), { pages: [pages[0]!], allowance }).output.requests[0]!;
    const { output, result } = extractRequestBuild(testCtx(), {
      pages,
      allowance: { ...allowance, MAX_LLM_INPUT_TOKENS_PER_RUN: one.est_input_tokens + 10 },
    });
    expect(output.requests).toHaveLength(1);
    expect(output.deferred).toEqual(["https://example.org/2"]);
    expect(result.budgetHits[0]?.cap).toBe("MAX_LLM_INPUT_TOKENS_PER_RUN");
  });
});

describe("extract-collect", () => {
  const ctx = testCtx();
  const collect = (events: unknown[], m = meta()) =>
    extractCollect(ctx, { results: [succeeded(m.custom_id, { events })], meta: [m] });

  it("validates events, converts prices to cents and scores confidence", () => {
    const { output, result } = collect([rawEvent()]);
    const e = output.pages[0]!.events[0]!;
    expect(e).toMatchObject({
      single_price_cents: 12_500,
      foursome_price_cents: 50_000,
      confidence: 1,
      hold_reason: null,
      source_url: "https://example.org/golf",
      event_index: 0,
    });
    expect(output.usage).toEqual({ input_tokens: 1000, output_tokens: 200 });
    expect(result.counters.events_extracted).toBe(1);
  });

  it("rejects past dates (course-local), bad dates and URLs in the summary", () => {
    const { output } = collect([
      rawEvent({ start_date: "2026-09-27" }),
      rawEvent({ start_date: "2026-02-30" }),
      rawEvent({ summary: "Sign up at https://example.org/register" }),
      rawEvent({ start_date: "2026-10-05", end_date: "2026-10-04" }),
      rawEvent({ single_price_usd: 26_000 }),
      rawEvent({ summary: "x".repeat(301) }),
      rawEvent(),
    ]);
    const p = output.pages[0]!;
    expect(p.events.map((e) => e.event_index)).toEqual([6]);
    expect(p.rejected.map((r) => r.event_index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(p.rejected[0]!.reason).toMatch(/^past/);
  });

  it("keeps a multi-day event that is still running", () => {
    const { output } = collect([rawEvent({ start_date: "2026-09-26", end_date: "2026-09-29" })]);
    expect(output.pages[0]!.events).toHaveLength(1);
  });

  it("drops registration URLs off the page's domain unless allowlisted (A5)", () => {
    const { output } = collect([
      rawEvent({ registration_url: "https://www.golfstatus.com/t/1" }),
      rawEvent({ registration_url: "https://pay.elsewhere.biz/x", start_date: "2026-10-04" }),
      rawEvent({ registration_url: "not a url", start_date: "2026-10-05" }),
    ]);
    expect(output.pages[0]!.events.map((e) => e.registration_url)).toEqual([
      "https://www.golfstatus.com/t/1",
      null,
      null,
    ]);
  });

  it("drops evidence over 20 words, which costs the date evidence", () => {
    const long = Array.from({ length: 21 }, () => "w").join(" ");
    const { output } = collect([rawEvent({ evidence: { date: long, price: "$125", venue: "Encanto" } })]);
    const e = output.pages[0]!.events[0]!;
    expect(e.evidence.date).toBeNull();
    expect(e.confidence).toBe(0.7);
    expect(e.hold_reason).toBe("low_confidence");
  });

  it("holds status unknown, no date and low confidence on the source (A3)", () => {
    const { output, result } = collect([
      rawEvent({ status: "unknown" }),
      rawEvent({ start_date: null, evidence: { date: null, price: null, venue: null } }),
      rawEvent({ course_name: null, venue_state: null }),
      rawEvent({ is_outing: false, reject_reason: "members_only", status: "unknown" }),
    ]);
    expect(output.pages[0]!.events.map((e) => e.hold_reason)).toEqual([
      "status_unknown",
      "no_date",
      "low_confidence",
      null,
    ]);
    expect(result.holds.map((h) => [h.reason, h.event_index])).toEqual([
      ["status_unknown", 0],
      ["no_date", 1],
      ["low_confidence", 2],
    ]);
  });

  it("prefers the JSON-LD date, counts it as evidence, and takes 0.2 for disagreement", () => {
    const jl = { name: "Spring", start_date: "2026-10-04", start_time: null, location_name: null, location_address: null };
    const agree = collect(
      [rawEvent({ start_date: "2026-10-04", evidence: { date: null, price: "$125", venue: "x" } })],
      meta({ jsonld_events: [jl] }),
    ).output.pages[0]!.events[0]!;
    expect(agree.confidence).toBe(1);
    expect(agree.jsonld_start_date).toBe("2026-10-04");
    const disagree = collect([rawEvent()], meta({ jsonld_events: [jl] })).output.pages[0]!.events[0]!;
    expect(disagree.start_date).toBe("2026-10-04");
    expect(disagree.confidence).toBe(0.8);
  });

  it("sends errored, expired, truncated and malformed results to failed", () => {
    const m1 = meta({ custom_id: "a", page_url: "https://example.org/a" });
    const m2 = meta({ custom_id: "b", page_url: "https://example.org/b" });
    const m3 = meta({ custom_id: "c", page_url: "https://example.org/c" });
    const m4 = meta({ custom_id: "d", page_url: "https://example.org/d" });
    const { output, result } = extractCollect(ctx, {
      results: [
        { custom_id: "a", result: { type: "errored", error: { type: "overloaded_error" } } },
        { custom_id: "b", result: { type: "expired" } },
        succeeded("c", '{"events":[', "max_tokens"),
        succeeded("d", "not json"),
        succeeded("zzz", { events: [] }),
      ],
      meta: [m1, m2, m3, m4],
    });
    expect(output.failed).toEqual(["a", "b", "c", "d"]);
    expect(output.pages).toEqual([]);
    expect(result.errors.map((e) => e.kind)).toEqual(["llm", "llm", "llm", "llm", "validation"]);
  });

  it("keeps the raw answer for sources.extracted_json", () => {
    const { output } = collect([rawEvent()]);
    expect(JSON.parse(output.pages[0]!.extracted_json)).toEqual({ events: [rawEvent()] });
    expect(output.pages[0]!.extractor_version).toBe("extract-v1");
  });
});
