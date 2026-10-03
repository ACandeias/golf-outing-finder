import { haversineKm, type LatLng } from "@gof/shared/places";
import { nameVariants, normalizeCity, normalizeCourseName } from "./course-name.ts";
import { jaroWinkler } from "./jaro-winkler.ts";

/** SPEC.md 8.6 thresholds. */
export const NAME_THRESHOLD = 0.88;
export const CITY_RADIUS_KM = 25;
export const FACILITY_RADIUS_KM = 3;

export interface MatchableCourse {
  id: string;
  name: string;
  aliases: readonly string[];
  state: string;
  city: string | null;
  lat: number;
  lng: number;
}

export interface CourseQuery {
  name: string;
  state: string;
  city?: string | null;
}

export interface MatchOptions {
  /** Centroid of the page's city (cities table, else ZIP place names), when known. */
  cityCentroid?: LatLng | null;
  threshold?: number;
  cityRadiusKm?: number;
  facilityRadiusKm?: number;
}

export interface Candidate<C extends MatchableCourse = MatchableCourse> {
  course: C;
  score: number;
  via: "name" | "alias";
}

export type MatchResult<C extends MatchableCourse = MatchableCourse> =
  | {
      kind: "matched";
      course: C;
      score: number;
      via: "name" | "alias";
      /** True when the multi-course facility rule chose among several candidates. */
      facility: boolean;
      /** Names of the other facility courses, to record as aliases of `course`. */
      aliasesToAdd: string[];
      candidates: Candidate<C>[];
    }
  | { kind: "unmatched"; candidates: Candidate<C>[] }
  | { kind: "ambiguous"; candidates: Candidate<C>[] };

function bestScore(queryVariants: readonly string[], target: string): number {
  const t = normalizeCourseName(target);
  let best = 0;
  for (const q of queryVariants) best = Math.max(best, jaroWinkler(q, t));
  return best;
}

function score<C extends MatchableCourse>(
  queryVariants: readonly string[],
  course: C,
): { score: number; via: "name" | "alias" } {
  const byName = bestScore(queryVariants, course.name);
  let byAlias = 0;
  for (const alias of course.aliases) byAlias = Math.max(byAlias, bestScore(queryVariants, alias));
  // A tie goes to the course's own name.
  return byAlias > byName ? { score: byAlias, via: "alias" } : { score: byName, via: "name" };
}

function compareCandidates<C extends MatchableCourse>(a: Candidate<C>, b: Candidate<C>): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.via !== b.via) return a.via === "name" ? -1 : 1;
  if (a.course.name.length !== b.course.name.length) return a.course.name.length - b.course.name.length;
  return a.course.id < b.course.id ? -1 : a.course.id > b.course.id ? 1 : 0;
}

function allWithin<C extends MatchableCourse>(cands: readonly Candidate<C>[], km: number): boolean {
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i]?.course;
      const b = cands[j]?.course;
      if (a && b && haversineKm(a, b) > km) return false;
    }
  }
  return true;
}

/**
 * Matches a venue to a course (SPEC.md v1.1 section 8.6). Pure: the caller passes
 * the courses and the city centroid.
 *
 * 1. Candidates are courses in the venue state whose normalized name or an alias
 *    scores Jaro-Winkler >= 0.88.
 * 2. When the venue gives a city, a candidate must be in that city or within 25 km
 *    of its centroid.
 * 3. One candidate matches. Several that all lie within 3 km of each other are one
 *    facility: the best score wins and the others' names become its aliases.
 * 4. Otherwise no match (unmatched or ambiguous); the event is held.
 */
export function matchCourse<C extends MatchableCourse>(
  query: CourseQuery,
  courses: readonly C[],
  options: MatchOptions = {},
): MatchResult<C> {
  const threshold = options.threshold ?? NAME_THRESHOLD;
  const cityRadius = options.cityRadiusKm ?? CITY_RADIUS_KM;
  const facilityRadius = options.facilityRadiusKm ?? FACILITY_RADIUS_KM;
  const state = query.state.toUpperCase();
  const variants = nameVariants(query.name);
  const queryCity = query.city ? normalizeCity(query.city) : null;
  const centroid = options.cityCentroid ?? null;

  const candidates: Candidate<C>[] = [];
  for (const course of courses) {
    if (course.state.toUpperCase() !== state) continue;
    const s = score(variants, course);
    if (s.score < threshold) continue;
    if (queryCity) {
      const sameCity = course.city !== null && normalizeCity(course.city) === queryCity;
      const nearCentroid = centroid !== null && haversineKm(course, centroid) <= cityRadius;
      if (!sameCity && !nearCentroid) continue;
    }
    candidates.push({ course, score: s.score, via: s.via });
  }
  candidates.sort(compareCandidates);

  const [best] = candidates;
  if (!best) return { kind: "unmatched", candidates };
  if (candidates.length === 1) {
    return {
      kind: "matched",
      course: best.course,
      score: best.score,
      via: best.via,
      facility: false,
      aliasesToAdd: [],
      candidates,
    };
  }
  if (!allWithin(candidates, facilityRadius)) return { kind: "ambiguous", candidates };

  const known = new Set([best.course.name, ...best.course.aliases].map((n) => n.toLowerCase()));
  const aliasesToAdd: string[] = [];
  for (const c of candidates.slice(1)) {
    const key = c.course.name.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    aliasesToAdd.push(c.course.name);
  }
  return {
    kind: "matched",
    course: best.course,
    score: best.score,
    via: best.via,
    facility: true,
    aliasesToAdd,
    candidates,
  };
}
