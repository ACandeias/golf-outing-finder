const DIACRITICS = /[̀-ͯ]/g;
const NON_ALNUM = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/** Lowercase ASCII words joined by single hyphens. */
export function kebab(input: string): string {
  return input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(NON_ALNUM, "-")
    .replace(EDGE_HYPHENS, "");
}

/** SPEC.md section 8.7: words dropped from a course short slug. */
export const COURSE_SLUG_STOPWORDS: ReadonlySet<string> = new Set([
  "golf",
  "club",
  "country",
  "cc",
  "gc",
  "course",
  "links",
  "the",
  "and",
  "of",
  "at",
]);

export const COURSE_SHORT_SLUG_MAX = 40;

/** Cuts a kebab string to `max` characters at a hyphen boundary. */
export function truncateAtHyphen(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const lastHyphen = cut.lastIndexOf("-");
  const out = lastHyphen > 0 ? cut.slice(0, lastHyphen) : slug.slice(0, max);
  return out.replace(EDGE_HYPHENS, "");
}

/**
 * Course short slug (SPEC.md 8.7): kebab of the name with stopwords removed, cut to
 * 40 characters at a hyphen boundary. Falls back to the full kebab when every word
 * is a stopword ("The Links").
 */
export function courseShortSlug(courseName: string): string {
  const full = kebab(courseName);
  const words = full.split("-").filter((w) => w && !COURSE_SLUG_STOPWORDS.has(w));
  const base = words.length > 0 ? words.join("-") : full;
  return truncateAtHyphen(base, COURSE_SHORT_SLUG_MAX);
}

export type SlugTaken = (candidate: string) => boolean;

function toPredicate(taken: SlugTaken | ReadonlySet<string>): SlugTaken {
  return typeof taken === "function" ? taken : (s) => taken.has(s);
}

/** Returns `base`, or `base-2`, `base-3`, ... until one is free. */
export function withCollisionSuffix(base: string, taken: SlugTaken | ReadonlySet<string>): string {
  const isTaken = toPredicate(taken);
  if (!isTaken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`no free slug for ${base}`);
}

/**
 * Course slug (SPEC.md 8.1): `{state}/{kebab(name)}`; on a collision append the city;
 * if that still collides, append `-2`, `-3`.
 */
export function courseSlug(
  state: string,
  name: string,
  city: string | null | undefined,
  taken: SlugTaken | ReadonlySet<string> = new Set(),
): string {
  const isTaken = toPredicate(taken);
  const base = `${state.toLowerCase()}/${kebab(name)}`;
  if (!isTaken(base)) return base;
  const withCity = city ? `${base}-${kebab(city)}` : base;
  return withCollisionSuffix(withCity, isTaken);
}

/** Organizer slug: kebab(name), `-2` on collision. */
export function organizerSlug(name: string, taken: SlugTaken | ReadonlySet<string> = new Set()): string {
  return withCollisionSuffix(kebab(name), taken);
}

/** City slug: kebab(name), unique within a state (enforced by the cities_state_slug index). */
export function citySlug(name: string): string {
  return kebab(name);
}

/**
 * Outing slug (SPEC.md 8.7): `{year}/{kebab(title without the year)}-{course short slug}`,
 * `-2`, `-3` on collision. Never changes once published.
 */
export function outingSlug(
  year: number,
  title: string,
  courseName: string,
  taken: SlugTaken | ReadonlySet<string> = new Set(),
): string {
  const titleNoYear = title.replace(new RegExp(`\\b${year}\\b`, "g"), " ");
  const parts = [kebab(titleNoYear), courseShortSlug(courseName)].filter(Boolean);
  return withCollisionSuffix(`${year}/${parts.join("-")}`, taken);
}
