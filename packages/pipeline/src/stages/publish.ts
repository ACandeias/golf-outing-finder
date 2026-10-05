import { isPast } from "@gof/shared/dates";
import type { HoldReason } from "@gof/shared/schemas";
import { blockedAsSource, platformVerdict, type PlatformRule } from "../discovery/platform-policy.ts";
import { PUBLISH_CONFIDENCE } from "../extract/validate.ts";
import {
  emptyResult,
  parseUpsertPlan,
  type OutingRow,
  type PublishDecision,
  type PublishStage,
  type TableOp,
} from "./types.ts";

/** Statuses that carry Event markup (SPEC.md 8.8, 9.4). */
const EVENT_STATUSES: ReadonlySet<OutingRow["status"]> = new Set([
  "open",
  "waitlist",
  "sold_out",
  "cancelled",
]);

/** The outing page's path; IndexNow resolves it against PUBLIC_SITE_URL (src/indexnow). */
export function outingPath(slug: string): string {
  return `/outings/${slug}`;
}

/** removals.yaml (SPEC.md 8.0): by outing id, or any of the outing's URLs. */
function isRemoved(id: string, urls: readonly string[], removals: { outing_ids: readonly string[]; urls: readonly string[] }): boolean {
  return removals.outing_ids.includes(id) || urls.some((u) => removals.urls.includes(u));
}

interface Verdict {
  publish: boolean;
  hold: HoldReason | null;
  why: string;
}

function decide(
  o: OutingRow,
  timeZone: string,
  nowMs: number,
  removed: boolean,
): Verdict {
  if (removed) return { publish: false, hold: "removed", why: "removed" };
  if (o.status === "expected") {
    if (o.hold_reason === "expected_stale") return { publish: false, hold: "expected_stale", why: "expected_stale" };
    if (o.expected_month === null) return { publish: false, hold: "no_date", why: "no_expected_month" };
    if (o.organizer_id === null) return { publish: false, hold: null, why: "no_organizer" };
    return { publish: true, hold: null, why: "expected" };
  }
  if (o.status === "past") {
    // A past outing's page stays as it was (it links to next year's); it never re-publishes.
    return {
      publish: o.published === 1 && o.hold_reason !== "removed",
      hold: o.hold_reason === "removed" ? null : o.hold_reason,
      why: "past",
    };
  }
  if (o.start_date === null) return { publish: false, hold: "no_date", why: "no_date" };
  if (isPast(o.start_date, o.end_date, nowMs, timeZone)) return { publish: false, hold: null, why: "past_date" };
  if (o.confidence < PUBLISH_CONFIDENCE) return { publish: false, hold: "low_confidence", why: "low_confidence" };
  return { publish: true, hold: null, why: "dated" };
}

/**
 * platforms.yaml at publish (SPEC.md 8.2): an outing whose canonical source is
 * a platform listing or search page never publishes, and neither does one that
 * only pages on a platform or directory with `allowed: false` support.
 */
function platformBlock(
  canonical: string,
  sourceUrls: readonly string[],
  rules: readonly PlatformRule[],
): "platform_listing" | "platform_not_allowed" | null {
  if (platformVerdict(canonical, rules)?.listing) return "platform_listing";
  const pages = [canonical, ...sourceUrls];
  return pages.every((u) => blockedAsSource(u, rules) !== null) ? "platform_not_allowed" : null;
}

/**
 * SPEC.md 8.8 as amended, workstream C. Course is always matched here (outings
 * rows need a course; unmatched events stayed on their source). A dated outing
 * (open, waitlist, sold_out, cancelled) publishes when its last day, course-local,
 * is today or later and confidence is 0.75 or more. An expected outing publishes
 * when its organizer is known and expected_month is set; without expected_month
 * it is held `no_date`. Anything in removals.yaml (by id, canonical or source
 * URL) is unpublished with `removed`. Event markup only for the four dated
 * statuses. IndexNow gets the paths of outings that became published or changed
 * while published.
 */
export const publish: PublishStage = (ctx, input) => {
  const result = emptyResult();
  const nowMs = ctx.now.getTime();
  const changed = new Set(input.changed);
  const decisions: PublishDecision[] = [];
  const ops: TableOp[] = [];
  const indexnowUrls: string[] = [];

  for (const { outing: o, time_zone, source_urls } of input.outings) {
    const removed = isRemoved(o.id, [o.canonical_source_url, ...source_urls], ctx.overrides.removals);
    const base = decide(o, time_zone, nowMs, removed);
    const blocked = base.publish && input.platform_rules ? platformBlock(o.canonical_source_url, source_urls, input.platform_rules) : null;
    const v: Verdict = blocked ? { publish: false, hold: base.hold, why: blocked } : base;
    const published = v.publish ? 1 : 0;
    const ping = v.publish && (o.published === 0 || changed.has(o.id)) && o.status !== "past";
    decisions.push({
      outing_id: o.id,
      publish: v.publish,
      hold_reason: v.hold,
      why: v.why,
      event_markup: EVENT_STATUSES.has(o.status),
      indexnow: ping,
    });
    if (published !== o.published || v.hold !== o.hold_reason)
      ops.push({ op: "update", table: "outings", set: { published, hold_reason: v.hold }, where: { id: o.id } });
    if (ping) indexnowUrls.push(outingPath(o.slug));
    if (v.hold) result.holds.push({ scope: "outing", key: o.id, reason: v.hold });
  }

  if (indexnowUrls.length > 0) result.counters.indexnow_urls = indexnowUrls.length;
  ctx.log.info("publish decisions", {
    published: decisions.filter((d) => d.publish).length,
    held: decisions.filter((d) => d.hold_reason !== null).length,
  });
  return { output: { decisions, plan: parseUpsertPlan({ ops }), indexnowUrls }, result };
};
