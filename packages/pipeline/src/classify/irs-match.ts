import type { IrsLookup, IrsRecord } from "../stages/types.ts";
import { tokenSetSimilarity } from "./similarity.ts";

/** SPEC.md 8.5 thresholds. */
export const STATE_NAME_THRESHOLD = 0.92;
export const NATIONAL_NAME_THRESHOLD = 0.95;
const CANDIDATE_LIMIT = 25;

export type IrsMatchKind = "ein" | "state_name" | "national_name" | "none";

export interface IrsMatch {
  record: IrsRecord | null;
  kind: IrsMatchKind;
  score: number;
}

function best(name: string, records: readonly IrsRecord[], threshold: number): IrsMatch | null {
  let top: { r: IrsRecord; score: number } | null = null;
  let tie = false;
  for (const r of records) {
    const score = Math.max(
      tokenSetSimilarity(name, r.name),
      r.sort_name ? tokenSetSimilarity(name, r.sort_name) : 0,
    );
    if (score < threshold) continue;
    if (!top || score > top.score) {
      top = { r, score };
      tie = false;
    } else if (score === top.score && r.ein !== top.r.ein) tie = true;
  }
  // Two different organizations scoring the same: no verdict rather than a guess.
  if (!top || tie) return null;
  return { record: top.r, kind: "state_name", score: top.score };
}

/**
 * Charity lookup (SPEC.md 8.5): the page's EIN first; then the organizer name
 * within the venue state at 0.92 or more; then nationwide at 0.95 or more,
 * which catches national charities registered in another state.
 */
export function matchIrs(
  irs: IrsLookup,
  organizer: { name: string | null; ein: string | null; state: string | null },
): IrsMatch {
  const ein = organizer.ein?.replace(/\D/g, "") ?? "";
  if (ein.length === 9) {
    const r = irs.byEin(ein);
    if (r) return { record: r, kind: "ein", score: 1 };
  }
  const name = organizer.name?.trim() ?? "";
  if (name.length === 0) return { record: null, kind: "none", score: 0 };
  if (organizer.state) {
    const s = best(name, irs.candidates(name, organizer.state, CANDIDATE_LIMIT), STATE_NAME_THRESHOLD);
    if (s) return s;
  }
  const n = best(name, irs.candidates(name, null, CANDIDATE_LIMIT), NATIONAL_NAME_THRESHOLD);
  if (n) return { ...n, kind: "national_name" };
  return { record: null, kind: "none", score: 0 };
}
