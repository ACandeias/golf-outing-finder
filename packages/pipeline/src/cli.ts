#!/usr/bin/env node
/**
 * `pnpm run pipeline [--dry-run | --live] [--budget=nightly|monthly] [--stages=a,b,c]
 *  [--fail-stage=<stage>] [--now=<ISO>] [--strict] [--d1=local|remote|memory]`
 *
 * Builds the Context once (clock, caps, overrides, logger), opens the D1 port,
 * runs the stages and writes the report to stdout and $GITHUB_STEP_SUMMARY.
 * A dry run installs a network block before anything else.
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
import { loadOverrides } from "./overrides/load.ts";
import { newRunId } from "./run/accounting.ts";
import { defaultHandlers, type StageHandlers } from "./run/handlers.ts";
import { runPipeline, type RunOutcome } from "./run/runner.ts";
import { writeStepSummary } from "./run/summary.ts";
import type { Context } from "./stages/types.ts";

export interface MainDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the D1 port chosen from --d1 (tests). */
  d1?: D1Port;
  handlers?: StageHandlers;
  stdout?: (text: string) => void;
  stderr?: (line: string) => void;
}

export interface MainResult {
  exitCode: number;
  outcome: RunOutcome | null;
  networkAttempts: readonly string[];
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

  // Zero network in a dry run, installed before anything else can connect.
  const block: NetworkBlock | null = opts.mode === "dry-run" ? installNetworkBlock() : null;
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
      overrides: await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places }),
      log,
      clock: { nowMs: () => performance.now() },
    });
    const runId = newRunId(nowMs);
    const d1 = deps.d1 ?? d1For(opts, runId);
    log.info("pipeline", {
      mode: opts.mode,
      budget: opts.budget,
      now: ctx.now.toISOString(),
      d1: d1.target,
      strict: opts.strict,
      ...(opts.failStage ? { fail_stage: opts.failStage } : {}),
    });

    const outcome = await runPipeline(
      {
        mode: opts.mode,
        job: opts.budget,
        stages: opts.stages,
        failStage: opts.failStage,
        strict: opts.strict,
      },
      {
        ctx,
        d1,
        handlers: deps.handlers ?? defaultHandlers,
        runId,
        writeSummary: (md) => writeStepSummary(md, env),
      },
    );
    stdout(outcome.report.markdown);

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
    return { exitCode, outcome, networkAttempts: block ? [...block.attempts] : [] };
  } finally {
    block?.restore();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((r) => process.exit(r.exitCode))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
