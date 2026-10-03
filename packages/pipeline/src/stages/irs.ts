import { notImplemented } from "./not-implemented.ts";
import type { IrsStage } from "./types.ts";

/**
 * SPEC.md 8.1 step 6, workstream D (monthly). Parses IRS Business Master File
 * CSV rows into IrsRecords; the edge builds the node:sqlite lookup in .cache/irs.
 */
export const irs: IrsStage = notImplemented("irs");
