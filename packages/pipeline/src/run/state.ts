import type {
  ClassifiedOuting,
  Counters,
  ExtractedPage,
  ExtractionRequest,
  ExtractionRequestMeta,
  FetchedPage,
  FetchPlanItem,
  Hold,
  MatchedOuting,
  NormalizedPage,
  PublishDecision,
  QueueEntry,
  SerpQuery,
  UpsertOutcome,
} from "../stages/types.ts";

/** Data handed from one stage to the next within a run. */
export interface PipelineState {
  serpQueries: SerpQuery[];
  queue: QueueEntry[];
  processedSubmissionIds: string[];
  fetchPlan: FetchPlanItem[];
  fetched: FetchedPage[];
  normalized: NormalizedPage[];
  extractionRequests: ExtractionRequest[];
  extractionMeta: ExtractionRequestMeta[];
  /** Message Batches id waiting for results; mirrored to runs.pending_batch_id. */
  pendingBatchId: string | null;
  extracted: ExtractedPage[];
  classified: ClassifiedOuting[];
  matched: MatchedOuting[];
  upsertOutcomes: UpsertOutcome[];
  publishDecisions: PublishDecision[];
  indexnowUrls: string[];
  holds: Hold[];
  /** Every counter stages reported, summed (the summary shows the non-column ones). */
  counters: Counters;
}

export function emptyState(): PipelineState {
  return {
    serpQueries: [],
    queue: [],
    processedSubmissionIds: [],
    fetchPlan: [],
    fetched: [],
    normalized: [],
    extractionRequests: [],
    extractionMeta: [],
    pendingBatchId: null,
    extracted: [],
    classified: [],
    matched: [],
    upsertOutcomes: [],
    publishDecisions: [],
    indexnowUrls: [],
    holds: [],
    counters: {},
  };
}
