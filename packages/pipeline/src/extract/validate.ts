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

const YEAR = /\b(19[5-9]\d|20\d{2})\b/g;

function years(text: string): number[] {
  return [...text.matchAll(YEAR)].map((m) => Number(m[1]));
}

/**
 * Why an event's year can't be trusted, or null (SPEC.md 8.4 as amended
 * 2026-10-03): the evidence quotes a year before this one; the page states its
 * year nowhere (so it came from the fetch date); or the evidence date has no
 * year and the nearest year before it on the page (a posting date) is an
 * earlier one, as on a 2017 news article about "next Monday, Oct. 9".
 */
export function yearProblem(i: {
  startDate: string;
  evidenceDate: string | null;
  pageText: string | null;
  url: string;
  title: string;
  currentYear: number;
}): string | null {
  const quoted = i.evidenceDate ? years(i.evidenceDate) : [];
  const early = quoted.find((y) => y < i.currentYear);
  if (early !== undefined) return `past: the page states ${early}`;
  if (i.pageText === null) return null;
  const eventYear = i.startDate.slice(0, 4);
  const stated = `${i.pageText} ${decodeURIComponentSafe(i.url)} ${i.title} ${i.evidenceDate ?? ""}`;
  if (!stated.includes(eventYear)) return `year ${eventYear} is not stated on the page`;
  if (quoted.length === 0 && i.evidenceDate) {
    const at = i.pageText.toLowerCase().indexOf(i.evidenceDate.toLowerCase().slice(0, 40));
    if (at >= 0) {
      const before = years(i.pageText.slice(Math.max(0, at - 400), at));
      const nearest = before.at(-1);
      if (nearest !== undefined && nearest < i.currentYear) return `past: the page is dated ${nearest}`;
    }
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A free event (price 0, or "free" with no price): nobody pays to enter (amended 2026-10-03). */
export function isFreeEvent(e: {
  single_price_usd: number | null;
  foursome_price_usd: number | null;
  sponsor_only: boolean;
  evidence: { price: string | null };
}): boolean {
  if (e.sponsor_only) return false;
  const noFoursome = e.foursome_price_usd === null || e.foursome_price_usd === 0;
  if (e.single_price_usd === 0 && noFoursome) return true;
  return e.single_price_usd === null && e.foursome_price_usd === null && /\bfree\b/i.test(e.evidence.price ?? "");
}

/**
 * False when the foursome price is just four times the single price and the
 * page never shows that amount (the model multiplied; amended 2026-10-03).
 */
export function statedFoursome(single: number | null, foursome: number, pageText: string | null): boolean {
  if (single === null || pageText === null || Math.abs(foursome - single * 4) > 0.005) return true;
  const whole = Math.round(foursome);
  const withComma = whole.toLocaleString("en-US");
  const re = new RegExp(`(^|[^\\d,])(${whole}|${withComma})(\\.00)?(?![\\d,])`);
  return re.test(pageText);
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
