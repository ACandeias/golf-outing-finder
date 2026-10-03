import { notImplemented } from "./not-implemented.ts";
import type { ClassifyStage } from "./types.ts";

/**
 * SPEC.md 8.5, workstream C. Exclusion, charity status from the IRS lookup (EIN,
 * then venue-state name at 0.92, then national name at 0.95), outing type by the
 * first matching rule, and org_type from the outing type.
 */
export const classify: ClassifyStage = notImplemented("classify");
