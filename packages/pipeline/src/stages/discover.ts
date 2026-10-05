import { localToday } from "@gof/shared/dates";
import { blockedAsSource } from "../discovery/platform-policy.ts";
import { normalizeUrl, hostOf } from "../discovery/url.ts";
import { isExcludedUrl } from "../overrides/load.ts";
import {
  emptyResult,
  foundViaSchema,
  type BudgetHit,
  type DiscoverOutput,
  type DiscoverStage,
  type FoundVia,
  type QueueEntry,
  type RecheckCandidate,
  type SearchPlanStage,
  type SerpQuery,
} from "./types.ts";
import type { SourceKind } from "./rows.ts";

/**
 * SPEC.md 8.2, workstream B.
 *
 * `planSearch` picks tonight's SERP queries (place queries weekly April to
 * September and monthly otherwise, spread evenly across nights; course queries
 * monthly) within `allowance.MAX_SERP_QUERIES_PER_RUN`.
 *
 * `discover` merges recheck candidates (at most 40% of MAX_FETCHES_PER_RUN,
 * oldest last_verified first), submissions, listing links, SERP results, held
 * sources and due `discovery_queue` rows into the fetch queue: normalized URLs,
 * exclusions.yaml applied, the 7-day dedupe except for series pages and
 * rechecks, one entry per URL (the highest priority wins), lowest priority
 * number first.
 */

const DAY_MS = 86_400_000;
const STAGE = "discover";

/** Lower is fetched first. `discovery_queue.priority` stores the same numbers. */
export const PRIORITY: Readonly<Record<FoundVia, number>> = Object.freeze({
  recheck: 1,
  submission: 2,
  series: 3,
  held_retry: 4,
  platform: 5,
  association: 5,
  directory: 6,
  search_course: 7,
  search_place: 8,
});

/** SPEC.md 8.2 item 1: rechecks use at most this share of MAX_FETCHES_PER_RUN. */
export const RECHECK_SHARE = 0.4;
/** The discovery dedupe window. */
export const RECENT_DAYS = 7;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function hit(cap: BudgetHit["cap"], limit: number, at: Date, detail: string): BudgetHit {
  return { stage: STAGE, cap, limit, at: at.toISOString(), detail };
}

// ---------------------------------------------------------------------------
// planSearch
// ---------------------------------------------------------------------------

function daysInMonthUtc(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Place queries: weekly from April through September (metro i runs on nights
 * where dayNumber % 7 == i % 7), monthly otherwise (on day-of-month
 * i % daysInMonth + 1). Course queries: monthly the same way, for courses with
 * outings or flagged notable, ordered by id so each keeps its night.
 */
export const planSearch: SearchPlanStage = (ctx, input) => {
  const result = emptyResult();
  const now = ctx.now;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  // SPEC.md 8.2 as amended 2026-10-03: the coming season. From September 1 the
  // year-bearing templates also run with next year; from December 1 only with it.
  const years = month >= 11 ? [year + 1] : month >= 8 ? [year, year + 1] : [year];
  const monthName = MONTHS[month] ?? "";
  const dayNumber = Math.floor(now.getTime() / DAY_MS);
  const dom = now.getUTCDate() - 1;
  const days = daysInMonthUtc(now);
  const weekly = month >= 3 && month <= 8;

  const priority = (input.prioritize_states ?? []).map((s) => s.toUpperCase());
  const rank = (state: string | null | undefined): number => {
    const i = state ? priority.indexOf(state.toUpperCase()) : -1;
    return i < 0 ? priority.length : i;
  };
  // Prioritized states first (in the order given; metros before courses within
  // a state), then tonight's regular schedule. The cap below cuts from the end.
  const planned: { rank: number; seq: number; queries: SerpQuery[] }[] = [];
  let seq = 0;
  input.metros.forEach((m, i) => {
    const r = rank(m.state);
    const tonight = weekly ? i % 7 === dayNumber % 7 : i % days === dom;
    if (!tonight && r === priority.length) return;
    const city = `${m.name} ${m.state}`;
    const subject = `${m.name}, ${m.state}`;
    planned.push({
      rank: r,
      seq: seq++,
      queries: [
        ...years.map((y): SerpQuery => ({ kind: "place", q: `golf outing ${city} ${y}`, subject })),
        ...years.map((y): SerpQuery => ({ kind: "place", q: `charity golf tournament ${city} ${y}`, subject })),
        { kind: "place", q: `golf scramble ${city} ${monthName}`, subject },
      ],
    });
  });
  const eligible = input.courses
    .filter((c) => c.outing_count > 0 || c.notable)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  eligible.forEach((c, i) => {
    const r = rank(c.state);
    if (i % days !== dom && r === priority.length) return;
    const name = c.name.replace(/"/g, "");
    planned.push({
      rank: r,
      seq: seq++,
      queries: [
        ...years.map((y): SerpQuery => ({ kind: "course", q: `"${name}" golf outing ${y}`, subject: c.id })),
        { kind: "course", q: `"${name}" golf classic register`, subject: c.id },
      ],
    });
  });
  planned.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  const queries: SerpQuery[] = planned.flatMap((p) => p.queries);

  const cap = input.allowance.MAX_SERP_QUERIES_PER_RUN ?? ctx.caps.MAX_SERP_QUERIES_PER_RUN;
  if (queries.length > cap) {
    result.budgetHits.push(
      hit("MAX_SERP_QUERIES_PER_RUN", cap, now, `${queries.length - cap} queries left for later`),
    );
    queries.length = cap;
  }
  return { output: { queries }, result };
};

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

const GOLF = /golf(?!\s*lesson)/i;
const OUTING_WORD = /\b(outings?|tournaments?|scrambles?|classics?|invitationals?)\b/i;
const NOT_GOLF = /\b(mini[\s-]?golf|miniature golf|putt[\s-]?putt|disc golf|foot ?golf|topgolf)\b/i;

/**
 * SPEC.md 8.2 item 4: the title or text mentions golf together with outing,
 * tournament, scramble, classic or invitational. URL slugs count as text.
 */
export function isGolfOutingText(text: string): boolean {
  const t = text.replace(/[-_/+]+/g, " ");
  if (NOT_GOLF.test(t)) return false;
  return /\bgolf/i.test(t) && GOLF.test(t) && OUTING_WORD.test(t);
}

function slugWords(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(`${u.pathname} ${u.search}`);
  } catch {
    return url;
  }
}

/** Days from course-local today to `startDate` (both YYYY-MM-DD). */
function daysUntil(startDate: string, today: string): number {
  return Math.round((Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** SPEC.md 8.2 item 1 and 8.9: 7 days when more than 30 days out, else 48 hours. */
export function recheckDue(c: RecheckCandidate, now: Date): boolean {
  let today: string;
  try {
    today = localToday(now.getTime(), c.time_zone);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  const out = daysUntil(c.start_date, today);
  if (out < 0) return false;
  const age = now.getTime() - Date.parse(c.last_verified);
  return age >= (out > 30 ? 7 * DAY_MS : 2 * DAY_MS);
}

interface Candidate {
  rawUrl: string;
  found_via: FoundVia;
  kind: SourceKind;
  priority: number;
  bypass: boolean;
  recheck_outing_id: string | null;
  directory_host: string | null;
}

function kindFor(via: FoundVia): SourceKind {
  switch (via) {
    case "submission":
      return "submission";
    case "series":
      return "series";
    case "platform":
      return "platform";
    case "association":
      return "association";
    case "directory":
      return "directory";
    case "search_place":
    case "search_course":
      return "search";
    case "recheck":
    case "held_retry":
      return "organizer";
  }
}

/** Routes whose listing adapter already applied platforms.yaml (sources.ts skips `allowed: false`). */
const ADAPTER_ROUTES: ReadonlySet<FoundVia> = new Set(["platform", "association", "directory"]);

export const discover: DiscoverStage = (ctx, input) => {
  const result = emptyResult();
  const now = ctx.now;
  const nowMs = now.getTime();
  const skipped: DiscoverOutput["skipped"] = [];
  const candidates: Candidate[] = [];
  const add = (c: Omit<Candidate, "kind" | "priority" | "bypass"> & Partial<Candidate>): void => {
    candidates.push({
      kind: c.kind ?? kindFor(c.found_via),
      priority: c.priority ?? PRIORITY[c.found_via],
      bypass: c.bypass ?? (c.found_via === "recheck" || c.found_via === "series"),
      ...c,
    });
  };

  // 1. Recheck queue: due rows, oldest last_verified first, at most 40% of the fetch cap.
  const recheckCap = Math.min(
    Math.floor(RECHECK_SHARE * ctx.caps.MAX_FETCHES_PER_RUN),
    input.allowance.MAX_FETCHES_PER_RUN ?? ctx.caps.MAX_FETCHES_PER_RUN,
  );
  const due = input.recheck
    .filter((c) => recheckDue(c, now))
    .sort((a, b) => Date.parse(a.last_verified) - Date.parse(b.last_verified));
  const recheckUrls = new Set<string>();
  for (const c of due) {
    const url = normalizeUrl(c.url) ?? c.url;
    if (recheckUrls.has(url)) continue; // one fetch refreshes every outing on the page
    if (recheckUrls.size >= recheckCap) {
      result.budgetHits.push(
        hit(
          "MAX_FETCHES_PER_RUN",
          recheckCap,
          now,
          `recheck share (${RECHECK_SHARE * 100}%) reached; ${due.length - recheckUrls.size} due rechecks wait`,
        ),
      );
      break;
    }
    recheckUrls.add(url);
    add({
      rawUrl: c.url,
      found_via: "recheck",
      kind: c.source_kind ?? "organizer",
      recheck_outing_id: c.outing_id,
      directory_host: null,
    });
  }

  // 2. Submissions: each one is consumed whatever happens to its URL.
  const processedSubmissionIds: string[] = [];
  for (const s of input.submissions) {
    processedSubmissionIds.push(s.id);
    add({ rawUrl: s.url, found_via: "submission", recheck_outing_id: null, directory_host: null });
  }

  // 3 to 6. Series, platforms, association calendars, directories.
  for (const l of input.listings) {
    if (l.found_via === "platform") {
      const text = [l.title ?? "", l.text ?? "", slugWords(l.url)].join(" ");
      if (!isGolfOutingText(text)) {
        skipped.push({ url: normalizeUrl(l.url) ?? l.url, reason: "not_golf" });
        continue;
      }
    }
    if (l.found_via === "directory") {
      const directoryHost = hostOf(l.url);
      add({ rawUrl: l.url, found_via: "directory", recheck_outing_id: null, directory_host: directoryHost });
      if (l.registration_url) {
        add({
          rawUrl: l.registration_url,
          found_via: "directory",
          kind: "organizer",
          recheck_outing_id: null,
          directory_host: null,
        });
      }
      continue;
    }
    add({
      rawUrl: l.url,
      found_via: l.found_via,
      ...(l.kind ? { kind: l.kind } : {}),
      recheck_outing_id: null,
      directory_host: null,
    });
  }

  // Held sources waiting for a second source.
  for (const h of input.heldSources) {
    add({
      rawUrl: h.url,
      found_via: "held_retry",
      kind: h.kind ?? "organizer",
      recheck_outing_id: null,
      directory_host: null,
    });
  }

  // 7 and 8. Search results.
  for (const r of input.serpResults) {
    add({
      rawUrl: r.url,
      found_via: r.query.kind === "course" ? "search_course" : "search_place",
      recheck_outing_id: null,
      directory_host: null,
    });
  }

  // Rows already in discovery_queue: due ones run again, the rest only block duplicates.
  const waiting = new Set<string>();
  for (const p of input.pending ?? []) {
    const via = foundViaSchema.safeParse(p.found_via);
    const url = normalizeUrl(p.url);
    if (!via.success || url === null) {
      skipped.push({ url: p.url, reason: "invalid" });
      continue;
    }
    const isDue = p.next_attempt_at === null || Date.parse(p.next_attempt_at) <= nowMs;
    if (!isDue) {
      waiting.add(url);
      continue;
    }
    add({
      rawUrl: url,
      found_via: via.data,
      priority: p.priority,
      recheck_outing_id: null,
      directory_host: null,
    });
  }

  // Normalize, exclude, apply the 7-day rule, and keep one entry per URL.
  const recent = new Set<string>();
  for (const r of input.recentlyFetched) {
    if (nowMs - Date.parse(r.fetched_at) < RECENT_DAYS * DAY_MS) {
      recent.add(normalizeUrl(r.url) ?? r.url);
    }
  }
  const byUrl = new Map<string, QueueEntry>();
  const order: string[] = [];
  for (const c of candidates) {
    const url = normalizeUrl(c.rawUrl);
    if (url === null) {
      skipped.push({ url: c.rawUrl.slice(0, 2048), reason: "invalid" });
      continue;
    }
    if (isExcludedUrl(url, ctx.overrides.exclusions)) {
      skipped.push({ url, reason: "excluded" });
      continue;
    }
    // platforms.yaml applies to every route (SPEC.md 8.2): search results, series
    // links, submissions, rechecks, held retries and leftover queue rows never
    // reach a platform or directory with allowed: false, or any listing page.
    // The platform, association and directory adapters check `allowed` themselves.
    if (input.platform_rules && !ADAPTER_ROUTES.has(c.found_via)) {
      const v = blockedAsSource(url, input.platform_rules);
      if (v) {
        skipped.push({ url, reason: v.allowed ? "platform_listing" : "platform_not_allowed" });
        continue;
      }
    }
    const existing = byUrl.get(url);
    if (existing) {
      if (c.priority < existing.priority) {
        byUrl.set(url, {
          ...existing,
          found_via: c.found_via,
          kind: c.kind,
          priority: c.priority,
          recheck_outing_id: c.recheck_outing_id ?? existing.recheck_outing_id,
          directory_host: c.directory_host ?? existing.directory_host,
          bypass_dedupe: existing.bypass_dedupe || c.bypass,
        });
      }
      skipped.push({ url, reason: "duplicate" });
      continue;
    }
    if (waiting.has(url)) {
      skipped.push({ url, reason: "duplicate" });
      continue;
    }
    if (!c.bypass && recent.has(url)) {
      skipped.push({ url, reason: "recent" });
      continue;
    }
    byUrl.set(url, {
      url,
      found_via: c.found_via,
      kind: c.kind,
      priority: c.priority,
      bypass_dedupe: c.bypass,
      recheck_outing_id: c.recheck_outing_id,
      directory_host: c.directory_host,
    });
    order.push(url);
  }

  const rank = new Map(order.map((u, i) => [u, i] as const));
  const queue = [...byUrl.values()].sort(
    (a, b) => a.priority - b.priority || (rank.get(a.url) ?? 0) - (rank.get(b.url) ?? 0),
  );
  result.counters.urls_enqueued = queue.length;
  return { output: { queue, skipped, processedSubmissionIds }, result };
};
