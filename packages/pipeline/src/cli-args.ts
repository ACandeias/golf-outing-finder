import { parseArgs } from "node:util";
import { budgetJob, budgetProfileSchema, type BudgetJob, type BudgetProfile } from "@gof/shared/budget";
import {
  llmProviderSchema,
  serpProviderSchema,
  type LlmProvider,
  type SerpProvider,
} from "@gof/shared/env";
import { isUsStateCode } from "@gof/shared/places";
import { isStageName, selectStages, type StageName } from "./stages/registry.ts";
import type { D1Target } from "./d1/port.ts";

export interface CliOptions {
  mode: "dry-run" | "live";
  budget: BudgetProfile;
  /** `runs.kind` and the stage list: `smoke` runs as a small nightly. */
  job: BudgetJob;
  stages: StageName[];
  failStage: StageName | null;
  /** `--now`, refused when NODE_ENV is production. */
  now: string | null;
  strict: boolean;
  d1: D1Target;
  persistTo: string | null;
  /** `--llm` or LLM_PROVIDER: `api` (Message Batches) or `claude-cli` (subscription). Dry run: always fixtures. */
  llm: LlmProvider;
  /** `--serp` or SERP_PROVIDER; a dry run always uses `fixture`. */
  serp: SerpProvider;
  /** `--prioritize-states=NY,NJ,CT`: search those states' metros and courses tonight, first. */
  prioritizeStates: string[];
  /** `--recheck-all`: recheck every published open or waitlist outing tonight (within the 40% share). */
  recheckAll: boolean;
  /** `--weekly-report`: post the weekly report issue on any day (a dry run renders it instead). */
  weeklyReport: boolean;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const USAGE = `pnpm run pipeline [--dry-run | --live] [--budget=nightly|monthly|smoke] [--stages=a,b,c]
                  [--fail-stage=<stage>] [--now=<ISO date>] [--strict] [--d1=local|remote|memory]
                  [--persist-to=<dir>] [--llm=api|claude-cli]
                  [--serp=dataforseo|claude-search|fixture] [--prioritize-states=NY,NJ,CT] [--recheck-all]
                  [--weekly-report]`;

/**
 * Parses the pipeline CLI (SPEC.md 8.0, 12). `--dry-run` is the default and uses
 * fixtures with the network blocked; `--live` is what nightly.yml and
 * monthly.yml run; `--budget=smoke` is a nightly run with every cap at 5 to 10
 * for the owner's first live run. The D1 target defaults to an in-memory
 * database loaded with the fixture courses and places for a dry run (so it runs
 * the same anywhere, CI included) and the remote one for a live run.
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
        llm: { type: "string" },
        serp: { type: "string" },
        "prioritize-states": { type: "string" },
        "recheck-all": { type: "boolean", default: false },
        "weekly-report": { type: "boolean", default: false },
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
    throw new CliUsageError(`--budget must be nightly, monthly or smoke, got "${values.budget}"`);
  const job = budgetJob(budget.data);

  let stages: StageName[];
  try {
    stages = selectStages(values.stages, job);
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

  const d1 = values.d1 ?? (mode === "live" ? "remote" : "memory");
  if (d1 !== "local" && d1 !== "remote" && d1 !== "memory") {
    throw new CliUsageError(`--d1 must be local, remote or memory, got "${d1}"`);
  }
  if (mode === "dry-run" && d1 === "remote")
    throw new CliUsageError("--dry-run never writes the remote D1");

  // Providers: flag, then env, then the default. A dry run runs on fixtures only:
  // it never spawns `claude` and never calls a paid API.
  let llm: LlmProvider = "api";
  let serp: SerpProvider = mode === "live" ? "dataforseo" : "fixture";
  if (values.llm !== undefined) {
    const p = llmProviderSchema.safeParse(values.llm);
    if (!p.success) throw new CliUsageError(`--llm must be api or claude-cli, got "${values.llm}"`);
    if (mode === "dry-run" && p.data !== "api")
      throw new CliUsageError("--dry-run replays recorded LLM results; --llm needs --live");
    llm = p.data;
  } else if (mode === "live") {
    const p = llmProviderSchema.safeParse(env.LLM_PROVIDER);
    if (p.success) llm = p.data;
    else if (env.LLM_PROVIDER) throw new CliUsageError(`LLM_PROVIDER must be api or claude-cli`);
  }
  if (values.serp !== undefined) {
    const p = serpProviderSchema.safeParse(values.serp);
    if (!p.success)
      throw new CliUsageError(`--serp must be dataforseo, claude-search or fixture, got "${values.serp}"`);
    if (mode === "dry-run" && p.data !== "fixture")
      throw new CliUsageError("--dry-run uses the fixture SERP adapter; --serp needs --live");
    serp = p.data;
  } else if (mode === "live") {
    const p = serpProviderSchema.safeParse(env.SERP_PROVIDER);
    if (p.success) serp = p.data;
    else if (env.SERP_PROVIDER) throw new CliUsageError("SERP_PROVIDER must be dataforseo, claude-search or fixture");
  }

  const prioritizeStates: string[] = [];
  for (const raw of (values["prioritize-states"] ?? "").split(",")) {
    const s = raw.trim().toUpperCase();
    if (s === "") continue;
    if (!isUsStateCode(s)) throw new CliUsageError(`--prioritize-states takes USPS codes, got "${raw.trim()}"`);
    if (!prioritizeStates.includes(s)) prioritizeStates.push(s);
  }

  return {
    mode,
    budget: budget.data,
    job,
    stages,
    failStage: failStage as StageName | null,
    now,
    strict: values.strict,
    d1,
    persistTo: values["persist-to"] ?? null,
    llm,
    serp,
    prioritizeStates,
    recheckAll: values["recheck-all"],
    weeklyReport: values["weekly-report"],
  };
}
