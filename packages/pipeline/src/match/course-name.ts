/**
 * Course-name normalization for matching (SPEC.md 8.6): lowercase ASCII, punctuation
 * stripped, and the stopwords golf, club, country, cc, gc, course, links and the
 * removed. The plurals "courses" and "clubs" are dropped too, because OSM names
 * multi-course facilities that way ("Bethpage State Park Golf Courses").
 */
export const MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "golf",
  "club",
  "clubs",
  "country",
  "cc",
  "gc",
  "course",
  "courses",
  "links",
  "the",
]);

const DIACRITICS = /[̀-ͯ]/g;

function tokens(input: string): string[] {
  return input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // "G.C." and "C.C." collapse to "gc" and "cc" before punctuation becomes spaces.
    .replace(/\b([a-z])\.([a-z])\.?(?=\s|$)/g, "$1$2")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeCourseName(name: string): string {
  const all = tokens(name);
  const kept = all.filter((t) => !MATCH_STOPWORDS.has(t));
  return (kept.length > 0 ? kept : all).join(" ");
}

const PARENTHETICAL = /\s*\([^)]*\)\s*/g;

/**
 * The normalized name, plus the name without a parenthetical course designation
 * ("Medinah Country Club (No. 3)" also tries "medinah"). The best variant scores.
 */
export function nameVariants(name: string): string[] {
  const full = normalizeCourseName(name);
  const out = [full];
  if (PARENTHETICAL.test(name)) {
    const stripped = normalizeCourseName(name.replace(PARENTHETICAL, " "));
    if (stripped && stripped !== full) out.push(stripped);
  }
  PARENTHETICAL.lastIndex = 0;
  return out;
}

const CITY_ABBREVIATIONS: Readonly<Record<string, string>> = {
  st: "saint",
  ste: "sainte",
  mt: "mount",
  ft: "fort",
  pt: "point",
};

/** City names compared loosely: case, punctuation, and St./Mt./Ft. abbreviations. */
export function normalizeCity(city: string): string {
  return tokens(city)
    .map((t) => CITY_ABBREVIATIONS[t] ?? t)
    .join(" ");
}
