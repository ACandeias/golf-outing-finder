import { notImplemented } from "./not-implemented.ts";
import type { MatchStage } from "./types.ts";

/**
 * SPEC.md 8.6, workstream C. Wraps src/match/match-course.ts: candidates in the
 * venue state, the 25 km city rule, the 3 km facility rule; unmatched or
 * ambiguous events become `course_unmatched` source holds.
 */
export const match: MatchStage = notImplemented("match");
