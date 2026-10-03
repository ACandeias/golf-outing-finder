import { addDaysIso, monthOf, todayIso } from "@gof/shared/dates";
import { organizerSlug, outingSlug } from "@gof/shared/slug";
import { tokenSetSimilarity } from "../classify/similarity.ts";
import { canonicalUrlFor } from "../extract/canonical.ts";
import { registrableDomainOf, sourceDomain } from "../extract/domain.ts";
import { sourceIdForUrl, stableId } from "../extract/ids.ts";
import { EXTRACTOR_VERSION } from "../extract/prompt.ts";
import { PUBLISH_CONFIDENCE } from "../extract/validate.ts";
import type { HoldReason } from "@gof/shared/schemas";
import type { OrganizerRow, SourceKind, SourceOutingRow } from "./rows.ts";
import {
  emptyResult,
  parseUpsertPlan,
  type DedupeUpsertStage,
  type ExistingOrganizer,
  type MatchedOuting,
  type OutingRow,
  type SourceRow,
  type TableOp,
  type UpsertOutcome,
} from "./types.ts";

/** SPEC.md 8.7: organizer names this similar on the same course and date are one outing. */
export const SAME_OUTING_SIMILARITY = 0.8;
/** An organizer name this close to an existing organizer reuses its row. */
export const SAME_ORGANIZER_SIMILARITY = 0.92;
/** Held sources keep waiting for a second source this long (SPEC.md 8.6). */
export const HOLD_DAYS = 30;

/** Merge precedence (SPEC.md 8.7): the organizer's own page, then a platform, then the rest, then a directory. */
const KIND_RANK: Readonly<Record<SourceKind, number>> = {
  organizer: 0,
  platform: 1,
  series: 2,
  association: 2,
  submission: 2,
  search: 2,
  directory: 3,
};

type Matched = MatchedOuting & { match: Extract<MatchedOuting["match"], { kind: "matched" }> };

function isMatched(e: MatchedOuting): e is Matched {
  return e.match.kind === "matched";
}

function byPrecedence(a: MatchedOuting, b: MatchedOuting): number {
  return KIND_RANK[a.source_kind] - KIND_RANK[b.source_kind] || b.confidence - a.confidence;
}

function similar(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && tokenSetSimilarity(a, b) >= SAME_OUTING_SIMILARITY;
}

/**
 * Same outing on the same course and date: organizer names 0.8 or more alike;
 * with a name missing on one side, titles 0.8 or more alike; with no name on
 * either side, always (the dedupe index allows one organizer-less row per
 * course and date).
 */
function sameOuting(
  a: { organizer: string | null; title: string },
  b: { organizer: string | null; title: string },
): boolean {
  if (a.organizer !== null && b.organizer !== null) return similar(a.organizer, b.organizer);
  if (a.organizer === null && b.organizer === null) return true;
  return similar(a.title, b.title);
}

function monthGap(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return Math.abs(ay * 12 + am - (by * 12 + bm));
}

function first<T>(events: readonly MatchedOuting[], pick: (e: MatchedOuting) => T | null): T | null {
  for (const e of events) {
    const v = pick(e);
    if (v !== null) return v;
  }
  return null;
}

interface Cluster {
  events: Matched[];
}

/**
 * SPEC.md 8.7 and amendment A3, workstream C. Turns this run's matched events
 * into one UpsertPlan:
 *
 * - excluded events are dropped; held events stay on their `sources` row
 *   (`hold_reason`, `held_until` 30 days out, `extracted_json`) and never create
 *   an outing, unless a second independent source (another registrable domain)
 *   agrees on course and date, which lifts a low-confidence hold;
 * - events on the same course and date whose organizer names are 0.8 or more
 *   alike are one outing; fields merge preferring the organizer's page, then a
 *   platform, then a directory, and `canonical_source_url` is the organizer
 *   page when there is one;
 * - an existing dated outing is updated in place (its id and slug never
 *   change); an existing expected row for the same course and organizer within
 *   a month either way is confirmed in place (SPEC.md 8.9);
 * - new outings get `{year}/{title}-{course short slug}` slugs with `-2`, `-3`
 *   on collision; new organizers get `kebab(name)` slugs;
 * - every source links to each outing it produced through `source_outings`;
 * - fetch outcomes update `sources` (status, consecutive 404/410 count, hash);
 *   unchanged pages only move `last_verified`.
 *
 * Nothing is published here; the publish stage decides that.
 */
export const dedupeUpsert: DedupeUpsertStage = (ctx, input) => {
  const result = emptyResult();
  const nowMs = ctx.now.getTime();
  const nowIso = ctx.now.toISOString();
  const heldUntil = addDaysIso(todayIso(nowMs), HOLD_DAYS);
  const outcomes: UpsertOutcome[] = [];

  const sourceByUrl = new Map(input.existing.sources.map((s) => [s.url, s]));
  const sourceIdOf = (url: string): string => sourceByUrl.get(url)?.id ?? sourceIdForUrl(url);
  const organizersById = new Map(input.existing.organizers.map((o) => [o.id, o]));
  const organizerNameOf = (id: string | null): string | null =>
    id === null ? null : (organizersById.get(id)?.name ?? null);

  // Held and excluded events ------------------------------------------------
  const live: MatchedOuting[] = [];
  for (const e of input.outings) {
    if (e.excluded) {
      outcomes.push({ source_url: e.source_url, event_index: e.event_index, action: "excluded", outing_id: null, hold_reason: null });
      continue;
    }
    live.push(e);
  }
  const domainOf = (e: MatchedOuting): string => registrableDomainOf(e.source_url) ?? e.source_url;
  const lifted = new Set<MatchedOuting>();
  for (const e of live) {
    if (e.hold_reason !== "low_confidence" || !isMatched(e) || e.start_date === null) continue;
    const course = e.match.course_id;
    const date = e.start_date;
    const corroborated =
      live.some(
        (o) =>
          o !== e &&
          isMatched(o) &&
          o.match.course_id === course &&
          o.start_date === date &&
          domainOf(o) !== domainOf(e) &&
          (o.hold_reason === null || o.hold_reason === "low_confidence"),
      ) ||
      input.existing.outings.some(
        (x) =>
          x.course_id === course &&
          x.start_date === date &&
          x.status !== "expected" &&
          registrableDomainOf(x.canonical_source_url) !== domainOf(e),
      );
    if (corroborated) lifted.add(e);
  }
  const active: Matched[] = [];
  const stillHeld: MatchedOuting[] = [];
  for (const e of live) {
    if (e.hold_reason === null || lifted.has(e)) {
      if (isMatched(e) && e.start_date !== null) {
        active.push(
          lifted.has(e)
            ? { ...e, hold_reason: null, confidence: Math.max(e.confidence, PUBLISH_CONFIDENCE) }
            : e,
        );
        continue;
      }
    }
    stillHeld.push(e);
  }
  for (const e of stillHeld) {
    const reason: HoldReason = e.hold_reason ?? (isMatched(e) ? "no_date" : "course_unmatched");
    outcomes.push({ source_url: e.source_url, event_index: e.event_index, action: "held", outing_id: null, hold_reason: reason });
  }

  // Clusters: same course, same date, same organizer ------------------------
  const clusters: Cluster[] = [];
  for (const e of [...active].sort(byPrecedence)) {
    const c = clusters.find((k) => {
      const rep = k.events[0];
      return (
        rep !== undefined &&
        rep.match.course_id === e.match.course_id &&
        rep.start_date === e.start_date &&
        sameOuting(
          { organizer: rep.organizer_name, title: rep.title },
          { organizer: e.organizer_name, title: e.title },
        )
      );
    });
    if (c) c.events.push(e);
    else clusters.push({ events: [e] });
  }

  // Organizers ----------------------------------------------------------------
  const organizerSlugs = new Set(input.existing.organizerSlugs);
  const newOrganizers: OrganizerRow[] = [];
  const organizerUpdates: TableOp[] = [];
  const knownOrganizers: ExistingOrganizer[] = [...input.existing.organizers];
  const resolveOrganizer = (e: Matched): string | null => {
    const name = e.organizer_name;
    if (name === null) return null;
    const ein = e.irs?.ein ?? null;
    const found =
      (ein ? knownOrganizers.find((o) => o.ein === ein) : undefined) ??
      knownOrganizers.find((o) => tokenSetSimilarity(o.name, name) >= SAME_ORGANIZER_SIMILARITY);
    if (found) {
      const isNew = newOrganizers.some((o) => o.id === found.id);
      if (!isNew && found.charity_status === "unverified" && e.irs) {
        organizerUpdates.push({
          op: "update",
          table: "organizers",
          set: {
            charity_status: e.charity_status,
            ein: e.irs.ein,
            irs_subsection: e.irs.subsection,
            updated_at: nowIso,
          },
          where: { id: found.id },
        });
        found.charity_status = e.charity_status;
        found.ein = e.irs.ein;
      }
      return found.id;
    }
    const slug = organizerSlug(name, organizerSlugs);
    organizerSlugs.add(slug);
    const row: OrganizerRow = {
      id: stableId("org", nowMs, ein ?? name.toLowerCase()),
      slug,
      name,
      org_type: e.org_type,
      ein,
      charity_status: e.charity_status,
      irs_subsection: e.irs?.subsection ?? null,
      website: null,
      series_id: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    newOrganizers.push(row);
    knownOrganizers.push({ id: row.id, slug, name, ein, charity_status: row.charity_status });
    return row.id;
  };

  // Outings -------------------------------------------------------------------
  const outingSlugs = new Set(input.existing.outingSlugs);
  const outingRows: OutingRow[] = [];
  const links: SourceOutingRow[] = [];
  const claimed = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const cluster of clusters) {
    const evs = cluster.events;
    const top = evs[0];
    if (!top) continue;
    const start = top.start_date as string;
    const courseId = top.match.course_id;
    const organizerId = resolveOrganizer(top);
    const organizerName = top.organizer_name;

    const organizerPage = evs.find((e) => e.source_kind === "organizer");
    const canonical = canonicalUrlFor(organizerPage ?? top);
    const endDate = first(evs, (e) => e.end_date);
    const merged = {
      title: top.title,
      summary: first(evs, (e) => (e.summary.length > 0 ? e.summary : null)),
      outing_type: top.outing_type,
      audience: top.audience,
      audience_note: first(evs, (e) => e.audience_note),
      start_date: start,
      end_date: endDate !== null && endDate >= start ? endDate : null,
      shotgun_time: first(evs, (e) => e.shotgun_time),
      format: first(evs, (e) => e.format),
      single_price_cents: first(evs, (e) => e.single_price_cents),
      foursome_price_cents: first(evs, (e) => e.foursome_price_cents),
      sponsor_only: top.sponsor_only ? (1 as const) : (0 as const),
      includes: JSON.stringify(first(evs, (e) => (e.includes.length > 0 ? e.includes : null)) ?? []),
      handicap_required: (() => {
        const h = first(evs, (e) => e.handicap_required);
        return h === null ? null : h ? (1 as const) : (0 as const);
      })(),
      status: top.status === "unknown" ? ("open" as const) : top.status,
      registration_url: first(evs, (e) => e.registration_url),
      confidence: Math.max(...evs.map((e) => e.confidence)),
    };

    const sameAs = (x: OutingRow): boolean =>
      sameOuting(
        { organizer: organizerNameOf(x.organizer_id), title: x.title },
        { organizer: organizerName, title: top.title },
      ) ||
      (organizerId !== null && x.organizer_id === organizerId);
    const existingDated = input.existing.outings.find(
      (x) =>
        !claimed.has(x.id) &&
        x.status !== "expected" &&
        x.course_id === courseId &&
        x.start_date === start &&
        sameAs(x),
    );
    const existingExpected =
      existingDated ??
      input.existing.outings.find(
        (x) =>
          !claimed.has(x.id) &&
          x.status === "expected" &&
          x.course_id === courseId &&
          organizerId !== null &&
          x.organizer_id === organizerId &&
          monthGap(x.expected_month ?? monthOf(x.start_date ?? start), monthOf(start)) <= 1,
      );
    const existing = existingDated ?? existingExpected;

    let row: OutingRow;
    let action: UpsertOutcome["action"];
    if (existing) {
      claimed.add(existing.id);
      const confirming = existing.status === "expected";
      action = confirming ? "confirm_expected" : "update";
      updated++;
      row = {
        ...existing,
        organizer_id: existing.organizer_id ?? organizerId,
        title: merged.title,
        summary: merged.summary ?? existing.summary,
        outing_type: merged.outing_type,
        audience: merged.audience,
        audience_note: merged.audience_note ?? existing.audience_note,
        start_date: merged.start_date,
        end_date: merged.end_date,
        shotgun_time: merged.shotgun_time ?? (confirming ? null : existing.shotgun_time),
        format: merged.format ?? existing.format,
        single_price_cents: merged.single_price_cents ?? existing.single_price_cents,
        foursome_price_cents: merged.foursome_price_cents ?? existing.foursome_price_cents,
        sponsor_only: merged.sponsor_only,
        includes: merged.includes !== "[]" ? merged.includes : existing.includes,
        handicap_required: merged.handicap_required ?? existing.handicap_required,
        status: merged.status,
        expected_month: null,
        expected_misses: 0,
        registration_url: merged.registration_url ?? existing.registration_url,
        canonical_source_url: organizerPage || confirming ? canonical : existing.canonical_source_url,
        source_gone: 0,
        confidence: merged.confidence,
        hold_reason: existing.hold_reason === "removed" ? "removed" : null,
        last_verified: nowIso,
        updated_at: nowIso,
      };
    } else {
      action = "insert";
      inserted++;
      const slug = outingSlug(Number(start.slice(0, 4)), merged.title, top.match.course_name, outingSlugs);
      outingSlugs.add(slug);
      row = {
        id: stableId("out", nowMs, `${courseId}|${start}|${organizerId ?? merged.title.toLowerCase()}`),
        slug,
        course_id: courseId,
        organizer_id: organizerId,
        ...merged,
        expected_month: null,
        canonical_source_url: canonical,
        source_gone: 0,
        published: 0,
        hold_reason: null,
        expected_misses: 0,
        next_outing_id: null,
        first_seen: nowIso,
        last_verified: nowIso,
        updated_at: nowIso,
      };
    }
    outingRows.push(row);
    evs.forEach((e, i) => {
      outcomes.push({
        source_url: e.source_url,
        event_index: e.event_index,
        action: i === 0 ? action : "merge",
        outing_id: row.id,
        hold_reason: null,
      });
      links.push({ source_id: sourceIdOf(e.source_url), outing_id: row.id });
    });
  }

  // Sources -------------------------------------------------------------------
  const sourceRows = new Map<string, SourceRow>();
  const baseSource = (url: string, kind: SourceKind): SourceRow =>
    sourceByUrl.get(url) ?? {
      id: sourceIdForUrl(url),
      url,
      domain: sourceDomain(url),
      kind,
      fetched_at: null,
      http_status: null,
      consecutive_gone: 0,
      content_hash: null,
      extracted_json: null,
      extractor_version: null,
      hold_reason: null,
      held_until: null,
      error: null,
    };
  for (const f of input.fetches) {
    const prev = sourceRows.get(f.url) ?? baseSource(f.url, f.kind);
    const gone = f.outcome === "not_found" || f.outcome === "gone" || f.http_status === 404 || f.http_status === 410;
    const ok = f.outcome === "ok" || f.outcome === "not_modified";
    sourceRows.set(f.url, {
      ...prev,
      fetched_at: nowIso,
      http_status: f.http_status !== null && f.http_status >= 100 && f.http_status <= 599 ? f.http_status : prev.http_status,
      consecutive_gone: gone ? prev.consecutive_gone + 1 : ok ? 0 : prev.consecutive_gone,
      content_hash: f.hash ?? prev.content_hash,
      extracted_json: f.extracted_json ?? prev.extracted_json,
      extractor_version: f.extracted_json !== null ? EXTRACTOR_VERSION : prev.extractor_version,
      error: f.error,
    });
  }
  const eventsBySource = new Map<string, MatchedOuting[]>();
  for (const e of live) eventsBySource.set(e.source_url, [...(eventsBySource.get(e.source_url) ?? []), e]);
  for (const e of input.outings)
    if (!eventsBySource.has(e.source_url)) eventsBySource.set(e.source_url, []);
  const heldBySource = new Map<string, HoldReason>();
  for (const o of outcomes)
    if (o.action === "held" && o.hold_reason && !heldBySource.has(o.source_url))
      heldBySource.set(o.source_url, o.hold_reason);
  for (const [url, evs] of eventsBySource) {
    const kind = evs[0]?.source_kind ?? input.outings.find((e) => e.source_url === url)?.source_kind ?? "organizer";
    const prev = sourceRows.get(url) ?? baseSource(url, kind);
    const hold = heldBySource.get(url) ?? null;
    sourceRows.set(url, { ...prev, hold_reason: hold, held_until: hold ? heldUntil : null });
  }

  // Plan ----------------------------------------------------------------------
  const ops: TableOp[] = [];
  if (newOrganizers.length > 0) ops.push({ op: "upsert", table: "organizers", rows: newOrganizers });
  ops.push(...organizerUpdates);
  if (sourceRows.size > 0) ops.push({ op: "upsert", table: "sources", rows: [...sourceRows.values()] });
  if (outingRows.length > 0) ops.push({ op: "upsert", table: "outings", rows: outingRows });
  if (links.length > 0) {
    const seen = new Set<string>();
    const rows = links.filter((l) => {
      const k = `${l.source_id}|${l.outing_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    ops.push({ op: "upsert", table: "source_outings", rows, update: [] });
  }
  for (const u of input.unchanged) {
    ops.push({ op: "update", table: "outings", set: { last_verified: nowIso }, where: { canonical_source_url: u.url } });
    if (u.recheck_outing_id)
      ops.push({ op: "update", table: "outings", set: { last_verified: nowIso }, where: { id: u.recheck_outing_id } });
  }
  const plan = parseUpsertPlan({ ops });

  const held = outcomes.filter((o) => o.action === "held").length;
  const excluded = outcomes.filter((o) => o.action === "excluded").length;
  result.counters.outings_new = inserted;
  result.counters.outings_updated = updated;
  result.counters.outings_held = held;
  if (excluded > 0) result.counters.events_excluded = excluded;
  for (const o of outcomes)
    if (o.action === "held" && o.hold_reason)
      result.holds.push({ scope: "source", key: o.source_url, reason: o.hold_reason, event_index: o.event_index });
  if (lifted.size > 0) ctx.log.info("held events confirmed by a second source", { count: lifted.size });
  return { output: { plan, outcomes }, result };
};
