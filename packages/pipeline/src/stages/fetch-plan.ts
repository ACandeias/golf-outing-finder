import { notImplemented } from "./not-implemented.ts";
import type { FetchPlanStage } from "./types.ts";

/**
 * SPEC.md 8.3, workstream B. Orders the queue into fetch items within
 * MAX_FETCHES_PER_RUN, MAX_RENDERS_PER_RUN and MAX_FETCHES_PER_HOST_PER_RUN, and
 * marks `render` for hosts in js-platforms.yaml. The fetcher edge (PageFetcher)
 * does the I/O and enforces MAX_FETCH_MINUTES.
 */
export const planFetch: FetchPlanStage = notImplemented("fetch");
