#!/usr/bin/env node
/**
 * `pnpm run pipeline [--dry-run | --live] [--budget=nightly|monthly|smoke] [--stages=a,b,c]
 *  [--fail-stage=<stage>] [--now=<ISO>] [--strict] [--d1=local|remote|memory] [--persist-to=<dir>]
 *  [--llm=api|claude-cli] [--serp=dataforseo|claude-search|fixture] [--prioritize-states=NY,NJ,CT]
 *  [--recheck-all] [--weekly-report]`
 *
 * Builds the Context once (clock, caps, overrides, logger), opens the D1 port,
 * builds the run's edges (src/run/wire.ts), runs the stages, closes the edges
 * and writes the report to stdout and $GITHUB_STEP_SUMMARY, then, on Mondays,
 * the weekly report issue (src/run/weekly.ts). A dry run installs a
 * network block before anything else and, on the in-memory D1, loads the
 * fixture places and courses. A live run first checks its secrets and the D1
 * config and refuses to start without them.
 */
import { join } from "node:path";
import { resolveBudget } from "@gof/shared/budget";
import { parsePipelineEnv, resolveNow } from "@gof/shared/env";
import { CliUsageError, parseCliArgs, USAGE, type CliOptions } from "./cli-args.ts";
import { MemoryD1 } from "./d1/memory.ts";
import type { D1Port } from "./d1/port.ts";
import { WranglerD1 } from "./d1/wrangler.ts";
import { createLogger, secretValues } from "./lib/logger.ts";
import { fromInvocationDir, PATHS } from "./lib/paths.ts";
import { installNetworkBlock, type NetworkBlock } from "./net/block.ts";
import { loadOverrides, type Overrides } from "./overrides/load.ts";
import { newRunId } from "./run/accounting.ts";
import { loadFixtureWorld } from "./run/fixture-world.ts";
import { defaultHandlers, type StageHandlers } from "./run/handlers.ts";
import { livePreflight, preflightMessage } from "./run/live-preflight.ts";
import { runPipeline, type RunOutcome } from "./run/runner.ts";
import { createRunEdges, type RunEdgesOptions } from "./run/wire.ts";
import { writeStepSummary } from "./run/summary.ts";
import { recordWeeklyFailure, weeklyReport, weeklySummaryMarkdown, type WeeklyReportResult } from "./run/weekly.ts";
import type { FetchLike } from "./report/github-issues.ts";
import { decideWeekly } from "./report/weekly-issue.ts";
import { runRowPlan } from "./run/accounting.ts";
import type { Context } from "./stages/types.ts";

export interface MainDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the D1 port chosen from --d1 (tests). */
  d1?: D1Port;
  handlers?: StageHandlers;
  /** Test doubles for the run's edges (fetch side, batch client, IRS, IndexNow, polling). */
  edges?: Omit<RunEdgesOptions, "ctx" | "mode" | "env">;
  /** Replaces whole override files after data/overrides is read (tests: a removals.yaml entry). */
  overrides?: Partial<Overrides>;
  /** apps/site/wrangler.toml text for the live preflight (tests). */
  wranglerToml?: string | null;
  /** The GitHub API's fetch for the weekly report issue (tests). */
  githubFetch?: FetchLike;
  stdout?: (text: string) => void;
  stderr?: (line: string) => void;
}

export interface MainResult {
  exitCode: number;
  outcome: RunOutcome | null;
  networkAttempts: readonly string[];
  /** The weekly report issue, when tonight is its night (SPEC.md 8.10). */
  weekly?: WeeklyReportResult | null;
}

function d1For(opts: CliOptions, runId: string): D1Port {
  if (opts.d1 === "memory") return new MemoryD1();
  return new WranglerD1({
    target: opts.d1,
    workDir: join(PATHS.cache, "d1", runId),
    persistTo: opts.persistTo ? fromInvocationDir(opts.persistTo) : undefined,
  });
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<MainResult> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));

  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv, env);
  } catch (err) {
    if (err instanceof CliUsageError) {
      stderr(`pipeline: ${err.message}\n${USAGE}`);
      return { exitCode: 2, outcome: null, networkAttempts: [] };
    }
    throw err;
  }

  if (opts.mode === "live") {
    const pre = livePreflight(opts.job, env, {
      d1: opts.d1,
      llm: opts.llm,
      serp: opts.serp,
      ...(deps.wranglerToml !== undefined ? { wranglerToml: deps.wranglerToml } : {}),
    });
    if (!pre.ok) {
      stderr(preflightMessage(opts.job, pre.problems));
      return { exitCode: 2, outcome: null, networkAttempts: [] };
    }
  }

  // Zero network in a dry run, installed before anything else can connect.
  const block: NetworkBlock | null = opts.mode === "dry-run" ? installNetworkBlock() : null;
  let closeEdges: (() => Promise<void>) | null = null;
  try {
    const parsedEnv = parsePipelineEnv({
      ...(env.NODE_ENV === "production" ? {} : { PUBLIC_SITE_URL: "http://localhost:8787" }),
      ...env,
    });
    const log = createLogger({ secrets: secretValues(env), sink: stderr });
    const nowMs = resolveNow(opts.now ?? parsedEnv.PIPELINE_NOW, parsedEnv.NODE_ENV, Date.now());
    const ctx: Context = Object.freeze({
      now: new Date(nowMs),
      caps: Object.freeze(resolveBudget(opts.budget, env)),
      overrides: Object.freeze({
        ...(await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places })),
        ...deps.overrides,
      }),
      log,
      clock: { nowMs: () => performance.now() },
    });
    const runId = newRunId(nowMs);
    const d1 = deps.d1 ?? d1For(opts, runId);
    if (opts.mode === "dry-run" && d1 instanceof MemoryD1) {
      const loaded = await loadFixtureWorld(d1, nowMs);
      if (loaded > 0) log.info("in-memory D1 loaded with the fixture places and courses", { courses: loaded });
    }
    log.info("pipeline", {
      mode: opts.mode,
      budget: opts.budget,
      now: ctx.now.toISOString(),
      d1: d1.target,
      strict: opts.strict,
      ...(opts.mode === "live" ? { llm: opts.llm, serp: opts.serp } : {}),
      ...(opts.prioritizeStates.length ? { prioritize_states: opts.prioritizeStates.join(",") } : {}),
      ...(opts.failStage ? { fail_stage: opts.failStage } : {}),
    });

    const edges = createRunEdges({
      ctx,
      mode: opts.mode,
      env: { ...env, PUBLIC_SITE_URL: parsedEnv.PUBLIC_SITE_URL },
      llm: opts.llm,
      serp: opts.serp,
      prioritizeStates: opts.prioritizeStates,
      forceRecheck: opts.recheckAll,
      ...deps.edges,
    });
    closeEdges = () => edges.close();
    const outcome = await runPipeline(
      {
        mode: opts.mode,
        job: opts.job,
        stages: opts.stages,
        failStage: opts.failStage,
        strict: opts.strict,
        costNote: (cents) => edges.costNote(cents),
      },
      {
        ctx,
        d1,
        handlers: deps.handlers ?? defaultHandlers(edges),
        ports: edges.ports(),
        runId,
        writeSummary: (md) => writeStepSummary(md, env),
      },
    );
    await edges.close();
    closeEdges = null;
    stdout(outcome.report.markdown);

    // SPEC.md 8.10: every Monday the nightly creates or updates the weekly
    // report issue. A GitHub failure is reported but never changes the exit code.
    const decision = decideWeekly({
      mode: opts.mode,
      job: opts.job,
      now: ctx.now,
      force: opts.weeklyReport,
      d1Target: d1.target,
      token: parsedEnv.GH_TOKEN,
      repo: parsedEnv.GITHUB_REPOSITORY,
    });
    let weekly: WeeklyReportResult | null = null;
    if (decision.action === "skip") {
      log.info(`weekly report issue: skipped (${decision.reason})`);
    } else {
      weekly = await weeklyReport(
        {
          action: decision.action,
          now: ctx.now,
          runId: outcome.run.id,
          monthlyCapCents: ctx.caps.MONTHLY_SPEND_CAP_CENTS,
          token: parsedEnv.GH_TOKEN,
          repo: parsedEnv.GITHUB_REPOSITORY,
          secrets: secretValues(env),
        },
        { d1, log, ...(deps.githubFetch ? { fetch: deps.githubFetch } : {}) },
      );
      const md = weeklySummaryMarkdown(weekly);
      stdout(md);
      await writeStepSummary(md, env);
      if (weekly.status === "failed") {
        try {
          await d1.apply(runRowPlan(recordWeeklyFailure(outcome.run, weekly.error)));
        } catch (err) {
          log.warn("could not store the weekly report error on the runs row", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const notImplemented = outcome.statuses
      .filter((s) => s.status === "not_implemented")
      .map((s) => s.stage);
    if (notImplemented.length > 0) {
      log.warn(
        `not implemented: ${notImplemented.join(", ")}${opts.strict ? "" : " (allowed without --strict)"}`,
      );
    }
    let exitCode: number = outcome.exitCode;
    if (block && block.attempts.length > 0) {
      log.error("network access was attempted during --dry-run", {
        attempts: block.attempts.slice(0, 20),
      });
      exitCode = 1;
    }
    log.info(`run ${outcome.run.id} written to the ${d1.target} D1; exit ${exitCode}`);
    return { exitCode, outcome, networkAttempts: block ? [...block.attempts] : [], weekly };
  } finally {
    if (closeEdges) await closeEdges().catch(() => {});
    block?.restore();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A promise that never settles leaves Node with nothing to wait on, and it
  // would exit 0 mid-run. Treat that as the failure it is.
  let settled = false;
  process.on("beforeExit", () => {
    if (settled) return;
    console.error("pipeline: the event loop emptied before the run finished (a promise never settled); exit 1");
    process.exit(1);
  });
  main(process.argv.slice(2))
    .then((r) => {
      settled = true;
      process.exit(r.exitCode);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
