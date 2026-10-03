import { describe, expect, it } from "vitest";
import { z } from "zod";
import { main, type MainDeps, type MainResult } from "../src/cli.ts";
import { MemoryD1 } from "../src/d1/memory.ts";
import type { FetchSidePorts } from "../src/fetch/ports.ts";
import { fixtureExtractionClient } from "../src/run/fixture-world.ts";
import { NIGHTLY_STAGES } from "../src/stages/registry.ts";
import type { BatchClient, BatchState, FetchOutcome } from "../src/stages/types.ts";

/**
 * Caps and failure rules on the wired dry run (SPEC.md 8.0, 8.10, 13 Phase 2,
 * 14). The documented commands:
 *
 *   PIPELINE_NOW=2026-09-28 MAX_SERP_QUERIES_PER_RUN=5 pnpm run pipeline --dry-run --strict
 *   PIPELINE_NOW=2026-09-28 pnpm run pipeline --dry-run --fail-stage=fetch      # exits 1
 */

const ENV = { NODE_ENV: "test", PIPELINE_NOW: "2026-09-28" };

interface Run extends MainResult {
  d1: MemoryD1;
  out: string;
  err: string[];
}

async function dryRun(
  argv: string[],
  env: Record<string, string> = ENV,
  extra: Partial<MainDeps> = {},
  d1 = new MemoryD1(),
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const r = await main(argv, { env, d1, stdout: (t) => out.push(t), stderr: (l) => err.push(l), ...extra });
  return { ...r, d1, out: out.join(""), err };
}

const hitSchema = z.array(z.object({ stage: z.string(), cap: z.string(), limit: z.number() }));
const errorSchema = z.array(z.object({ stage: z.string(), kind: z.string(), message: z.string() }));
const runRow = z.object({
  id: z.string(),
  finished_at: z.string().nullable(),
  stages_done: z.string(),
  serp_queries: z.number(),
  fetches: z.number(),
  extractions: z.number(),
  outings_new: z.number(),
  budget_hits: z.string(),
  errors: z.string(),
  pending_batch_id: z.string().nullable(),
});

function runs(d1: MemoryD1) {
  return z.array(runRow).parse(d1.db.prepare("SELECT * FROM runs ORDER BY started_at").all());
}

describe("MAX_SERP_QUERIES_PER_RUN=5", () => {
  it("stops search at 5 queries, records the budget hit, and every other stage still completes", async () => {
    const r = await dryRun(["--dry-run", "--strict"], { ...ENV, MAX_SERP_QUERIES_PER_RUN: "5" });
    expect(r.exitCode).toBe(0);
    expect(r.networkAttempts).toEqual([]);
    expect(r.outcome!.state.serpQueries).toHaveLength(5);
    expect(r.outcome!.statuses.map((s) => s.status)).toEqual(NIGHTLY_STAGES.map(() => "done"));
    const [row] = runs(r.d1);
    expect(row!.serp_queries).toBe(5);
    const hits = hitSchema.parse(JSON.parse(row!.budget_hits));
    expect(hits).toContainEqual(
      expect.objectContaining({ stage: "discover", cap: "MAX_SERP_QUERIES_PER_RUN", limit: 5 }),
    );
    // Search stopped; the seed pages still flowed all the way through.
    expect(row!.outings_new).toBeGreaterThanOrEqual(8);
    expect(r.out).toMatch(/### Budget hits[\s\S]*MAX_SERP_QUERIES_PER_RUN/);
  }, 60_000);
});

describe("--fail-stage=fetch", () => {
  it("exits non-zero, skips the later stages and still writes the runs row with the error", async () => {
    const r = await dryRun(["--dry-run", "--strict", "--fail-stage=fetch"]);
    expect(r.exitCode).toBe(1);
    expect(r.outcome!.statuses.find((s) => s.stage === "fetch")).toMatchObject({ status: "failed" });
    expect(r.outcome!.statuses.find((s) => s.stage === "normalize")).toMatchObject({ status: "skipped" });
    const [row] = runs(r.d1);
    expect(row!.finished_at).not.toBeNull();
    expect(JSON.parse(row!.stages_done)).toEqual(["discover", "report"]);
    expect(errorSchema.parse(JSON.parse(row!.errors))).toContainEqual(
      expect.objectContaining({ stage: "fetch", kind: "forced" }),
    );
    expect(r.out).toContain("**Result: FAILED**");
  }, 60_000);
});

/** Makes every fetch on `host` come back with `outcome`. */
function failHost(host: string, outcome: FetchOutcome, status: number | null) {
  return (ports: FetchSidePorts): FetchSidePorts => ({
    ...ports,
    fetcher: {
      ...ports.fetcher,
      fetchPage: async (item, budget) => {
        const page = await ports.fetcher.fetchPage(item, budget);
        if (new URL(item.url).hostname !== host) return page;
        return { ...page, outcome, http_status: status, html: null, error: `test: ${outcome}` };
      },
    },
  });
}

describe("the 20% fetch-error rule (SPEC.md 8.10)", () => {
  // azgolf.org, support.kidney.org and scramblehunter.com serve 2 pages each; failing
  // three hosts' worth of pages puts the error share well over 20%.
  const hosts = ["support.kidney.org", "scramblehunter.com", "azgolf.org"];
  const decorate =
    (outcome: FetchOutcome, status: number | null) =>
    (ports: FetchSidePorts): FetchSidePorts =>
      hosts.reduce((p, h) => failHost(h, outcome, status)(p), ports);

  it("fails the job when more than 20% of fetches are 5xx", async () => {
    const r = await dryRun(["--dry-run", "--strict"], ENV, {
      edges: { decorateFetchSide: decorate("server_error", 503) },
    });
    const c = r.outcome!.state.counters;
    expect((c.fetch_errors ?? 0) / r.outcome!.run.fetches).toBeGreaterThan(0.2);
    expect(r.exitCode).toBe(1);
    expect(r.outcome!.report.failures.join("\n")).toMatch(/fetches failed .*limit 20%/);
  }, 60_000);

  it("fails on network errors and timeouts too", async () => {
    const r = await dryRun(["--dry-run", "--strict"], ENV, {
      edges: { decorateFetchSide: decorate("timeout", null) },
    });
    expect(r.exitCode).toBe(1);
  }, 60_000);

  it("does not count 404, 410 or robots blocks", async () => {
    for (const [outcome, status] of [
      ["not_found", 404],
      ["gone", 410],
      ["robots_blocked", null],
    ] as const) {
      const r = await dryRun(["--dry-run", "--strict"], ENV, {
        edges: { decorateFetchSide: decorate(outcome, status) },
      });
      expect(r.outcome!.state.counters.fetch_errors ?? 0).toBe(0);
      expect(r.exitCode).toBe(0);
    }
  }, 60_000);
});

describe("MONTHLY_SPEND_CAP_CENTS", () => {
  it("skips paid work once this month's runs reach the cap; free stages still run", async () => {
    const d1 = new MemoryD1();
    d1.db.exec(
      "INSERT INTO runs (id, kind, started_at, finished_at, est_cost_cents) " +
        "VALUES ('run_earlier', 'nightly', '2026-09-02T07:15:00.000Z', '2026-09-02T08:40:00.000Z', 15000)",
    );
    const r = await dryRun(["--dry-run", "--strict"], ENV, {}, d1);
    expect(r.exitCode).toBe(0);
    expect(r.outcome!.statuses.map((s) => s.status)).toEqual(NIGHTLY_STAGES.map(() => "done"));
    const row = runs(d1).find((x) => x.id !== "run_earlier")!;
    expect(row.serp_queries).toBe(0);
    expect(row.extractions).toBe(0);
    expect(row.fetches).toBeGreaterThan(0);
    expect(hitSchema.parse(JSON.parse(row.budget_hits))).toContainEqual(
      expect.objectContaining({ cap: "MONTHLY_SPEND_CAP_CENTS" }),
    );
  }, 60_000);
});

/** A batch that is still running until `ended` flips (the fixture results underneath). */
class SlowBatch implements BatchClient {
  ended = false;
  submitted = 0;
  private readonly inner = fixtureExtractionClient();
  async submit(requests: Parameters<BatchClient["submit"]>[0]): Promise<BatchState> {
    this.submitted++;
    const s = await this.inner.submit(requests);
    return { batch_id: s.batch_id, status: "in_progress" };
  }
  async poll(batchId: string): Promise<BatchState> {
    return { batch_id: batchId, status: this.ended ? "ended" : "in_progress" };
  }
  results(batchId: string) {
    return this.inner.results(batchId);
  }
}

describe("a batch still running after the wait (SPEC.md 8.4)", () => {
  it("is stored in runs.pending_batch_id, its hashes stay unwritten, and the next nightly run collects it first", async () => {
    const d1 = new MemoryD1();
    const batch = new SlowBatch();
    const sleeps: number[] = [];
    const edges = {
      extractionBatch: batch,
      poll: {
        sleep: async (ms: number) => void sleeps.push(ms),
        nowMs: () => sleeps.reduce((a, b) => a + b, 0),
        intervalMs: 60_000,
        maxWaitMs: 180_000,
      },
    };

    const first = await dryRun(["--dry-run", "--strict"], ENV, { edges }, d1);
    expect(first.exitCode).toBe(0);
    expect(sleeps).toEqual([60_000, 60_000, 60_000]); // polled every 60 s until the 3-minute wait ran out
    const [row1] = runs(d1);
    expect(row1!.pending_batch_id).toBe("fixture_batch_1");
    expect(row1!.outings_new).toBe(0);
    const hashed = d1.db.prepare("SELECT count(*) AS n FROM sources WHERE content_hash IS NOT NULL").get() as {
      n: number;
    };
    expect(hashed.n).toBe(0);

    batch.ended = true;
    const second = await dryRun(["--dry-run", "--strict", "--now=2026-09-29"], ENV, { edges }, d1);
    expect(second.exitCode).toBe(0);
    const row2 = runs(d1).at(-1)!;
    expect(row2.pending_batch_id).toBeNull();
    expect(row2.outings_new).toBeGreaterThanOrEqual(8);
    // The azgolf calendar was not fetched again (7-day dedupe); its result came from the pending batch.
    const az = d1.db
      .prepare("SELECT extracted_json IS NOT NULL AS j, content_hash FROM sources WHERE url = ?")
      .get("https://azgolf.org/charity-club-sanctioned-events") as { j: number; content_hash: string | null };
    expect(az.j).toBe(1);
    expect(az.content_hash).toBeNull();
  }, 60_000);
});
