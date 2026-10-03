import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import { AnthropicBatchClient } from "../llm/batch-client.ts";
import {
  batchResultSchema,
  type BatchClient,
  type BatchResult,
  type BudgetCheck,
  type ExtractionRequest,
  type FetchedPage,
  type FetchPlanItem,
  type PageFetcher,
} from "../stages/types.ts";

export const COURSE_TYPES_FIXTURE_DIR = join(REPO_ROOT, "tests/fixtures/course-types");

const pagesFixtureSchema = z.object({
  note: z.string(),
  pages: z.record(z.string().url(), z.string()),
});
const resultsFixtureSchema = z.object({
  note: z.string(),
  results: z.array(batchResultSchema),
});

/**
 * Dry-run PageFetcher over tests/fixtures/course-types/pages.json: a URL in the
 * file is `ok` with its HTML, anything else is `not_found`. Meters
 * MAX_FETCHES_PER_RUN like the real fetcher and never touches the network.
 */
export async function fixturePageFetcher(
  nowIso: () => string,
  dir = COURSE_TYPES_FIXTURE_DIR,
): Promise<PageFetcher> {
  const { pages } = pagesFixtureSchema.parse(
    JSON.parse(await readFile(join(dir, "pages.json"), "utf8")),
  );
  return {
    async fetchPage(item: FetchPlanItem, budget: BudgetCheck): Promise<FetchedPage> {
      if (!budget.check("MAX_FETCHES_PER_RUN", 1, "course-types")) {
        throw new Error("MAX_FETCHES_PER_RUN reached");
      }
      const html = pages[item.url];
      return {
        requested_url: item.url,
        url: item.url,
        kind: item.kind,
        found_via: item.found_via,
        fetched_at: nowIso(),
        http_status: html === undefined ? 404 : 200,
        outcome: html === undefined ? "not_found" : "ok",
        content_type: html === undefined ? null : "text/html; charset=utf-8",
        html: html ?? null,
        pdf_text: null,
        rendered: false,
        error: null,
        recheck_outing_id: null,
        directory_host: null,
      };
    },
  };
}

/**
 * Dry-run BatchClient over tests/fixtures/course-types/results.json. A batch
 * "ends" at once and returns the fixture result for each submitted custom_id;
 * a request with no fixture comes back `errored`.
 */
export async function fixtureBatchClient(
  dir = COURSE_TYPES_FIXTURE_DIR,
): Promise<BatchClient & { submitted: ExtractionRequest[][] }> {
  const { results } = resultsFixtureSchema.parse(
    JSON.parse(await readFile(join(dir, "results.json"), "utf8")),
  );
  const byId = new Map(results.map((r) => [r.custom_id, r]));
  const batches = new Map<string, BatchResult[]>();
  const submitted: ExtractionRequest[][] = [];
  return {
    submitted,
    async submit(requests) {
      submitted.push(requests);
      const id = `msgbatch_fixture_${batches.size + 1}`;
      batches.set(
        id,
        requests.map(
          (r) =>
            byId.get(r.custom_id) ?? {
              custom_id: r.custom_id,
              result: { type: "errored", error: { type: "fixture_missing" } },
            },
        ),
      );
      return { batch_id: id, status: "ended" };
    },
    async poll(batchId) {
      return { batch_id: batchId, status: "ended" };
    },
    async results(batchId) {
      return batches.get(batchId) ?? [];
    },
  };
}

/**
 * Live Message Batches client for the monthly course-type batch. It is the same
 * client the nightly extraction uses (src/llm/batch-client.ts), so both call
 * sites share one implementation: the key comes from ANTHROPIC_API_KEY through
 * the SDK, results are validated with zod, and only `pnpm run pipeline --live`
 * constructs it. A live run passes its one shared instance in `ports.batch`;
 * this factory is the fallback when none is wired.
 */
export function anthropicBatchClient(client: Anthropic = new Anthropic()): BatchClient {
  return new AnthropicBatchClient(client);
}
