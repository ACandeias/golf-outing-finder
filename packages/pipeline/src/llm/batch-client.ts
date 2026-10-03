import type Anthropic from "@anthropic-ai/sdk";
import {
  batchResultSchema,
  type BatchClient,
  type BatchResult,
  type BatchState,
  type BudgetCheck,
  type ExtractionRequest,
} from "../stages/types.ts";

/** SPEC.md 8.4: poll every 60 seconds for up to 45 minutes. */
export const POLL_INTERVAL_MS = 60_000;
export const MAX_WAIT_MS = 45 * 60_000;

type BatchCreateParams = Anthropic.Messages.Batches.BatchCreateParams;
type BatchRequest = BatchCreateParams["requests"][number];

/**
 * The live Message Batches client (SPEC.md 8.4) over @anthropic-ai/sdk. Only
 * `pnpm run pipeline --live` and `pnpm run test:live-extract` construct it; the
 * API key comes from the SDK's own environment lookup and is never logged.
 * Every result line is validated with zod before it leaves this edge.
 */
export class AnthropicBatchClient implements BatchClient {
  private readonly client: Anthropic;

  constructor(client: Anthropic) {
    this.client = client;
  }

  async submit(requests: ExtractionRequest[]): Promise<BatchState> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map(
        (r): BatchRequest => ({
          custom_id: r.custom_id,
          // Built and schema-checked by extract-request-build.
          params: r.params as unknown as BatchRequest["params"],
        }),
      ),
    });
    return { batch_id: batch.id, status: batch.processing_status };
  }

  async poll(batchId: string): Promise<BatchState> {
    const batch = await this.client.messages.batches.retrieve(batchId);
    return { batch_id: batch.id, status: batch.processing_status };
  }

  async results(batchId: string): Promise<BatchResult[]> {
    const out: BatchResult[] = [];
    for await (const line of await this.client.messages.batches.results(batchId)) {
      const parsed = batchResultSchema.safeParse(line);
      if (parsed.success) out.push(parsed.data);
      else
        out.push({
          custom_id: typeof line.custom_id === "string" ? line.custom_id : "invalid",
          result: { type: "errored", error: { type: "invalid_result_line" } },
        });
    }
    return out;
  }
}

export interface RunBatchOptions {
  /** A batch left by an earlier run (runs.pending_batch_id): collect it first. */
  pendingBatchId: string | null;
  /** The paid-call gate; checked for the extraction count and input tokens before submitting. */
  budget: BudgetCheck;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export type RunBatchOutcome =
  /** Results are in; clear runs.pending_batch_id. */
  | { status: "ended"; batchId: string | null; results: BatchResult[]; submitted: number }
  /** Still running after the wait; store batchId in runs.pending_batch_id and collect next run. */
  | { status: "pending"; batchId: string; results: BatchResult[]; submitted: number };

/**
 * Submit, poll every 60 s for up to 45 min, collect. A batch pending from the
 * previous run is collected first (its results come back with this run's), and
 * while it is still running nothing new is submitted, so at most one batch is
 * ever outstanding. Before submitting, the guard is consulted for
 * MAX_EXTRACTIONS_PER_RUN and MAX_LLM_INPUT_TOKENS_PER_RUN; a refused check
 * submits nothing (the guard records the hit).
 */
export async function runExtractionBatch(
  client: BatchClient,
  requests: readonly ExtractionRequest[],
  opts: RunBatchOptions,
): Promise<RunBatchOutcome> {
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxWait = opts.maxWaitMs ?? MAX_WAIT_MS;
  const collected: BatchResult[] = [];

  const waitFor = async (batchId: string): Promise<boolean> => {
    const start = opts.nowMs();
    for (;;) {
      const s = await client.poll(batchId);
      if (s.status === "ended") return true;
      if (opts.nowMs() - start + interval > maxWait) return false;
      await opts.sleep(interval);
    }
  };

  if (opts.pendingBatchId) {
    const s = await client.poll(opts.pendingBatchId);
    if (s.status !== "ended")
      return { status: "pending", batchId: opts.pendingBatchId, results: [], submitted: 0 };
    collected.push(...(await client.results(opts.pendingBatchId)));
  }
  if (requests.length === 0)
    return { status: "ended", batchId: opts.pendingBatchId, results: collected, submitted: 0 };

  const tokens = requests.reduce((n, r) => n + r.est_input_tokens, 0);
  if (
    !opts.budget.monthlySpendOk("extract-request-build") ||
    !opts.budget.check("MAX_EXTRACTIONS_PER_RUN", requests.length, "extract-request-build") ||
    !opts.budget.check("MAX_LLM_INPUT_TOKENS_PER_RUN", tokens, "extract-request-build")
  )
    return { status: "ended", batchId: null, results: collected, submitted: 0 };

  const batch = await client.submit([...requests]);
  if (batch.status !== "ended" && !(await waitFor(batch.batch_id)))
    return { status: "pending", batchId: batch.batch_id, results: collected, submitted: requests.length };
  collected.push(...(await client.results(batch.batch_id)));
  return { status: "ended", batchId: batch.batch_id, results: collected, submitted: requests.length };
}
