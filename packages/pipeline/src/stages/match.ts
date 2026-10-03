import { matchCourse, type MatchableCourse } from "../match/match-course.ts";
import { normalizeCity } from "../match/course-name.ts";
import {
  emptyResult,
  matchedOutingSchema,
  type ClassifiedOuting,
  type CourseMatch,
  type CourseRow,
  type MatchedOuting,
  type MatchStage,
  type PlaceCity,
} from "./types.ts";

type Course = MatchableCourse & { row: CourseRow };

function toMatchable(row: CourseRow): Course {
  let aliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.aliases);
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    aliases = [];
  }
  return { id: row.id, name: row.name, aliases, state: row.state, city: row.city, lat: row.lat, lng: row.lng, row };
}

function placeIndex(places: readonly PlaceCity[]): Map<string, PlaceCity> {
  const idx = new Map<string, PlaceCity>();
  for (const p of places) {
    const key = `${p.state.toUpperCase()}|${normalizeCity(p.name)}`;
    if (!idx.has(key)) idx.set(key, p);
  }
  return idx;
}

function matchOne(
  o: ClassifiedOuting,
  courses: readonly Course[],
  places: Map<string, PlaceCity>,
): CourseMatch {
  if (!o.course_name || !o.venue_state) return { kind: "unmatched", candidates: [] };
  const centroid = o.venue_city
    ? (places.get(`${o.venue_state.toUpperCase()}|${normalizeCity(o.venue_city)}`) ?? null)
    : null;
  const r = matchCourse(
    { name: o.course_name, state: o.venue_state, city: o.venue_city },
    courses,
    { cityCentroid: centroid ? { lat: centroid.lat, lng: centroid.lng } : null },
  );
  const names = r.candidates.map((c) => `${c.course.name} (${c.course.id})`);
  if (r.kind !== "matched") return { kind: r.kind, candidates: names };
  return {
    kind: "matched",
    course_id: r.course.id,
    course_name: r.course.name,
    time_zone: r.course.row.time_zone,
    score: r.score,
    facility: r.facility,
    aliases_to_add: r.aliasesToAdd,
  };
}

/**
 * SPEC.md 8.6, workstream C: wraps the Phase 1 matcher (src/match). Courses in
 * the venue state whose name or alias scores Jaro-Winkler 0.88 or more, within
 * the page's city or 25 km of its centroid; a multi-course facility within 3 km
 * picks the best score. An outing-like event with no single match is held on
 * its source as `course_unmatched` (dedupe-upsert sets held_until 30 days out
 * and the URL waits for a second source). Excluded events are matched too, for
 * the record, but never held.
 */
export const match: MatchStage = (_ctx, input) => {
  const result = emptyResult();
  const courses = input.courses.map(toMatchable);
  const places = placeIndex(input.places);
  let held = 0;
  const outings = input.outings.map((o): MatchedOuting => {
    const m = matchOne(o, courses, places);
    let hold = o.hold_reason;
    if (m.kind !== "matched" && !o.excluded && hold === null) {
      hold = "course_unmatched";
      held++;
      result.holds.push({ scope: "source", key: o.source_url, reason: hold, event_index: o.event_index });
    }
    return matchedOutingSchema.parse({ ...o, hold_reason: hold, match: m });
  });
  if (held > 0) result.counters.events_held = held;
  return { output: { outings }, result };
};
