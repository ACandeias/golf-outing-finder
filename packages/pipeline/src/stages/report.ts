import { holdReasonSchema } from "@gof/shared/schemas";
import {
  budgetHitSchema,
  emptyResult,
  stageErrorSchema,
  type Counter,
  type ReportStage,
  type StageStatus,
} from "./types.ts";

/** SPEC.md 8.10: fail when more than 20% of fetches error (network and 5xx only). */
export const FETCH_ERROR_RATE_LIMIT = 0.2;

/** Text from runs rows and errors can carry scraped text: keep it inert in Markdown. */
export function mdCell(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .slice(0, 300);
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const STATUS_LABEL: Record<StageStatus["status"], string> = {
  done: "done",
  not_implemented: "not implemented",
  failed: "FAILED",
  skipped: "skipped",
};

/**
 * Builds the run summary for $GITHUB_STEP_SUMMARY and decides whether the job
 * fails: any stage threw, more than 20% of fetches errored, or (with --strict) a
 * stage is still a stub.
 */
export const report: ReportStage = (_ctx, input) => {
  const { run, counters } = input;
  const failures: string[] = [];
  for (const s of input.stages) {
    if (s.status === "failed")
      failures.push(`stage ${s.stage} threw${s.message ? `: ${s.message}` : ""}`);
    if (s.status === "not_implemented" && input.strict)
      failures.push(`stage ${s.stage} is not implemented (--strict)`);
  }
  const fetches = counters.fetches ?? run.fetches;
  const fetchErrors = counters.fetch_errors ?? 0;
  const fetchErrorRate = fetches > 0 ? fetchErrors / fetches : 0;
  if (fetchErrorRate > FETCH_ERROR_RATE_LIMIT) {
    failures.push(
      `${fetchErrors} of ${fetches} fetches failed (${(fetchErrorRate * 100).toFixed(1)}%, limit 20%)`,
    );
  }

  const lines: string[] = [];
  lines.push(`## Pipeline run \`${mdCell(run.id)}\` (${run.kind}, ${input.mode})`);
  lines.push("");
  lines.push(`Started ${run.started_at}${run.finished_at ? `, finished ${run.finished_at}` : ""}.`);
  lines.push(`Estimated cost: ${usd(run.est_cost_cents)}.`);
  lines.push("");
  lines.push("| Stage | Status | Time |");
  lines.push("| --- | --- | --- |");
  for (const s of input.stages) {
    const note = s.message && s.status !== "done" ? ` (${mdCell(s.message)})` : "";
    lines.push(`| ${s.stage} | ${STATUS_LABEL[s.status]}${note} | ${(s.ms / 1000).toFixed(1)} s |`);
  }
  lines.push("");

  lines.push("### Counts");
  lines.push("");
  lines.push("| Counter | Value |");
  lines.push("| --- | --- |");
  const entries = Object.entries(counters) as [Counter, number][];
  if (entries.length === 0) lines.push("| (none) | 0 |");
  for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`| ${k} | ${v} |`);
  lines.push("");

  lines.push("### Holds by reason");
  lines.push("");
  lines.push("| Reason | Sources | Outings |");
  lines.push("| --- | --- | --- |");
  for (const reason of holdReasonSchema.options) {
    lines.push(
      `| ${reason} | ${input.holds.sources[reason] ?? 0} | ${input.holds.outings[reason] ?? 0} |`,
    );
  }
  lines.push("");

  const hits = parseJsonArray(run.budget_hits).flatMap((h) => {
    const r = budgetHitSchema.safeParse(h);
    return r.success ? [r.data] : [];
  });
  lines.push("### Budget hits");
  lines.push("");
  if (hits.length === 0) lines.push("None.");
  for (const h of hits)
    lines.push(
      `- \`${h.cap}\` (limit ${h.limit}) in ${mdCell(h.stage)}${h.detail ? `: ${mdCell(h.detail)}` : ""}`,
    );
  lines.push("");

  const errors = parseJsonArray(run.errors).flatMap((e) => {
    const r = stageErrorSchema.safeParse(e);
    return r.success ? [r.data] : [];
  });
  const shown = errors.filter((e) => e.kind !== "not_implemented");
  lines.push("### Errors");
  lines.push("");
  if (shown.length === 0) lines.push("None.");
  for (const e of shown.slice(0, 50))
    lines.push(`- ${mdCell(e.stage)} (${e.kind}): ${mdCell(e.message)}${e.url ? ` (${mdCell(e.url)})` : ""}`);
  if (shown.length > 50) lines.push(`- ... and ${shown.length - 50} more`);
  lines.push("");

  lines.push(
    failures.length === 0
      ? "**Result: OK**"
      : `**Result: FAILED**: ${failures.map(mdCell).join("; ")}`,
  );
  lines.push("");

  return {
    output: { markdown: lines.join("\n"), failed: failures.length > 0, failures, fetchErrorRate },
    result: emptyResult(),
  };
};
