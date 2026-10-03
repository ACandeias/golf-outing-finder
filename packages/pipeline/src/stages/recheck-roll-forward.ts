import { notImplemented } from "./not-implemented.ts";
import type { RecheckRollForwardStage } from "./types.ts";

/**
 * SPEC.md 8.9, workstream C. source_gone after two consecutive 404/410, `past`
 * the day after end_date ?? start_date (course-local), roll forward to an
 * expected row, and the expected-miss bump and stale hold.
 */
export const recheckRollForward: RecheckRollForwardStage = notImplemented("recheck-roll-forward");
