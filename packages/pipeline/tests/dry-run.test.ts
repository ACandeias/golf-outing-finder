import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { outingLabel } from "@gof/shared/labels";
import { main, type MainResult } from "../src/cli.ts";
import { MemoryD1 } from "../src/d1/memory.ts";
import { NIGHTLY_STAGES } from "../src/stages/registry.ts";

/**
 * The whole nightly pipeline, in process, on fixtures (SPEC.md 13 Phase 2:
 * "`pnpm run pipeline --dry-run` completes on fixtures with zero network
 * calls"). The CLI installs the network block, loads the fixture places and
 * courses into the in-memory D1, and wires every stage: the seed pages are
 * discovered, fetched from tests/fixtures/raw (synthetic stand-ins for gc1 and
 * gc5), normalized, extracted from tests/fixtures/llm by custom_id, classified
 * against tests/fixtures/irs-subset.csv, matched, upserted, published and
 * rechecked.
 */

const ENV = { NODE_ENV: "test", PIPELINE_NOW: "2026-09-28" };

interface Run extends MainResult {
  d1: MemoryD1;
  out: string;
  err: string[];
}

async function dryRun(argv: string[], env: Record<string, string> = ENV, d1 = new MemoryD1()): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const r = await main(argv, { env, d1, stdout: (t) => out.push(t), stderr: (l) => err.push(l) });
  return { ...r, d1, out: out.join(""), err };
}

const outingRow = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  outing_type: z.enum([
    "charity",
    "school_fundraiser",
    "business_association",
    "access_day",
    "open_tournament",
    "pro_am",
    "other",
  ]),
  start_date: z.string().nullable(),
  published: z.number(),
  canonical_source_url: z.string(),
  charity_status: z.enum(["501c3", "other_nonprofit", "unverified"]).nullable(),
});

const runRow = z.object({
  id: z.string(),
  kind: z.string(),
  finished_at: z.string().nullable(),
  stages_done: z.string(),
  serp_queries: z.number(),
  fetches: z.number(),
  extractions: z.number(),
  llm_input_tokens: z.number(),
  outings_new: z.number(),
  budget_hits: z.string(),
  errors: z.string(),
  est_cost_cents: z.number(),
  pending_batch_id: z.string().nullable(),
});

describe("pnpm run pipeline --dry-run --strict (in process, in-memory D1)", () => {
  let run: Run;
  let summary: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-dry-run-"));
    const file = join(dir, "summary.md");
    run = await dryRun(["--dry-run", "--strict"], { ...ENV, GITHUB_STEP_SUMMARY: file });
    summary = await readFile(file, "utf8");
  }, 60_000);

  it("exits 0 with every nightly stage done and no network attempt", () => {
    expect(run.networkAttempts).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.outcome?.statuses.map((s) => [s.stage, s.status])).toEqual(
      NIGHTLY_STAGES.map((s) => [s, "done"]),
    );
  });

  it("moves real data through every stage", () => {
    const state = run.outcome!.state;
    const c = state.counters;
    expect(state.queue.length).toBeGreaterThanOrEqual(10);
    expect(state.normalized.length).toBeGreaterThanOrEqual(10);
    expect(state.extractionRequests.length).toBeGreaterThanOrEqual(10);
    expect(c.events_extracted ?? 0).toBeGreaterThanOrEqual(10);
    expect(run.outcome!.run.outings_new).toBeGreaterThanOrEqual(8);
    expect(state.publishDecisions.filter((d) => d.publish).length).toBeGreaterThanOrEqual(8);
  });

  it("excludes gc1 (the Palm Beach resort package) and never makes it an outing", () => {
    const gc1 = "https://golfwithaccess.com/events/2026-access-palm-beach-golf-experience";
    const outcomes = run.outcome!.state.upsertOutcomes.filter((o) => o.source_url === gc1);
    expect(outcomes.map((o) => o.action)).toEqual(["excluded"]);
    const classified = run.outcome!.state.classified.find((o) => o.source_url === gc1);
    expect(classified).toMatchObject({ excluded: true, exclude_reason: "resort_package" });
    const rows = run.d1.db
      .prepare("SELECT count(*) AS n FROM outings WHERE canonical_source_url = ?")
      .get(gc1) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("publishes gc8 (NKF at Winged Foot) as a Charity outing at 2026/nkf-golf-classic-winged-foot", () => {
    const rows = z.array(outingRow).parse(
      run.d1.db
        .prepare(
          "SELECT o.id, o.slug, o.title, o.outing_type, o.start_date, o.published, o.canonical_source_url, " +
            "g.charity_status FROM outings o LEFT JOIN organizers g ON g.id = o.organizer_id",
        )
        .all(),
    );
    const gc8 = rows.find((r) => r.slug === "2026/nkf-golf-classic-winged-foot");
    expect(gc8).toMatchObject({ start_date: "2026-10-19", published: 1, outing_type: "charity" });
    expect(outingLabel(gc8!.outing_type, gc8!.charity_status)).toBe("Charity");
    // The other golden outings made it too (gc2, gc3, gc4's Encanto entry, gc5, gc6, gc7).
    const byDate = (d: string) => rows.filter((r) => r.start_date === d).map((r) => r.outing_type);
    expect(byDate("2026-10-13")).toContain("school_fundraiser");
    expect(byDate("2026-10-07")).toContain("business_association");
    expect(byDate("2026-10-03")).toContain("charity");
    expect(byDate("2026-11-07")).toContain("school_fundraiser");
    expect(byDate("2026-12-15")).toContain("open_tournament");
  });

  it("lists holds by reason and writes the summary and a complete runs row", () => {
    const holds = run.outcome!.state.holds;
    expect(holds.length).toBeGreaterThan(0);
    expect(summary).toContain("### Holds by reason");
    expect(summary).toMatch(/\| course_unmatched \| [1-9]\d* \| 0 \|/);
    expect(summary).toContain("Estimated cost:");
    expect(summary).toContain("**Result: OK**");
    const [row] = z.array(runRow).parse(run.d1.db.prepare("SELECT * FROM runs").all());
    expect(row).toMatchObject({ kind: "nightly", pending_batch_id: null });
    expect(row!.finished_at).not.toBeNull();
    expect(JSON.parse(row!.stages_done)).toEqual([...NIGHTLY_STAGES]);
    expect(row!.fetches).toBeGreaterThanOrEqual(10);
    expect(row!.extractions).toBeGreaterThanOrEqual(10);
    expect(row!.outings_new).toBeGreaterThanOrEqual(8);
    expect(row!.est_cost_cents).toBeGreaterThan(0);
  });

  it("a second run on the same D1 skips extraction for pages whose hash it stored", async () => {
    const collected = new Set(run.outcome!.state.extracted.map((p) => p.url));
    expect(collected.size).toBeGreaterThanOrEqual(8);
    const again = await dryRun(["--dry-run", "--strict", "--now=2026-09-28T18:00:00Z"], ENV, run.d1);
    expect(again.exitCode).toBe(0);
    expect(again.outcome!.run.outings_new).toBe(0);
    // Only pages whose extraction never came back (no recording) are sent again.
    for (const r of again.outcome!.state.extractionRequests) expect(collected.has(r.page_url)).toBe(false);
    expect(again.outcome!.state.normalized.filter((p) => p.unchanged).length).toBeGreaterThan(0);
  }, 60_000);
});
