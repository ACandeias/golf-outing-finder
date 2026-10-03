import { parseArgs } from "node:util";
import { budgetProfileSchema, type BudgetProfile } from "@gof/shared/budget";
import { isStageName, selectStages, type StageName } from "./stages/registry.ts";
import type { D1Target } from "./d1/port.ts";

export interface CliOptions {
  mode: "dry-run" | "live";
  budget: BudgetProfile;
  stages: StageName[];
  failStage: StageName | null;
  /** `--now`, refused when NODE_ENV is production. */
  now: string | null;
  strict: boolean;
  d1: D1Target;
  persistTo: string | null;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const USAGE = `pnpm run pipeline [--dry-run | --live] [--budget=nightly|monthly] [--stages=a,b,c]
                  [--fail-stage=<stage>] [--now=<ISO date>] [--strict] [--d1=local|remote|memory]
                  [--persist-to=<dir>]`;

/**
 * Parses the pipeline CLI (SPEC.md 8.0, 12). `--dry-run` is the default and uses
 * fixtures with the network blocked; `--live` is what nightly.yml and
 * monthly.yml run. The D1 target defaults to the local database for a dry run and
 * the remote one for a live run.
 */
export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      // pnpm can pass a bare `--` before the script's args; flags after it still count.
      args: argv.filter((a) => a !== "--"),
      options: {
        "dry-run": { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        budget: { type: "string" },
        stages: { type: "string" },
        "fail-stage": { type: "string" },
        now: { type: "string" },
        strict: { type: "boolean", default: false },
        d1: { type: "string" },
        "persist-to": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  if (values["dry-run"] && values.live)
    throw new CliUsageError("--dry-run and --live are mutually exclusive");
  const mode = values.live ? "live" : "dry-run";

  const budget = budgetProfileSchema.safeParse(values.budget ?? "nightly");
  if (!budget.success)
    throw new CliUsageError(`--budget must be nightly or monthly, got "${values.budget}"`);

  let stages: StageName[];
  try {
    stages = selectStages(values.stages, budget.data);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  const failStage = values["fail-stage"] ?? null;
  if (failStage !== null) {
    if (!isStageName(failStage) || failStage === "report") {
      throw new CliUsageError(
        `--fail-stage must name a stage other than report, got "${failStage}"`,
      );
    }
    if (!stages.includes(failStage))
      throw new CliUsageError(`--fail-stage=${failStage} is not among the selected stages`);
  }

  const now = values.now ?? null;
  if (now !== null) {
    if (env.NODE_ENV === "production")
      throw new CliUsageError("--now is not allowed when NODE_ENV is production");
    if (
      !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(now) ||
      Number.isNaN(Date.parse(now))
    ) {
      throw new CliUsageError(`--now must be an ISO date or timestamp, got "${now}"`);
    }
  }

  const d1 = values.d1 ?? (mode === "live" ? "remote" : "local");
  if (d1 !== "local" && d1 !== "remote" && d1 !== "memory") {
    throw new CliUsageError(`--d1 must be local, remote or memory, got "${d1}"`);
  }
  if (mode === "dry-run" && d1 === "remote")
    throw new CliUsageError("--dry-run never writes the remote D1");

  return {
    mode,
    budget: budget.data,
    stages,
    failStage: failStage as StageName | null,
    now,
    strict: values.strict,
    d1,
    persistTo: values["persist-to"] ?? null,
  };
}
