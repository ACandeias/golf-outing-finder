/** Post-validation helpers for extract-collect (SPEC.md 8.4). Pure. */

export const SUMMARY_MAX = 300;
export const EVIDENCE_MAX_WORDS = 20;
export const PUBLISH_CONFIDENCE = 0.75;

/** An explicit link: a scheme, `www.`, or a dotted host followed by a path. A bare
 * organization name such as "AmateurGolf.com" is not a link. */
const URL_LIKE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/i;
const EMAIL_LIKE = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i;

/** A summary may not carry a URL or an email address (scraped text must not smuggle links). */
export function containsUrl(text: string): boolean {
  return URL_LIKE.test(text) || EMAIL_LIKE.test(text);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** An evidence quote over 20 words is dropped (treated as no evidence). */
export function cleanEvidence(quote: string | null): string | null {
  if (quote === null) return null;
  const q = quote.trim();
  if (q.length === 0 || wordCount(q) > EVIDENCE_MAX_WORDS) return null;
  return q;
}

export interface ConfidenceInput {
  hasDateEvidence: boolean;
  hasCourseName: boolean;
  hasState: boolean;
  hasPrice: boolean;
  sponsorOnly: boolean;
  isOuting: boolean;
  jsonLdDisagrees: boolean;
}

/**
 * SPEC.md 8.4: start at 1.0; -0.3 with no date evidence, -0.2 with no course
 * name, -0.2 with no state, -0.1 with no price on an outing that isn't
 * sponsor-only, -0.2 when JSON-LD and the LLM disagree on the date. Clamped to
 * 0..1 and rounded to two places so 0.75 compares exactly.
 */
export function scoreConfidence(c: ConfidenceInput): number {
  let score = 1;
  if (!c.hasDateEvidence) score -= 0.3;
  if (!c.hasCourseName) score -= 0.2;
  if (!c.hasState) score -= 0.2;
  if (!c.hasPrice && c.isOuting && !c.sponsorOnly) score -= 0.1;
  if (c.jsonLdDisagrees) score -= 0.2;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}
