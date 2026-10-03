import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  batchResultSchema,
  batchStateSchema,
  type BatchClient,
  type BatchResult,
  type BatchState,
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
 * Live Message Batches client (SPEC.md 8.4 mechanics, used here for the monthly
 * course-type batch). Reads the key from ANTHROPIC_API_KEY through the SDK; only
 * constructed by `pnpm run pipeline --live`. Results are validated with zod.
 */
export function anthropicBatchClient(client: Anthropic = new Anthropic()): BatchClient {
  const state = (b: { id: string; processing_status: string }): BatchState =>
    batchStateSchema.parse({ batch_id: b.id, status: b.processing_status });
  return {
    async submit(requests) {
      const batch = await client.messages.batches.create({
        requests: requests.map((r) => ({
          custom_id: r.custom_id,
          params: r.params as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
        })),
      });
      return state(batch);
    },
    async poll(batchId) {
      return state(await client.messages.batches.retrieve(batchId));
    },
    async results(batchId) {
      const out: BatchResult[] = [];
      for await (const r of await client.messages.batches.results(batchId)) {
        const parsed = batchResultSchema.safeParse(JSON.parse(JSON.stringify(r)));
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
  };
}
