import type { D1Port } from "../d1/port.ts";
import { redact } from "../lib/logger.ts";
import { createGitHubIssues, upsertIssue, type FetchLike } from "../report/github-issues.ts";
import {
  aggregateWeek,
  monthSpendRowSchema,
  monthSpendSql,
  publishedCountsSchema,
  publishedCountsSql,
  renderWeeklyIssue,
  WEEKLY_ISSUE_LABEL,
  WEEKLY_ISSUE_TITLE,
  weeklyRunsSql,
} from "../report/weekly-issue.ts";
import { mdCell, parseStageErrors } from "../stages/report.ts";
import { runRowSchema, type RunRow } from "../stages/rows.ts";
import type { Logger, StageError } from "../stages/types.ts";
import { MAX_STORED_ERRORS } from "./accounting.ts";
import { queryHoldCounts } from "./runner.ts";

/**
 * The weekly report issue's edge (SPEC.md 8.10): reads the week from D1 after
 * the run's report, renders it (report/weekly-issue.ts) and creates or updates
 * the GitHub issue. It never throws: a GitHub failure is logged, shown in the
 * job summary and stored as a `report` error on the runs row, and the nightly
 * job's result is left alone, so a GitHub API hiccup never pages the owner for
 * a pipeline that worked. The next Monday's run tries again.
 */

export interface WeeklyReportOptions {
  /** From decideWeekly: post to GitHub, or only render (dry run). */
  action: "post" | "render";
  now: Date;
  runId: string;
  monthlyCapCents: number;
  token: string | undefined;
  repo: string | undefined;
  /** Secret values from the environment, redacted from the body before it is posted. */
  secrets: readonly string[];
}

export interface WeeklyReportDeps {
  d1: D1Port;
  log: Logger;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export type WeeklyReportResult =
  | { status: "posted"; action: "created" | "updated"; number: number; url: string; body: string }
  | { status: "rendered"; body: string }
  | { status: "failed"; error: string; body: string | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function renderBody(o: WeeklyReportOptions, d1: D1Port): Promise<string> {
  const runs = await d1.query(weeklyRunsSql(o.now), runRowSchema);
  const holds = await queryHoldCounts(d1);
  const [spend] = await d1.query(monthSpendSql(o.now), monthSpendRowSchema);
  const [published] = await d1.query(publishedCountsSql(o.now), publishedCountsSchema);
  const body = renderWeeklyIssue({
    week: aggregateWeek(runs, o.now),
    holds,
    published: published ?? { published: 0, upcoming: 0, expected: 0, upcoming_states: 0 },
    month: { spent_cents: spend?.cents ?? 0, cap_cents: o.monthlyCapCents },
    runId: o.runId,
    now: o.now,
  });
  return redact(body, o.secrets);
}

export async function weeklyReport(o: WeeklyReportOptions, deps: WeeklyReportDeps): Promise<WeeklyReportResult> {
  const { log } = deps;
  let body: string | null = null;
  try {
    body = await renderBody(o, deps.d1);
    if (o.action === "render") {
      log.info("weekly report issue: rendered, not posted (dry run)", { chars: body.length });
      return { status: "rendered", body };
    }
    if (!o.token || !o.repo) throw new Error("GH_TOKEN or GITHUB_REPOSITORY is not set");
    const gh = createGitHubIssues({
      token: o.token,
      repo: o.repo,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const r = await upsertIssue(gh, { title: WEEKLY_ISSUE_TITLE, label: WEEKLY_ISSUE_LABEL, body });
    log.info(`weekly report issue #${r.number} ${r.action}`, { url: r.url });
    return { status: "posted", ...r, body };
  } catch (err) {
    const error = redact(message(err), o.secrets);
    log.error("weekly report issue: not posted; the run's result is unchanged", { error });
    return { status: "failed", error, body };
  }
}

/** What the job summary (and stdout) gets after the run report. */
export function weeklySummaryMarkdown(r: WeeklyReportResult): string {
  switch (r.status) {
    case "posted":
      return `\nWeekly report issue #${r.number} ${r.action}: ${mdCell(r.url)}\n`;
    case "rendered":
      return `\n<details><summary>Weekly report issue: not posted (dry run)</summary>\n\n${r.body}\n</details>\n`;
    case "failed":
      return `\n**Weekly report issue: not posted** (${mdCell(r.error)}). The run's result is unchanged; next Monday's run tries again.\n`;
  }
}

/** The runs row with a `report` error for a weekly issue that wasn't posted. */
export function recordWeeklyFailure(row: RunRow, error: string): RunRow {
  const added: StageError = { stage: "report", kind: "network", message: `weekly report issue: ${error}` };
  const errors = [...parseStageErrors(row.errors), added].slice(-MAX_STORED_ERRORS);
  return runRowSchema.parse({ ...row, errors: JSON.stringify(errors) });
}
