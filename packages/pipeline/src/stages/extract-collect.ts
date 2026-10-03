import { notImplemented } from "./not-implemented.ts";
import type { ExtractCollectStage } from "./types.ts";

/**
 * SPEC.md 8.4, workstream C. Parses each batch result, validates every event
 * with zod (dates, course-local today or later, prices, 300-character summary
 * with no URLs, evidence of 20 words or fewer), converts prices to cents,
 * applies the registration-host allowlist and computes confidence.
 */
export const extractCollect: ExtractCollectStage = notImplemented("extract-collect");
