import { z } from "zod";
import { courseTypeSchema } from "@gof/shared/schemas";
import type { LatLng } from "@gof/shared/places";
import { matchCourse, type Candidate, type MatchableCourse } from "../match/match-course.ts";

/**
 * The top-course list (data/top-courses.json): widely recognized courses the
 * weekly top-course search targets. Facts only. The strict schema refuses any
 * extra field, so a rank or a ranking-list tag can't be committed by accident
 * (SPEC.md 7.1: never store or show rankings). Those tags live only in the
 * gitignored data/private/top-course-lists.json.
 *
 * `country` is ISO 3166-1 alpha-2 and `state` the subdivision code, so courses
 * outside the US can be added later; the `courses` table is US-only today.
 */

const OSM_REF = /^(node|way|relation)\/\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const topCourseSchema = z
  .object({
    name: z.string().min(1).max(200),
    city: z.string().min(1).max(100),
    state: z.string().regex(/^[A-Z]{2}$/),
    country: z.string().regex(/^[A-Z]{2}$/),
    course_type: courseTypeSchema.exclude(["unknown"]),
    website: z.url({ protocol: /^https?$/ }).max(2048).nullable(),
    osm_ref: z.string().regex(OSM_REF).nullable(),
    searched_for_outings: z.string().regex(ISO_DATE).nullable(),
  })
  .strict();
export type TopCourse = z.infer<typeof topCourseSchema>;

export const topCoursesFileSchema = z
  .object({
    version: z.string().min(1),
    notes: z.string(),
    courses: z.array(topCourseSchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const c of f.courses) {
      const key = `${c.country}/${c.state}/${c.name.toLowerCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `duplicate course: ${c.name}, ${c.state}` });
      seen.add(key);
    }
  });
export type TopCoursesFile = z.infer<typeof topCoursesFileSchema>;

export function parseTopCoursesFile(text: string): TopCoursesFile {
  return topCoursesFileSchema.parse(JSON.parse(text));
}

/**
 * The list as notable flags (courses.notable, SPEC.md 7.2): every pinned entry by
 * osm_ref. Unpinned entries are skipped, since a bare name would also flag every
 * other course with that name.
 */
export function topCoursesAsNotable(file: TopCoursesFile): { names: string[]; osmRefs: string[] } {
  const osmRefs = file.courses.flatMap((c) => (c.osm_ref ? [c.osm_ref] : []));
  return { names: [], osmRefs: [...new Set(osmRefs)] };
}

/** A `courses` row, as much as resolving needs. */
export interface PoolCourse extends MatchableCourse {
  osm_ref: string | null;
  website: string | null;
}

export type Resolution =
  /** The file already names an osm_ref that is in the pool. */
  | { kind: "pinned"; entry: TopCourse; course: PoolCourse; candidates: Candidate<PoolCourse>[] }
  /** One course (or one facility) matched; osm_ref and an empty website are filled. */
  | { kind: "matched"; entry: TopCourse; course: PoolCourse; candidates: Candidate<PoolCourse>[] }
  /** No candidate in the entry's city, but one near-exact name in the whole state: printed for a check. */
  | { kind: "statewide"; entry: TopCourse; course: PoolCourse; candidates: Candidate<PoolCourse>[] }
  /** One candidate, but its club word differs ("Country Club" vs "Golf Club"): a person decides. */
  | { kind: "review"; entry: TopCourse; course: PoolCourse; candidates: Candidate<PoolCourse>[] }
  | { kind: "ambiguous"; entry: TopCourse; course?: undefined; candidates: Candidate<PoolCourse>[] }
  | { kind: "unmatched"; entry: TopCourse; course?: undefined; candidates: Candidate<PoolCourse>[] }
  /** The file's osm_ref is not in the pool (deleted from OSM, or a typo). */
  | { kind: "missing"; entry: TopCourse; course?: undefined; candidates: Candidate<PoolCourse>[] };

/** A near-exact name score, and how far it must lead the runner-up to win outright. */
const CLEAR_WINNER = 0.97;
const CLEAR_GAP = 0.05;

/** Words that tell clubs with the same core name apart. Each side must use the same ones. */
const CLUB_WORDS = ["country", "golf", "national", "links", "hunt", "athletic", "yacht", "field", "cricket", "hills"] as const;

function clubWords(name: string): string {
  const words = name
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z]+/);
  return CLUB_WORDS.filter((w) => words.includes(w)).join(" ");
}

/** Only a disagreement counts: a bare OSM name ("Whistling Straits") is not a mismatch. */
function clubWordsDisagree(a: string, b: string): boolean {
  const wa = clubWords(a);
  const wb = clubWords(b);
  return wa !== "" && wb !== "" && wa !== wb;
}

/**
 * Ties each list entry to a `courses` row. Pure: the pool and the city centroid
 * lookup come from the caller. Uses the pipeline's own matcher (SPEC.md 8.6),
 * plus one stricter rule for pins: a single candidate whose club word differs
 * goes to review instead of matching.
 */
export function resolveTopCourses(
  entries: readonly TopCourse[],
  pool: readonly PoolCourse[],
  centroid: (state: string, city: string) => LatLng | null,
): Resolution[] {
  const byRef = new Map(pool.filter((c) => c.osm_ref !== null).map((c) => [c.osm_ref as string, c]));
  return entries.map((e): Resolution => {
    if (e.osm_ref !== null) {
      const course = byRef.get(e.osm_ref);
      if (!course) return { kind: "missing", entry: e, candidates: [] };
      return { kind: "pinned", entry: { ...e, website: e.website ?? course.website }, course, candidates: [] };
    }
    const m = matchCourse(
      { name: e.name, state: e.state, city: e.city },
      pool,
      { cityCentroid: centroid(e.state, e.city) },
    );
    const fill = (c: PoolCourse): TopCourse => ({ ...e, osm_ref: c.osm_ref, website: e.website ?? c.website });
    if (m.kind === "matched") {
      if (!m.facility && clubWordsDisagree(e.name, m.course.name)) {
        return { kind: "review", entry: e, course: m.course, candidates: m.candidates };
      }
      return { kind: "matched", entry: fill(m.course), course: m.course, candidates: m.candidates };
    }
    // A clear winner among several candidates in the city: near-exact and well ahead.
    const [best, second] = m.candidates;
    if (
      m.kind === "ambiguous" &&
      best &&
      best.score >= CLEAR_WINNER &&
      (!second || best.score - second.score >= CLEAR_GAP) &&
      !clubWordsDisagree(e.name, best.course.name)
    ) {
      return { kind: "matched", entry: fill(best.course), course: best.course, candidates: m.candidates };
    }
    if (m.kind === "unmatched") {
      // Top courses often list a village the cities table doesn't have (Haven, WI):
      // accept one near-exact name in the whole state, and print it for a check.
      const wide = matchCourse({ name: e.name, state: e.state }, pool, { threshold: CLEAR_WINNER });
      if (
        wide.kind === "matched" &&
        !wide.facility &&
        wide.candidates.length === 1 &&
        !clubWordsDisagree(e.name, wide.course.name)
      ) {
        return { kind: "statewide", entry: fill(wide.course), course: wide.course, candidates: wide.candidates };
      }
    }
    return { kind: m.kind, entry: e, candidates: m.candidates };
  });
}

/** One course a `--top-courses` run searches: found in `courses` by osm_ref. */
export interface TopCourseTarget {
  osm_ref: string;
  /** The list name without a parenthetical course designation, for exact-phrase queries. */
  search_name: string;
}

/**
 * Entries `from` to `to` (1-based, inclusive) as search targets. Entries with
 * no osm_ref yet can't be tied to a course row, so they are returned as skipped.
 */
export function topCourseTargets(
  file: TopCoursesFile,
  from: number,
  to: number,
): { targets: TopCourseTarget[]; skipped: string[] } {
  const targets: TopCourseTarget[] = [];
  const skipped: string[] = [];
  for (const c of file.courses.slice(from - 1, to)) {
    if (c.osm_ref === null) {
      skipped.push(`${c.name}, ${c.state}`);
      continue;
    }
    targets.push({ osm_ref: c.osm_ref, search_name: c.name.replace(/\s*\([^)]*\)\s*/g, " ").trim() });
  }
  return { targets, skipped };
}
