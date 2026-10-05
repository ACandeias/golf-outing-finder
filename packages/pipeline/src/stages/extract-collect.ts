import { z } from "zod";
import { isHhMm, isIsoDate, localToday } from "@gof/shared/dates";
import { dollarsToCents } from "@gof/shared/money";
import { extractionEventSchema, type ExtractionEvent, type HoldReason } from "@gof/shared/schemas";
import { keepRegistrationUrl } from "../extract/domain.ts";
import { EXTRACTOR_VERSION } from "../extract/prompt.ts";
import { lenientZoneForState } from "../extract/state-tz.ts";
import {
  cleanEvidence,
  containsUrl,
  isFreeEvent,
  PUBLISH_CONFIDENCE,
  scoreConfidence,
  statedFoursome,
  yearProblem,
} from "../extract/validate.ts";
import {
  emptyResult,
  extractedEventSchema,
  type Context,
  type ExtractCollectStage,
  type ExtractedEvent,
  type ExtractedPage,
  type ExtractionRequestMeta,
  type JsonLdEvent,
} from "./types.ts";

const STAGE = "extract-collect";

/** The model's top-level answer; each event is validated on its own so one bad event can't sink a page. */
const topLevelSchema = z.object({ events: z.array(z.unknown()).max(25) });

type Verdict = { ok: true; event: ExtractedEvent } | { ok: false; reason: string };

function trimOrNull(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** Light normalization before zod: trims, an upper-case state, and a URL that isn't one becomes null. */
function preclean(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const e: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of [
    "organizer_name",
    "organizer_ein",
    "beneficiary",
    "course_name",
    "venue_address",
    "venue_city",
    "audience_note",
    "start_date",
    "end_date",
    "shotgun_time",
    "registration_url",
  ])
    if (k in e) e[k] = trimOrNull(e[k]);
  if (typeof e.venue_state === "string") e.venue_state = e.venue_state.trim().toUpperCase() || null;
  if (typeof e.registration_url === "string" && !URL.canParse(e.registration_url))
    e.registration_url = null;
  if (typeof e.title === "string") e.title = e.title.trim();
  if (typeof e.summary === "string") e.summary = e.summary.trim();
  return e;
}

function looksLikeOuting(e: ExtractionEvent): boolean {
  return e.is_outing && e.reject_reason === null && !e.lodging_required;
}

/** The JSON-LD Event that speaks for this event, if any (SPEC.md 8.4 cross-check). */
function jsonLdFor(
  e: ExtractionEvent,
  jsonld: readonly JsonLdEvent[],
  singleEventPage: boolean,
): JsonLdEvent | null {
  const dated = jsonld.filter((j) => j.start_date !== null);
  if (dated.length === 0) return null;
  if (singleEventPage) return dated[0] ?? null;
  // On a list page, JSON-LD only counts for the event it agrees with.
  return dated.find((j) => j.start_date === e.start_date) ?? null;
}

function validateEvent(
  ctx: Context,
  raw: unknown,
  index: number,
  m: ExtractionRequestMeta,
  singleEventPage: boolean,
): Verdict {
  const parsed = extractionEventSchema.safeParse(preclean(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const e = parsed.data;
  if (e.title.length === 0) return { ok: false, reason: "empty title" };
  if (e.start_date !== null && !isIsoDate(e.start_date)) return { ok: false, reason: "start_date does not parse" };
  if (e.end_date !== null && !isIsoDate(e.end_date)) return { ok: false, reason: "end_date does not parse" };
  if (e.end_date !== null && (e.start_date === null || e.end_date < e.start_date))
    return { ok: false, reason: "end_date without or before start_date" };
  if (containsUrl(e.summary)) return { ok: false, reason: "summary contains a URL" };

  // JSON-LD is preferred for the date and counts as date evidence.
  const jl = jsonLdFor(e, m.jsonld_events, singleEventPage);
  let startDate = e.start_date;
  let disagrees = false;
  if (jl?.start_date) {
    if (startDate !== null && startDate !== jl.start_date) disagrees = true;
    startDate = jl.start_date;
  }
  const endDate = e.end_date !== null && startDate !== null && e.end_date >= startDate ? e.end_date : null;

  // The year must come from the page, never from the fetch date (amended 2026-10-03).
  if (startDate !== null && jl === null) {
    const why = yearProblem({
      startDate,
      evidenceDate: e.evidence.date,
      pageText: m.page_text ?? null,
      url: m.page_url,
      title: e.title,
      currentYear: ctx.now.getUTCFullYear(),
    });
    if (why) return { ok: false, reason: why };
  }

  // A new outing starts today or later, course-local; the course isn't known yet,
  // so use the state's westernmost zone (publish checks again with the course's).
  if (startDate !== null) {
    const today = localToday(ctx.now.getTime(), lenientZoneForState(e.venue_state));
    if ((endDate ?? startDate) < today) return { ok: false, reason: `past: ${startDate} before ${today}` };
  }

  const evidence = {
    date: cleanEvidence(e.evidence.date),
    price: cleanEvidence(e.evidence.price),
    venue: cleanEvidence(e.evidence.venue),
  };
  const single = e.single_price_usd === null ? null : dollarsToCents(e.single_price_usd);
  const foursome =
    e.foursome_price_usd === null ||
    !statedFoursome(e.single_price_usd, e.foursome_price_usd, m.page_text ?? null)
      ? null
      : dollarsToCents(e.foursome_price_usd);
  // A free event is not an outing anyone pays to enter.
  if (looksLikeOuting(e) && isFreeEvent(e)) {
    e.is_outing = false;
    e.reject_reason = "other";
  }
  const confidence = scoreConfidence({
    hasDateEvidence: startDate !== null && (evidence.date !== null || jl !== null),
    hasCourseName: e.course_name !== null,
    hasState: e.venue_state !== null,
    hasPrice: single !== null || foursome !== null,
    sponsorOnly: e.sponsor_only,
    isOuting: looksLikeOuting(e),
    jsonLdDisagrees: disagrees,
  });

  let hold: HoldReason | null = null;
  if (looksLikeOuting(e)) {
    if (startDate === null) hold = "no_date";
    else if (e.status === "unknown") hold = "status_unknown";
    else if (confidence < PUBLISH_CONFIDENCE) hold = "low_confidence";
  }

  const event = extractedEventSchema.safeParse({
    ...e,
    start_date: startDate,
    end_date: endDate,
    shotgun_time: e.shotgun_time !== null && isHhMm(e.shotgun_time) ? e.shotgun_time : null,
    organizer_ein: e.organizer_ein?.replace(/\D/g, "").length === 9 ? e.organizer_ein.replace(/\D/g, "") : null,
    evidence,
    registration_url: keepRegistrationUrl(
      e.registration_url,
      m.page_url,
      ctx.overrides.registrationHosts,
    ),
    source_url: m.page_url,
    source_kind: m.kind,
    event_index: index,
    single_price_cents: single,
    foursome_price_cents: foursome,
    confidence,
    jsonld_start_date: jl?.start_date ?? null,
    directory_host: m.directory_host,
    hold_reason: hold,
  });
  if (!event.success) return { ok: false, reason: `post: ${event.error.issues[0]?.message ?? "invalid"}` };
  return { ok: true, event: event.data };
}

/**
 * SPEC.md 8.4, workstream C. Reads Message Batches results (keyed by custom_id,
 * in any order) and re-validates every event with zod: dates parse, the start
 * is today or later, prices are 0 to $25,000 and become cents, the summary is
 * 300 characters or fewer with no URL, evidence quotes are 20 words or fewer,
 * and registration_url survives only under the A5 allowlist. JSON-LD's date is
 * preferred and counts as evidence; disagreement costs 0.2. Events that look
 * like outings but have no date, an unknown status or confidence under 0.75
 * carry a hold reason for their source (amendment A3). Errored, expired or
 * unreadable results go to `failed` and their pages stay queued.
 */
export const extractCollect: ExtractCollectStage = (ctx, input) => {
  const result = emptyResult();
  const metaById = new Map(input.meta.map((m) => [m.custom_id, m]));
  const pages: ExtractedPage[] = [];
  const failed: string[] = [];
  const done = new Set<string>();
  let inTokens = 0;
  let outTokens = 0;
  let extracted = 0;
  let held = 0;

  const fail = (customId: string, message: string, url?: string): void => {
    failed.push(customId);
    result.errors.push({ stage: STAGE, kind: "llm", message: `${customId}: ${message}`, url });
  };

  for (const r of input.results) {
    if (done.has(r.custom_id)) continue;
    done.add(r.custom_id);
    const m = metaById.get(r.custom_id);
    if (!m) {
      result.errors.push({ stage: STAGE, kind: "validation", message: `no request for custom_id ${r.custom_id}` });
      continue;
    }
    if (r.result.type !== "succeeded") {
      const why =
        r.result.type === "errored" &&
        typeof r.result.error === "object" &&
        r.result.error !== null &&
        "type" in r.result.error &&
        typeof r.result.error.type === "string"
          ? ` (${r.result.error.type})`
          : "";
      fail(r.custom_id, `batch result ${r.result.type}${why}`, m.page_url);
      continue;
    }
    const msg = r.result.message;
    inTokens += msg.usage.input_tokens;
    outTokens += msg.usage.output_tokens;
    if (msg.stop_reason !== "end_turn") {
      fail(r.custom_id, `stop_reason ${msg.stop_reason ?? "null"}`, m.page_url);
      continue;
    }
    const text = msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      fail(r.custom_id, "output is not JSON", m.page_url);
      continue;
    }
    const top = topLevelSchema.safeParse(json);
    if (!top.success) {
      fail(r.custom_id, "output is not { events: [...] } with at most 25 events", m.page_url);
      continue;
    }
    const events: ExtractedEvent[] = [];
    const rejected: { event_index: number; reason: string }[] = [];
    const single = top.data.events.length === 1;
    top.data.events.forEach((raw, i) => {
      const v = validateEvent(ctx, raw, i, m, single);
      if (!v.ok) {
        rejected.push({ event_index: i, reason: v.reason });
        return;
      }
      events.push(v.event);
      extracted++;
      if (v.event.hold_reason) {
        held++;
        result.holds.push({ scope: "source", key: m.page_url, reason: v.event.hold_reason, event_index: i });
      }
    });
    pages.push({
      url: m.page_url,
      hash: m.hash,
      extractor_version: EXTRACTOR_VERSION,
      extracted_json: JSON.stringify(json),
      events,
      rejected,
    });
  }

  for (const m of input.meta)
    if (!done.has(m.custom_id)) ctx.log.info("no batch result yet", { custom_id: m.custom_id });

  result.counters.events_extracted = extracted;
  if (held > 0) result.counters.events_held = held;
  return { output: { pages, usage: { input_tokens: inTokens, output_tokens: outTokens }, failed }, result };
};
