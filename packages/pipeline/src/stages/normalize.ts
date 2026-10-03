import { notImplemented } from "./not-implemented.ts";
import type { NormalizeStage } from "./types.ts";

/**
 * SPEC.md 8.3, workstream B. Readability main text (with the aria-hidden fix in
 * tests/fixtures/MISSING.md), JSON-LD blocks kept separately, text truncated at
 * 12,000 characters and hashed; `unchanged` when the hash equals the last one;
 * `needs_render` when a plain fetch yields under 400 characters.
 */
export const normalize: NormalizeStage = notImplemented("normalize");
