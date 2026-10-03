import { addMonths, isPast, localToday, monthOf, rollForwardMonth } from "@gof/shared/dates";
import { withCollisionSuffix } from "@gof/shared/slug";
import { stableId } from "../extract/ids.ts";
import {
  emptyResult,
  parseUpsertPlan,
  type OutingRow,
  type RecheckRollForwardStage,
  type SourceRow,
  type TableOp,
} from "./types.ts";

/** SPEC.md 8.9: this many consecutive 404/410 responses mark the source gone. */
export const GONE_AFTER = 2;

const DATED: ReadonlySet<OutingRow["status"]> = new Set(["open", "waitlist", "sold_out", "cancelled"]);

function monthGap(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return Math.abs(ay * 12 + am - (by * 12 + bm));
}

/** Next year's slug: same path under the next year, `-2`, `-3` on collision. */
export function rolledSlug(slug: string, nextYear: number, taken: ReadonlySet<string>): string {
  const rest = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  return withCollisionSuffix(`${nextYear}/${rest}`, taken);
}

/** "Fordham Golf Classic 2026" becomes "Fordham Golf Classic 2027"; titles without the year stay. */
export function rolledTitle(title: string, year: number): string {
  return title.replace(new RegExp(`\\b${year}\\b`, "g"), String(year + 1));
}

function alive(s: SourceRow | undefined): boolean {
  return s !== undefined && s.consecutive_gone === 0 && s.http_status !== null && s.http_status < 400;
}

/**
 * SPEC.md 8.9 as amended, workstream C.
 *
 * - source_gone = 1 when the canonical source has had two consecutive 404/410
 *   responses and no other linked source is alive; when another is, it becomes
 *   the canonical source instead. A recovered source clears the flag.
 * - A dated outing becomes `past` the day after `end_date ?? start_date`,
 *   course-local.
 * - Roll forward: a past outing with a known organizer gets an expected row for
 *   the same course and organizer with expected_month = month of (start_date +
 *   1 calendar year), linked through `next_outing_id`. When a row for that
 *   course and organizer already sits within a month of it (expected or
 *   confirmed), the link goes there instead. Confirming an expected row in place
 *   when a dated outing arrives happens in dedupe-upsert.
 * - Expected rows unconfirmed when expected_month + 1 month has passed move 12
 *   months once (expected_misses = 1); the second miss unpublishes them with
 *   hold_reason `expected_stale`.
 */
export const recheckRollForward: RecheckRollForwardStage = (ctx, input) => {
  const result = emptyResult();
  const nowMs = ctx.now.getTime();
  const nowIso = ctx.now.toISOString();
  const sources = new Map(input.sources.map((s) => [s.url, s]));
  const taken = new Set(input.outingSlugs);
  const all = input.outings.map((x) => x.outing);

  const inserts: OutingRow[] = [];
  const updates: TableOp[] = [];
  const links: TableOp[] = [];
  const past: string[] = [];
  const rolledForward: { from: string; to: string }[] = [];
  const expectedBumped: string[] = [];
  const expectedStale: string[] = [];
  const sourceGone: string[] = [];

  for (const { outing: o, time_zone, source_urls } of input.outings) {
    const set: Partial<OutingRow> = {};
    const thisMonth = monthOf(localToday(nowMs, time_zone));

    // source_gone --------------------------------------------------------------
    const canon = sources.get(o.canonical_source_url);
    const canonGone = canon !== undefined && canon.consecutive_gone >= GONE_AFTER;
    if (canonGone) {
      const other = source_urls.find((u) => u !== o.canonical_source_url && alive(sources.get(u)));
      if (other) {
        set.canonical_source_url = other;
        if (o.source_gone === 1) set.source_gone = 0;
      } else if (o.source_gone === 0) {
        set.source_gone = 1;
        sourceGone.push(o.id);
      }
    } else if (o.source_gone === 1 && alive(canon)) {
      set.source_gone = 0;
    }

    // past ---------------------------------------------------------------------
    let isNowPast = o.status === "past";
    if (DATED.has(o.status) && o.start_date !== null && isPast(o.start_date, o.end_date, nowMs, time_zone)) {
      set.status = "past";
      isNowPast = true;
      past.push(o.id);
    }

    // roll forward -------------------------------------------------------------
    if (isNowPast && o.next_outing_id === null && o.organizer_id !== null && o.start_date !== null) {
      const month = rollForwardMonth(o.start_date);
      const already = all.find(
        (x) =>
          x.id !== o.id &&
          x.course_id === o.course_id &&
          x.organizer_id === o.organizer_id &&
          ((x.status === "expected" && x.expected_month !== null && monthGap(x.expected_month, month) <= 1) ||
            (DATED.has(x.status) && x.start_date !== null && monthGap(monthOf(x.start_date), month) <= 1)),
      ) ?? inserts.find((x) => x.course_id === o.course_id && x.organizer_id === o.organizer_id && x.expected_month === month);
      if (already) {
        set.next_outing_id = already.id;
      } else if (addMonths(month, 1) < thisMonth) {
        // Next year's date has gone by too; an expected row would be stale at once.
        ctx.log.info("roll forward skipped: next edition already past", { outing_id: o.id, month });
      } else {
        const year = Number(o.start_date.slice(0, 4));
        const slug = rolledSlug(o.slug, year + 1, taken);
        taken.add(slug);
        const row: OutingRow = {
          id: stableId("out", nowMs, `${o.course_id}|${o.organizer_id}|${month}`),
          slug,
          course_id: o.course_id,
          organizer_id: o.organizer_id,
          title: rolledTitle(o.title, year),
          summary: null,
          outing_type: o.outing_type,
          audience: o.audience,
          audience_note: o.audience_note,
          start_date: null,
          end_date: null,
          shotgun_time: null,
          format: null,
          single_price_cents: null,
          foursome_price_cents: null,
          sponsor_only: 0,
          includes: "[]",
          handicap_required: null,
          status: "expected",
          expected_month: month,
          registration_url: null,
          canonical_source_url: set.canonical_source_url ?? o.canonical_source_url,
          source_gone: 0,
          confidence: o.confidence,
          published: 0,
          hold_reason: null,
          expected_misses: 0,
          next_outing_id: null,
          first_seen: nowIso,
          last_verified: nowIso,
          updated_at: nowIso,
        };
        inserts.push(row);
        rolledForward.push({ from: o.id, to: row.id });
        links.push({ op: "update", table: "outings", set: { next_outing_id: row.id }, where: { id: o.id } });
      }
    }

    // expected misses ----------------------------------------------------------
    if (o.status === "expected" && o.expected_month !== null && o.hold_reason !== "expected_stale") {
      if (thisMonth > addMonths(o.expected_month, 1)) {
        if (o.expected_misses === 0) {
          set.expected_month = addMonths(o.expected_month, 12);
          set.expected_misses = 1;
          expectedBumped.push(o.id);
        } else {
          set.published = 0;
          set.hold_reason = "expected_stale";
          set.expected_misses = 2;
          expectedStale.push(o.id);
          result.holds.push({ scope: "outing", key: o.id, reason: "expected_stale" });
        }
      }
    }

    if (Object.keys(set).length > 0) {
      set.updated_at = nowIso;
      updates.push({ op: "update", table: "outings", set, where: { id: o.id } });
    }
  }

  const ops: TableOp[] = [];
  if (inserts.length > 0) ops.push({ op: "upsert", table: "outings", rows: inserts, update: [] });
  ops.push(...updates, ...links);
  if (rolledForward.length > 0) result.counters.outings_new = rolledForward.length;
  const changed = new Set([...past, ...expectedBumped, ...expectedStale, ...sourceGone]).size;
  if (changed > 0) result.counters.outings_updated = changed;
  return {
    output: { plan: parseUpsertPlan({ ops }), past, rolledForward, expectedBumped, expectedStale, sourceGone },
    result,
  };
};
