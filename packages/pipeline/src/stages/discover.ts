import { notImplemented } from "./not-implemented.ts";
import type { DiscoverStage, SearchPlanStage } from "./types.ts";

/**
 * SPEC.md 8.2, workstream B.
 *
 * `planSearch` picks tonight's SERP queries (place queries weekly April to
 * September and monthly otherwise, spread evenly across nights; course queries
 * monthly) within `allowance.MAX_SERP_QUERIES_PER_RUN`.
 *
 * `discover` merges recheck candidates (at most 40% of MAX_FETCHES_PER_RUN,
 * oldest last_verified first), submissions, listing links and SERP results into
 * the fetch queue: normalized URLs, exclusions.yaml applied, the 7-day dedupe
 * except for series pages and rechecks.
 */
export const planSearch: SearchPlanStage = notImplemented("discover");
export const discover: DiscoverStage = notImplemented("discover");
