import { notImplemented } from "./not-implemented.ts";
import type { DedupeUpsertStage } from "./types.ts";

/**
 * SPEC.md 8.7, workstream C. Same course and start date with organizer-name
 * similarity of 0.8 or more is one outing; merge preferring organizer, then
 * platform, then directory pages; slugs with `-2`, `-3`; source_outings links;
 * confirm a matching expected row in place (8.9). Emits an UpsertPlan.
 */
export const dedupeUpsert: DedupeUpsertStage = notImplemented("dedupe-upsert");
