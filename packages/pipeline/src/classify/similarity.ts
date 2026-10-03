/**
 * Normalized token-set similarity for organization names (SPEC.md 8.5, 8.7).
 * Both names are upper-cased, `&` reads as AND, punctuation and apostrophes go,
 * legal-form words (Inc, Corp, LLC, The, Of, ...) are dropped, and the remaining
 * unique tokens are sorted and joined. The score is 1 minus the Levenshtein
 * distance over the longer string: 1.0 for the same words in any order.
 */

const LEGAL_FORM_WORDS: ReadonlySet<string> = new Set([
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "LLC",
  "LTD",
  "THE",
  "OF",
  "AND",
  "FOR",
]);

export function nameTokens(name: string): string[] {
  const all = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`.]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const kept = all.filter((t) => !LEGAL_FORM_WORDS.has(t));
  return [...new Set(kept.length > 0 ? kept : all)].sort();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export function tokenSetSimilarity(a: string, b: string): number {
  const x = nameTokens(a).join(" ");
  const y = nameTokens(b).join(" ");
  if (x.length === 0 || y.length === 0) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}
