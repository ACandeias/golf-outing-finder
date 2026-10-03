#!/usr/bin/env node
import { parseArgs } from "node:util";
import { budgetProfileSchema } from "@gof/shared/budget";
import { BudgetGuard } from "./budget.ts";
import { runPipeline } from "./run.ts";

async function runCli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      budget: { type: "string" },
      stages: { type: "string" },
    },
    strict: true,
    allowPositionals: true, // pnpm inserts `--` between script name and args
  });

  const mode = values.live ? "live" : "dry-run";
  const budget = budgetProfileSchema.parse(values.budget ?? "nightly");
  const stages = values.stages?.split(",") ?? null;

  const guard = new BudgetGuard(budget, process.env);
  const result = await runPipeline({ mode, budget, stages, guard });

  console.log(
    JSON.stringify(
      {
        mode,
        budget,
        stages: stages ?? "all",
        budget_hits: result.budgetHits,
        counts: result.counts,
      },
      null,
      2,
    ),
  );
}

runCli().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
