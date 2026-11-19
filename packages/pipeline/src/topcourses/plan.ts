import { z } from "zod";
import type { CourseRecord } from "../courses/import.ts";
import type { PlaceLocator } from "../places/locator.ts";
import { buildSeedPlan, SeedMatchError, type Removals, type SeedPlan } from "../seed/plan.ts";
import type { SeedFile } from "../seed/seed-file.ts";
import { insertStatements, sqlValue } from "../sql/literal.ts";
import {
  COURSE_COLUMNS,
  ORGANIZER_COLUMNS,
  OUTING_COLUMNS,
  SOURCE_COLUMNS,
  courseRow,
  organizerRow,
  outingRow,
} from "../sql/tables.ts";

/**
 * Adds hand-researched outings (data/top-course-outings.json, seed-entry format)
 * to a database that already holds data, without deleting anything. Pure:
 * entries, a pool of imported courses and a snapshot of the target database in,
 * append-only SQL out. Rows reuse the seed loader's planner, so slugs, summaries
 * and the publish rules match a normal seed.
 */

/** Ids and slugs of what the target database already holds. */
export const targetSnapshotSchema = z.object({
  courses: z.array(z.object({ id: z.string(), slug: z.string(), osm_ref: z.string().nullable() })),
  organizers: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
  outings: z.array(
    z.object({
      slug: z.string(),
      course_id: z.string(),
      start_date: z.string().nullable(),
      organizer_id: z.string().nullable(),
      canonical_source_url: z.string(),
    }),
  ),
});

export type TargetSnapshot = z.infer<typeof targetSnapshotSchema>;

export interface AppendInput {
  seed: SeedFile;
  /** Candidate courses (e.g. the full OSM import), with course-types overrides applied. */
  pool: readonly CourseRecord[];
  target: TargetSnapshot;
  locator: PlaceLocator;
  now: number;
  registrationHosts: readonly string[];
  removals: Removals;
}

export interface AppendSkip {
  seedId: string;
  reason: string;
}

export interface AppendPlan {
  statements: string[];
  newCourses: CourseRecord[];
  plan: SeedPlan;
  skipped: AppendSkip[];
}

function withSuffix(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

export function buildAppendPlan(input: AppendInput): AppendPlan {
  const skipped: AppendSkip[] = [];

  // Courses the target already has keep their id and slug, so foreign keys line up.
  const targetByOsm = new Map(
    input.target.courses.filter((c) => c.osm_ref !== null).map((c) => [c.osm_ref as string, c]),
  );
  const pool = input.pool.map((c) => {
    const t = targetByOsm.get(c.osmRef);
    return t ? { ...c, id: t.id, slug: t.slug } : c;
  });

  // Drop entries no course matches, then plan the rest.
  let entries = [...input.seed.outings];
  let plan: SeedPlan;
  for (;;) {
    try {
      plan = buildSeedPlan({
        seed: { ...input.seed, outings: entries },
        courses: pool,
        locator: input.locator,
        now: input.now,
        includeTestEntries: false,
        registrationHosts: input.registrationHosts,
        removals: input.removals,
      });
      break;
    } catch (err) {
      if (!(err instanceof SeedMatchError)) throw err;
      const bad = new Set(err.unmatched.map((u) => u.seedId));
      for (const u of err.unmatched) {
        skipped.push({
          seedId: u.seedId,
          reason: `no course match for "${u.courseName}", ${u.city}, ${u.state} (${u.result})`,
        });
      }
      entries = entries.filter((e) => !bad.has(e.id));
      if (entries.length === 0) {
        return { statements: [], newCourses: [], plan: emptyPlan(), skipped };
      }
    }
  }
  for (const id of plan.skipped) skipped.push({ seedId: id, reason: "test entry" });

  // Organizers the target already has (same name) are reused, not inserted.
  const targetOrgByName = new Map(input.target.organizers.map((o) => [o.name.trim().toLowerCase(), o]));
  const orgSlugs = new Set(input.target.organizers.map((o) => o.slug));
  const orgIdMap = new Map<string, string>();
  const newOrganizers = [];
  for (const o of plan.organizers) {
    const existing = targetOrgByName.get(o.name.trim().toLowerCase());
    if (existing) {
      orgIdMap.set(o.id, existing.id);
      continue;
    }
    const slug = withSuffix(o.slug, orgSlugs);
    orgSlugs.add(slug);
    newOrganizers.push({ ...o, slug });
  }

  // Outings already in the target (same source page, or same course, date and organizer) are skipped.
  const outingSlugs = new Set(input.target.outings.map((o) => o.slug));
  const targetUrls = new Set(input.target.outings.map((o) => o.canonical_source_url));
  const dedupe = new Set(
    input.target.outings
      .filter((o) => o.start_date !== null)
      .map((o) => `${o.course_id}|${o.start_date}|${o.organizer_id ?? ""}`),
  );
  const seedIdByOuting = new Map(plan.matches.map((m) => [m.outingId, m.seedId]));
  const outings = [];
  for (const raw of plan.outings) {
    const o = { ...raw, organizerId: raw.organizerId ? (orgIdMap.get(raw.organizerId) ?? raw.organizerId) : null };
    const seedId = seedIdByOuting.get(o.id) ?? o.id;
    const key = `${o.courseId}|${o.startDate}|${o.organizerId ?? ""}`;
    if (targetUrls.has(o.canonicalSourceUrl)) {
      skipped.push({ seedId, reason: `already loaded from ${o.canonicalSourceUrl}` });
      continue;
    }
    if (o.startDate !== null && dedupe.has(key)) {
      skipped.push({ seedId, reason: "an outing at this course on this date is already loaded" });
      continue;
    }
    if (o.startDate !== null) dedupe.add(key);
    const slug = withSuffix(o.slug, outingSlugs);
    outingSlugs.add(slug);
    outings.push({ ...o, slug });
  }

  const keptIds = new Set(outings.map((o) => o.id));
  const usedCourseIds = new Set(outings.map((o) => o.courseId));
  const targetIds = new Set(input.target.courses.map((c) => c.id));
  const newCourses = plan.courses.filter((c) => usedCourseIds.has(c.id) && !targetIds.has(c.id));
  const usedOrgIds = new Set(outings.map((o) => o.organizerId).filter((id): id is string => id !== null));
  const organizers = newOrganizers.filter((o) => usedOrgIds.has(o.id));
  const sourceById = new Map(plan.sources.map((s) => [s.id, s]));
  const links = plan.sourceOutings.filter((l) => keptIds.has(l.outingId));
  const sources = [...new Set(links.map((l) => l.sourceId))].map((id) => sourceById.get(id)!);

  const statements = [
    ...insertStatements(
      "courses",
      COURSE_COLUMNS,
      newCourses.map((c) => courseRow({ ...c, outingCount: 0, lastOutingDate: null })),
      { verb: "INSERT OR IGNORE" },
    ),
    ...insertStatements("organizers", ORGANIZER_COLUMNS, organizers.map(organizerRow)),
    ...insertStatements("outings", OUTING_COLUMNS, outings.map(outingRow)),
    // A source URL the target already has keeps its row; links resolve by URL.
    ...insertStatements(
      "sources",
      SOURCE_COLUMNS,
      sources.map((s) => ({ id: s.id, url: s.url, domain: s.domain, kind: s.kind })),
      { verb: "INSERT OR IGNORE" },
    ),
    ...links.map((l) => {
      const url = sourceById.get(l.sourceId)!.url;
      return (
        `INSERT OR IGNORE INTO "source_outings" ("source_id", "outing_id") ` +
        `SELECT "id", ${sqlValue(l.outingId)} FROM "sources" WHERE "url" = ${sqlValue(url)};`
      );
    }),
    // outing_count is all-time published outings; last_outing_date the latest among them.
    ...[...usedCourseIds].map(
      (id) =>
        `UPDATE "courses" SET ` +
        `"outing_count" = (SELECT count(*) FROM "outings" WHERE "course_id" = ${sqlValue(id)} AND "published" = 1), ` +
        `"last_outing_date" = (SELECT max("start_date") FROM "outings" WHERE "course_id" = ${sqlValue(id)} AND "published" = 1) ` +
        `WHERE "id" = ${sqlValue(id)};`,
    ),
  ];

  return {
    statements,
    newCourses,
    plan: { ...plan, outings, organizers, sources, sourceOutings: links },
    skipped,
  };
}

function emptyPlan(): SeedPlan {
  return { courses: [], organizers: [], outings: [], sources: [], sourceOutings: [], matches: [], skipped: [] };
}
