/**
 * Display formatting for outing data. Dates are course-local wall dates
 * (YYYY-MM-DD) and are formatted from their parts, never through a Date in the
 * server's zone.
 */
import { formatUsd } from "@gof/shared/money";
import type { CourseType } from "@gof/shared/schemas";
import { US_STATES } from "@gof/shared/places";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number?];
  return { y, m, d: d ?? 1 };
}

const monthName = (m: number): string => MONTHS[m - 1] ?? "";

/** "Oct 19, 2026" (used in titles). */
export function shortDate(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${monthName(m).slice(0, 3)} ${d}, ${y}`;
}

/** "Monday, October 19, 2026". */
export function longDate(iso: string): string {
  const { y, m, d } = parts(iso);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return `${wd}, ${monthName(m)} ${d}, ${y}`;
}

/** "October 2026" from YYYY-MM or YYYY-MM-DD. */
export function monthYear(iso: string): string {
  const { y, m } = parts(iso);
  return `${monthName(m)} ${y}`;
}

/** "12:00 PM" from "12:00". */
export function clockTime(hhmm: string): string {
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")} ${suffix}`;
}

/** "Dec 15 to 18, 2026" or "Dec 30, 2026 to Jan 2, 2027" for multi-day outings. */
export function dateRange(start: string, end: string | null): string {
  if (!end || end === start) return shortDate(start);
  const a = parts(start);
  const b = parts(end);
  if (a.y === b.y && a.m === b.m) return `${monthName(a.m).slice(0, 3)} ${a.d} to ${b.d}, ${a.y}`;
  if (a.y === b.y) return `${monthName(a.m).slice(0, 3)} ${a.d} to ${monthName(b.m).slice(0, 3)} ${b.d}, ${a.y}`;
  return `${shortDate(start)} to ${shortDate(end)}`;
}

export const COURSE_TYPE_LABELS: Readonly<Record<CourseType, string>> = {
  municipal: "Municipal",
  public: "Public",
  semi_private: "Semi-private",
  private: "Private",
  resort: "Resort",
  unknown: "Course type unknown",
};

export const FORMAT_LABELS: Readonly<Record<string, string>> = {
  scramble: "Scramble",
  best_ball: "Best ball",
  shamble: "Shamble",
  stroke: "Stroke play",
  other: "Other format",
};

const INCLUDES_LABELS: Readonly<Record<string, string>> = {
  lunch: "lunch",
  breakfast: "breakfast",
  dinner: "dinner",
  cart: "cart",
  caddie: "caddie",
  range: "range balls",
  gift: "player gift",
  contests: "on-course contests",
};

/** "Includes cart, lunch and dinner." or "" */
export function includesText(items: readonly string[]): string {
  const words = items.map((i) => INCLUDES_LABELS[i]).filter((w): w is string => Boolean(w));
  if (words.length === 0) return "";
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Includes ${list}.`;
}

export interface PriceInput {
  singlePriceCents: number | null;
  foursomePriceCents: number | null;
  sponsorOnly: boolean;
}

/** "$150 per player, $600 per foursome", "Foursomes through sponsorship", or "See site". */
export function priceText(o: PriceInput): string {
  const bits: string[] = [];
  if (o.singlePriceCents !== null) bits.push(`${formatUsd(o.singlePriceCents)} per player`);
  if (o.foursomePriceCents !== null) bits.push(`${formatUsd(o.foursomePriceCents)} per foursome`);
  if (bits.length > 0) return bits.join(", ");
  if (o.sponsorOnly) return "Foursomes through sponsorship";
  return "See site";
}

export function stateName(code: string): string {
  return US_STATES[code.toUpperCase()] ?? code.toUpperCase();
}

/** "Mamaroneck, NY", or "NY" when the city is unknown. */
export function placeText(city: string | null, state: string): string {
  return city ? `${city}, ${state.toUpperCase()}` : state.toUpperCase();
}

/** "Mon D, YYYY" for an ISO timestamp's UTC date (last_verified, updated_at). */
export function verifiedDate(isoTimestamp: string): string {
  return shortDate(isoTimestamp.slice(0, 10));
}

/** Cuts text to `max` characters at a word boundary, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
