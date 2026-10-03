import type { IrsLookup, IrsRecord } from "./types.ts";

/** Tokens that say nothing about which organization a name is. */
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  "INC",
  "THE",
  "OF",
  "AND",
  "FOR",
  "CO",
  "CORP",
  "LLC",
  "FUND",
  "FOUNDATION",
]);

/** Upper-case alphanumeric tokens of a name, stopwords removed (`&` reads as AND). */
export function irsNameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NAME_STOPWORDS.has(t));
}

/**
 * An IrsLookup over records in memory (tests and the golden harness). Workstream
 * D's node:sqlite lookup must return the same candidates for the same data:
 * every record in `state` (or nationwide when null) whose NAME or SORT_NAME shares
 * a token with `name`, most shared tokens first, then by EIN.
 */
export function memoryIrsLookup(records: readonly IrsRecord[]): IrsLookup {
  const byEin = new Map(records.map((r) => [r.ein, r]));
  const indexed = records.map((r) => ({
    r,
    tokens: new Set([...irsNameTokens(r.name), ...(r.sort_name ? irsNameTokens(r.sort_name) : [])]),
  }));
  return {
    byEin(ein) {
      return byEin.get(ein.replace(/\D/g, "")) ?? null;
    },
    candidates(name, state, limit) {
      const q = new Set(irsNameTokens(name));
      return indexed
        .filter((x) => state === null || x.r.state === state.toUpperCase())
        .map((x) => ({ r: x.r, shared: [...q].filter((t) => x.tokens.has(t)).length }))
        .filter((x) => x.shared > 0)
        .sort((a, b) => b.shared - a.shared || a.r.ein.localeCompare(b.r.ein))
        .slice(0, limit)
        .map((x) => x.r);
    },
  };
}
