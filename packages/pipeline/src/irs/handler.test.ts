import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { MemoryD1 } from "../d1/memory.ts";
import { memoryLogger } from "../lib/logger.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { stubHandlers } from "../run/handlers.ts";
import { runPipeline } from "../run/runner.ts";
import { runRowSchema } from "../stages/rows.ts";
import { irsHandler, IRS_FIXTURE_CSV } from "./handler.ts";

async function run(mode: "dry-run" | "live", dir: string, env: Record<string, string> = {}) {
  const d1 = new MemoryD1();
  const csv = await readFile(IRS_FIXTURE_CSV, "utf8");
  let fetched = 0;
  const fetch = async () => (fetched++, new Response(csv));
  const outcome = await runPipeline(
    { mode, job: "monthly", stages: ["irs", "report"], failStage: null, strict: true },
    {
      ctx: {
        now: new Date("2026-10-01T10:30:00Z"),
        caps: resolveBudget("monthly", env),
        overrides: emptyOverrides(),
        log: memoryLogger(),
        clock: { nowMs: () => 0 },
      },
      d1,
      handlers: { ...stubHandlers(), irs: irsHandler({ dir, fetch }) },
      runId: "run_irs",
    },
  );
  const row = runRowSchema.parse({ ...d1.db.prepare("SELECT * FROM runs").get() });
  return { outcome, row, fetched };
}

describe("irs handler", () => {
  it("builds the fixture database in a dry run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-irs-h-"));
    const { outcome, fetched } = await run("dry-run", dir);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state.counters.irs_records).toBe(22);
    expect(fetched).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("counts each regional download as a fetch in a live run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-irs-h-"));
    const { row, fetched } = await run("live", dir);
    expect(fetched).toBe(4);
    expect(row.fetches).toBe(4);
    await rm(dir, { recursive: true, force: true });
  });

  it("fails the stage when the fetch cap blocks the download and no earlier file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-irs-h-"));
    const { outcome, fetched } = await run("live", dir, { MAX_FETCHES_PER_RUN: "2" });
    expect(fetched).toBe(0);
    expect(outcome.statuses[0]).toMatchObject({ stage: "irs", status: "failed" });
    expect(outcome.budgetHits).toMatchObject([{ stage: "irs", cap: "MAX_FETCHES_PER_RUN" }]);
    await rm(dir, { recursive: true, force: true });
  });
});
