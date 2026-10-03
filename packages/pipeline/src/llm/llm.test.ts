import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/paths.ts";
import type { BatchClient, BatchResult, BatchState, BudgetCheck, ExtractionRequest } from "../stages/types.ts";
import { runExtractionBatch } from "./batch-client.ts";
import { FixtureBatchClient, pageIdsByUrl } from "./fixture-batch-client.ts";

const req = (url: string, id = "src_a"): ExtractionRequest => ({
  custom_id: id,
  page_url: url,
  est_input_tokens: 4000,
  params: {},
});

const okBudget: BudgetCheck = { check: () => true, monthlySpendOk: () => true };

/** A fake batch API: ends after `pollsUntilEnd` polls. */
function fakeClient(pollsUntilEnd: number): BatchClient & { submitted: number; polls: number } {
  let polls = 0;
  const c = {
    submitted: 0,
    get polls() {
      return polls;
    },
    async submit(): Promise<BatchState> {
      c.submitted++;
      return { batch_id: "msgbatch_1", status: "in_progress" };
    },
    async poll(id: string): Promise<BatchState> {
      polls++;
      return { batch_id: id, status: polls >= pollsUntilEnd ? "ended" : "in_progress" };
    },
    async results(id: string): Promise<BatchResult[]> {
      return [{ custom_id: id, result: { type: "expired" } }];
    },
  };
  return c;
}

describe("runExtractionBatch", () => {
  it("polls every 60 s and collects when the batch ends", async () => {
    let now = 0;
    const slept: number[] = [];
    const client = fakeClient(3);
    const out = await runExtractionBatch(client, [req("https://e.org/a")], {
      pendingBatchId: null,
      budget: okBudget,
      nowMs: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    expect(out.status).toBe("ended");
    expect(slept).toEqual([60_000, 60_000]);
    expect(out.results).toHaveLength(1);
  });

  it("gives up after 45 minutes and leaves the batch id for the next run", async () => {
    let now = 0;
    const client = fakeClient(1_000);
    const out = await runExtractionBatch(client, [req("https://e.org/a")], {
      pendingBatchId: null,
      budget: okBudget,
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(out).toMatchObject({ status: "pending", batchId: "msgbatch_1", submitted: 1 });
    expect(now).toBeLessThanOrEqual(45 * 60_000);
  });

  it("collects a pending batch first and submits nothing while it still runs", async () => {
    const running = fakeClient(1_000);
    const r1 = await runExtractionBatch(running, [req("https://e.org/a")], {
      pendingBatchId: "msgbatch_old",
      budget: okBudget,
      nowMs: () => 0,
      sleep: async () => {},
    });
    expect(r1).toMatchObject({ status: "pending", batchId: "msgbatch_old" });
    expect(running.submitted).toBe(0);
    const ended = fakeClient(1);
    const r2 = await runExtractionBatch(ended, [], {
      pendingBatchId: "msgbatch_old",
      budget: okBudget,
      nowMs: () => 0,
      sleep: async () => {},
    });
    expect(r2.status).toBe("ended");
    expect(r2.results.map((r) => r.custom_id)).toEqual(["msgbatch_old"]);
  });

  it("submits nothing when the guard refuses", async () => {
    const client = fakeClient(1);
    const out = await runExtractionBatch(client, [req("https://e.org/a")], {
      pendingBatchId: null,
      budget: { check: (cap) => cap !== "MAX_LLM_INPUT_TOKENS_PER_RUN", monthlySpendOk: () => true },
      nowMs: () => 0,
      sleep: async () => {},
    });
    expect(out).toMatchObject({ status: "ended", submitted: 0 });
    expect(client.submitted).toBe(0);
  });
});

describe("FixtureBatchClient", () => {
  const fixtures = join(REPO_ROOT, "tests/fixtures");
  it("replays recordings by page URL and errors when none exists", async () => {
    const client = new FixtureBatchClient({ llmDir: join(fixtures, "llm"), pagesDir: join(fixtures, "pages") });
    const batch = await client.submit([
      req("https://now.fordham.edu/event/fordham-golf-classic-2026/", "src_fordham"),
      req("https://example.org/none", "src_none"),
    ]);
    expect(await client.poll(batch.batch_id)).toEqual({ batch_id: batch.batch_id, status: "ended" });
    const results = await client.results(batch.batch_id);
    expect(results.map((r) => [r.custom_id, r.result.type])).toEqual([
      ["src_fordham", "succeeded"],
      ["src_none", "errored"],
    ]);
  });

  it("maps the synthetic stand-ins and the URL-less s15 page", () => {
    const ids = pageIdsByUrl(join(fixtures, "pages"));
    expect(ids.get("https://golfwithaccess.com/events/2026-access-palm-beach-golf-experience")).toBe(
      "s14-panther-national-package",
    );
    expect(ids.get("https://fixtures.invalid/s15-synthetic-oakmont-glendale")).toBe("s15-synthetic-oakmont-glendale");
  });
});
