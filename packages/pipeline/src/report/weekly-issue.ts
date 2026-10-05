import { z } from "zod";
import type { D1Target } from "../d1/port.ts";
import { sqlValue } from "../sql/literal.ts";
import { holdsTable, mdCell, parseBudgetHits, parseStageErrors, usd } from "../stages/report.ts";
import type { RunRow } from "../stages/rows.ts";
import {
  RUN_COUNTERS,
  type BudgetHit,
  type ReportInput,
  type RunCounter,
  type StageErrorKind,
} from "../stages/types.ts";

/**
 * The weekly report issue (SPEC.md 8.10): every Monday, one GitHub issue titled
 * "Weekly pipeline report" is created or updated with the week's counts, holds
 * by reason and estimated cost. Everything here is pure: the decision, the SQL,
 * the aggregation and the Markdown. run/weekly.ts reads D1 and calls GitHub.
 */

export const WEEKLY_ISSUE_TITLE = "Weekly pipeline report";
/** The label the issue is created with and found by (a title match is the fallback). */
export const WEEKLY_ISSUE_LABEL = "pipeline-report";
export const WEEK_MS = 7 * 86_400_000;
/** GitHub rejects issue bodies over 65,536 characters. */
export const MAX_ISSUE_BODY = 60_000;
const MAX_FAILURES_SHOWN = 20;

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

export interface WeeklyDecisionInput {
  mode: "dry-run" | "live";
  job: "nightly" | "monthly";
  /** The run's clock (ctx.now). */
  now: Date;
  /** `--weekly-report`: post (or render) on any day. */
  force: boolean;
  d1Target: D1Target;
  token: string | undefined;
  repo: string | undefined;
}

export interface WeeklyDecision {
  action: "post" | "render" | "skip";
  reason: string;
}

/**
 * Monday by the run's UTC date, from the nightly job only. A dry run renders
 * the body and never touches the network. A live run posts only against the
 * production (remote) D1 with GH_TOKEN and GITHUB_REPOSITORY set, so a local
 * run never writes the public issue.
 */
export function decideWeekly(i: WeeklyDecisionInput): WeeklyDecision {
  if (i.job !== "nightly") return { action: "skip", reason: "the monthly job doesn't report weekly" };
  const monday = i.now.getUTCDay() === 1;
  if (!monday && !i.force) return { action: "skip", reason: "not Monday (UTC)" };
  const why = i.force ? "--weekly-report" : "Monday";
  if (i.mode === "dry-run") return { action: "render", reason: "dry run: rendered, not posted" };
  if (i.d1Target !== "remote") return { action: "skip", reason: `the ${i.d1Target} D1 is not production` };
  if (!i.token || !i.repo) return { action: "skip", reason: "GH_TOKEN or GITHUB_REPOSITORY is not set" };
  return { action: "post", reason: why };
}

// ---------------------------------------------------------------------------
// What: SQL over the run's D1
// ---------------------------------------------------------------------------

/** The runs started in the 7 days up to `now` (the current run included). */
export function weeklyRunsSql(now: Date): string {
  const from = new Date(now.getTime() - WEEK_MS).toISOString();
  return `SELECT * FROM runs WHERE started_at > ${sqlValue(from)} AND started_at <= ${sqlValue(now.toISOString())} ORDER BY started_at, id`;
}

export const monthSpendRowSchema = z.object({ cents: z.number().int().min(0) });

/** Estimated spend over this calendar month's runs (the MONTHLY_SPEND_CAP_CENTS sum). */
export function monthSpendSql(now: Date): string {
  return `SELECT coalesce(sum(est_cost_cents), 0) AS cents FROM runs WHERE substr(started_at, 1, 7) = ${sqlValue(now.toISOString().slice(0, 7))}`;
}

export const publishedCountsSchema = z.object({
  published: z.number().int().min(0),
  upcoming: z.number().int().min(0),
  expected: z.number().int().min(0),
  upcoming_states: z.number().int().min(0),
});
export type PublishedCounts = z.infer<typeof publishedCountsSchema>;

/**
 * Published outings now: upcoming dated ones (last day today or later, by the
 * UTC date) and the states they're in, and expected ones (Phase 2's
 * "2,000 upcoming outings in 30 states" check).
 */
export function publishedCountsSql(now: Date): string {
  const today = sqlValue(now.toISOString().slice(0, 10));
  const upcoming = `o.status IN ('open', 'waitlist', 'sold_out', 'cancelled') AND coalesce(o.end_date, o.start_date) >= ${today}`;
  return (
    `SELECT count(*) AS published, ` +
    `coalesce(sum(CASE WHEN ${upcoming} THEN 1 ELSE 0 END), 0) AS upcoming, ` +
    `coalesce(sum(CASE WHEN o.status = 'expected' THEN 1 ELSE 0 END), 0) AS expected, ` +
    `count(DISTINCT CASE WHEN ${upcoming} THEN c.state END) AS upcoming_states ` +
    `FROM outings o JOIN courses c ON c.id = o.course_id WHERE o.published = 1`
  );
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface WeekFailure {
  run_id: string;
  started_at: string;
  stage: string;
  kind: StageErrorKind;
  message: string;
}

export interface WeekSummary {
  from: string;
  to: string;
  runs: { total: number; nightly: number; monthly: number; failed: number; unfinished: number };
  totals: Record<RunCounter, number>;
  est_cost_cents: number;
  /** Each cap hit, with how many runs hit it, in order of first hit. */
  budget_hits: { cap: BudgetHit["cap"]; runs: number }[];
  /** Stored errors by kind, stubs left out. */
  errors_by_kind: Partial<Record<StageErrorKind, number>>;
  /** Stages that threw (internal) or were forced to (--fail-stage). */
  failures: WeekFailure[];
}

const FAILURE_KINDS: ReadonlySet<StageErrorKind> = new Set(["internal", "forced"]);

export function aggregateWeek(runs: readonly RunRow[], now: Date): WeekSummary {
  const totals = Object.fromEntries(RUN_COUNTERS.map((c) => [c, 0])) as Record<RunCounter, number>;
  const hitRuns = new Map<BudgetHit["cap"], number>();
  const errorsByKind: Partial<Record<StageErrorKind, number>> = {};
  const failures: WeekFailure[] = [];
  const counts = { total: 0, nightly: 0, monthly: 0, failed: 0, unfinished: 0 };
  let cost = 0;

  for (const r of runs) {
    counts.total++;
    counts[r.kind]++;
    if (r.finished_at === null) counts.unfinished++;
    for (const c of RUN_COUNTERS) totals[c] += r[c];
    cost += r.est_cost_cents;
    for (const cap of new Set(parseBudgetHits(r.budget_hits).map((h) => h.cap)))
      hitRuns.set(cap, (hitRuns.get(cap) ?? 0) + 1);
    let failed = false;
    for (const e of parseStageErrors(r.errors)) {
      if (e.kind === "not_implemented") continue;
      errorsByKind[e.kind] = (errorsByKind[e.kind] ?? 0) + 1;
      if (FAILURE_KINDS.has(e.kind)) {
        failed = true;
        failures.push({ run_id: r.id, started_at: r.started_at, stage: e.stage, kind: e.kind, message: e.message });
      }
    }
    if (failed) counts.failed++;
  }

  return {
    from: new Date(now.getTime() - WEEK_MS).toISOString(),
    to: now.toISOString(),
    runs: counts,
    totals,
    est_cost_cents: cost,
    budget_hits: [...hitRuns].map(([cap, n]) => ({ cap, runs: n })),
    errors_by_kind: errorsByKind,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface WeeklyIssueInput {
  week: WeekSummary;
  holds: ReportInput["holds"];
  published: PublishedCounts;
  month: { spent_cents: number; cap_cents: number };
  /** The run that wrote this version. */
  runId: string;
  now: Date;
}

/** The issue body. Error text is made inert (mdCell); it can carry scraped URLs. */
export function renderWeeklyIssue(i: WeeklyIssueInput): string {
  const { week } = i;
  const lines: string[] = [];
  lines.push(`## ${WEEKLY_ISSUE_TITLE}`);
  lines.push("");
  lines.push(
    `Week of ${week.from.slice(0, 10)} to ${week.to.slice(0, 10)} (runs started after ${week.from}). ` +
      `Updated by run \`${mdCell(i.runId)}\` at ${i.now.toISOString()}; this body is replaced every Monday.`,
  );
  lines.push("");

  lines.push("### Runs");
  lines.push("");
  lines.push("| | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Runs | ${week.runs.total} (${week.runs.nightly} nightly, ${week.runs.monthly} monthly) |`);
  lines.push(`| Failed (a stage threw) | ${week.runs.failed} |`);
  lines.push(`| Unfinished (killed or still running) | ${week.runs.unfinished} |`);
  lines.push("");

  lines.push("### Counts this week");
  lines.push("");
  lines.push("| Counter | Value |");
  lines.push("| --- | --- |");
  for (const c of RUN_COUNTERS) lines.push(`| ${c} | ${week.totals[c]} |`);
  lines.push("");
  const p = i.published;
  lines.push(
    `Outings on the site now: ${p.published} published (${p.upcoming} upcoming in ${p.upcoming_states} states, ${p.expected} expected).`,
  );
  lines.push("");

  lines.push("### Holds by reason");
  lines.push("");
  lines.push(...holdsTable(i.holds));
  lines.push("");

  lines.push("### Budget hits");
  lines.push("");
  if (week.budget_hits.length === 0) lines.push("None.");
  for (const h of week.budget_hits) lines.push(`- \`${h.cap}\` in ${h.runs} run${h.runs === 1 ? "" : "s"}`);
  lines.push("");

  lines.push("### Errors");
  lines.push("");
  const kinds = Object.entries(week.errors_by_kind);
  if (kinds.length === 0) lines.push("None.");
  else lines.push(kinds.map(([k, n]) => `${k}: ${n}`).join(", ") + ".");
  if (week.failures.length > 0) {
    lines.push("");
    lines.push("Stages that failed:");
    for (const f of week.failures.slice(-MAX_FAILURES_SHOWN))
      lines.push(`- \`${mdCell(f.run_id)}\` (${f.started_at.slice(0, 10)}) ${mdCell(f.stage)} (${f.kind}): ${mdCell(f.message)}`);
    if (week.failures.length > MAX_FAILURES_SHOWN)
      lines.push(`- ... and ${week.failures.length - MAX_FAILURES_SHOWN} earlier`);
  }
  lines.push("");

  lines.push("### Estimated cost");
  lines.push("");
  lines.push(`Estimated cost this week: ${usd(week.est_cost_cents)}.`);
  const pct = i.month.cap_cents > 0 ? Math.round((100 * i.month.spent_cents) / i.month.cap_cents) : 0;
  lines.push(
    `This month so far: ${usd(i.month.spent_cents)} of the ${usd(i.month.cap_cents)} cap (MONTHLY_SPEND_CAP_CENTS), ${pct}%.`,
  );
  lines.push(
    "Estimated from token and query counts at API prices; runs on the Claude subscription (claude-cli, claude-search) are billed there.",
  );
  lines.push("");

  const body = lines.join("\n");
  return body.length <= MAX_ISSUE_BODY ? body : `${body.slice(0, MAX_ISSUE_BODY)}\n\n(truncated)\n`;
}
