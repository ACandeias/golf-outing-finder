import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchClient, BatchResult, BatchState, ExtractionRequest } from "../stages/types.ts";
import { llmRecordingSchema } from "./recording.ts";

/**
 * Replays tests/fixtures/llm/{id}.json for dry runs and tests: no network, no
 * cost. A request maps to a recording through its page URL (the `url` of
 * tests/fixtures/pages/{id}.json, synthetic stand-ins first) unless `resolve`
 * says otherwise. A request with no recording comes back `errored`, so its page
 * stays queued exactly as a failed live result would.
 */
export class FixtureBatchClient implements BatchClient {
  private readonly batches = new Map<string, ExtractionRequest[]>();
  private readonly resolve: (r: ExtractionRequest) => string | null;
  readonly llmDir: string;

  constructor(opts: {
    llmDir: string;
    pagesDir?: string;
    resolve?: (r: ExtractionRequest) => string | null;
  }) {
    this.llmDir = opts.llmDir;
    if (opts.resolve) this.resolve = opts.resolve;
    else {
      const byUrl = opts.pagesDir ? pageIdsByUrl(opts.pagesDir) : new Map<string, string>();
      this.resolve = (r) => byUrl.get(r.page_url) ?? null;
    }
  }

  async submit(requests: ExtractionRequest[]): Promise<BatchState> {
    const id = `fixture_batch_${this.batches.size + 1}`;
    this.batches.set(id, requests);
    return { batch_id: id, status: "ended" };
  }

  async poll(batchId: string): Promise<BatchState> {
    return { batch_id: batchId, status: "ended" };
  }

  async results(batchId: string): Promise<BatchResult[]> {
    const requests = this.batches.get(batchId) ?? [];
    return requests.map((r): BatchResult => {
      const id = this.resolve(r);
      const path = id ? join(this.llmDir, `${id}.json`) : null;
      if (!path || !existsSync(path))
        return { custom_id: r.custom_id, result: { type: "errored", error: { type: "fixture_missing" } } };
      const rec = llmRecordingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      return { ...rec.batch_result, custom_id: r.custom_id };
    });
  }
}

/** page URL to fixture id, preferring `{id}.synthetic.json` (as the golden harness does). */
export function pageIdsByUrl(pagesDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".json")).sort();
  const ordered = [...files.filter((f) => !f.endsWith(".synthetic.json")), ...files.filter((f) => f.endsWith(".synthetic.json"))];
  for (const f of ordered) {
    const id = f.replace(/\.synthetic\.json$|\.json$/, "");
    const v: unknown = JSON.parse(readFileSync(join(pagesDir, f), "utf8"));
    const url = v && typeof v === "object" && "url" in v && typeof v.url === "string" ? v.url : `https://fixtures.invalid/${id}`;
    out.set(url, id);
  }
  return out;
}
