import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type * as NodeSqlite from "node:sqlite";
import { z } from "zod";
import { localToday } from "@gof/shared/dates";
import { ulid } from "@gof/shared/ids";
import { dollarsToCents } from "@gof/shared/money";
import { kebab, truncateAtHyphen, withCollisionSuffix } from "@gof/shared/slug";
import { normalizeUrl } from "../discovery/url.ts";
import { pipelineNow } from "../lib/clock.ts";
import { fromInvocationDir, PATHS } from "../lib/paths.ts";
import { executeLocalD1, queryLocalD1, writeSqlFiles } from "../lib/wrangler.ts";
import { loadPlatforms } from "../discovery/sources.ts";
import { platformRulesFrom } from "../discovery/platform-policy.ts";
import { readRemovals } from "../overrides/files.ts";
import { removedUrlSet } from "../overrides/load.ts";
import { insertStatements, sqlValue } from "../sql/literal.ts";
import { parseTopCoursesFile } from "../topcourses/list.ts";
import { curatedLinkProblems, homePageOnlyCheck } from "./links.ts";

/**
 * Loads researched access opportunities (every way a non-member gets onto a
 * course: auction lots, member-for-a-day, stay-and-play, outings found by
 * research, ...) into `access_opportunities`. Research JSON in, insert-only
 * SQL out; pure apart from the CLI at the bottom. A course resolves through
 * data/top-courses.json osm_refs, then by exact name and state in `courses`;
 * an item at an unknown course is kept unpublished. Page text never reaches
 * this table: titles are the researcher's own words, checked here again.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = [
  "outing",
  "auction",
  "member_for_a_day",
  "stay_and_play",
  "resort_booking",
  "public_tee_time",
  "qualifier",
  "pro_am",
  "charity_dinner",
  "fundraiser_package",
  "other",
] as const;
const PRICE_KINDS = ["entry_fee", "green_fee", "package", "current_bid", "starting_bid", "buy_now", "sold", "donation"] as const;
const usd = z.number().nonnegative().max(1_000_000).nullable();
const text = (max: number) => z.string().trim().min(1).max(max).nullable();

export const accessItemSchema = z.object({
  course_name: z.string().trim().min(1).max(200),
  course_state: z.string().regex(/^[A-Z]{2}$/),
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(160),
  organizer: text(200),
  event_name: text(200),
  platform: z.string().trim().min(2).max(100),
  link: z
    .string()
    .max(2048)
    .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), { message: "must be an http(s) URL" }),
  date_start: z.string().regex(ISO_DATE).nullable(),
  date_end: z.string().regex(ISO_DATE).nullable(),
  season: text(120),
  recurring: z.boolean(),
  price_kind: z.enum(PRICE_KINDS).nullable(),
  price_min_usd: usd,
  price_max_usd: usd,
  players: z.number().int().min(1).max(8).nullable(),
  member_hosted: z.boolean().nullable(),
  status: z.enum(["open", "upcoming", "closed", "recurring", "unknown"]),
  confirmed: z.enum(["fetched", "snippet"]),
  note: text(300),
  /** The day a person checked a hand-added link (data/access-links.json); research runs leave it out. */
  checked_on: z.string().regex(ISO_DATE).nullable().optional(),
});
export type AccessItem = z.infer<typeof accessItemSchema>;

// The first-round research files: { lots: [...], listings: [...] }.
const oldLot = z.object({
  club: z.string(),
  state: z.string(),
  title: z.string(),
  players: z.number().nullable().optional(),
  member_hosted: z.boolean().nullable().optional(),
  organizer: z.string().nullable().optional(),
  auction_name: z.string().nullable().optional(),
  platform: z.string(),
  close_date: z.string().nullable().optional(),
  price_kind: z.string().nullable().optional(),
  price_usd: z.number().nullable().optional(),
  status: z.string(),
  url: z.string(),
  confirmed: z.string(),
});
const oldListing = z.object({
  club: z.string(),
  state: z.string(),
  kind: z.string(),
  title: z.string(),
  organizer: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  platform: z.string(),
  url: z.string(),
  confirmed: z.string(),
});

function fromOldLot(l: z.infer<typeof oldLot>): unknown {
  return {
    course_name: l.club,
    course_state: l.state,
    kind: "auction",
    title: l.title,
    organizer: l.organizer ?? null,
    event_name: l.auction_name ?? null,
    platform: l.platform,
    link: l.url,
    date_start: null,
    date_end: l.close_date ?? null,
    season: null,
    recurring: false,
    price_kind: l.price_usd == null ? null : (l.price_kind ?? null),
    price_min_usd: l.price_usd ?? null,
    price_max_usd: null,
    players: l.players ?? null,
    member_hosted: l.member_hosted ?? null,
    status: l.status,
    confirmed: l.confirmed,
    note: null,
  };
}

function fromOldListing(l: z.infer<typeof oldListing>): unknown {
  const date = l.date ?? null;
  return {
    course_name: l.club,
    course_state: l.state,
    kind: l.kind === "fundraiser_package" ? "fundraiser_package" : "outing",
    title: l.title,
    organizer: l.organizer ?? null,
    event_name: null,
    platform: l.platform,
    link: l.url,
    date_start: date,
    date_end: null,
    season: null,
    recurring: false,
    price_kind: null,
    price_min_usd: null,
    price_max_usd: null,
    players: null,
    member_hosted: null,
    status: date && date < "2026-11-21" ? "closed" : "unknown",
    confirmed: l.confirmed,
    note: null,
  };
}

/** Every valid item in a research file; an invalid entry is dropped, not fatal. */
export function itemsFromFile(json: unknown): AccessItem[] {
  const f = z
    .object({
      opportunities: z.array(z.unknown()).optional(),
      lots: z.array(z.unknown()).optional(),
      listings: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(json);
  const raw: unknown[] = [
    ...(f.opportunities ?? []),
    ...(f.lots ?? []).flatMap((l) => {
      const r = oldLot.safeParse(l);
      return r.success ? [fromOldLot(r.data)] : [];
    }),
    ...(f.listings ?? []).flatMap((l) => {
      const r = oldListing.safeParse(l);
      return r.success ? [fromOldListing(r.data)] : [];
    }),
  ];
  return raw.flatMap((r) => {
    const p = accessItemSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

export const ACCESS_COLUMNS = [
  "id",
  "slug",
  "course_id",
  "course_name",
  "course_state",
  "kind",
  "title",
  "organizer_name",
  "event_name",
  "platform",
  "link",
  "date_start",
  "date_end",
  "season",
  "recurring",
  "price_kind",
  "price_min_cents",
  "price_max_cents",
  "players",
  "member_hosted",
  "status",
  "confirmed",
  "published",
  "hold_reason",
  "first_seen",
  "last_verified",
  "created_at",
  "updated_at",
] as const;
export type AccessRow = Record<(typeof ACCESS_COLUMNS)[number], string | number | null>;

export interface TopCourseRef {
  name: string;
  state: string;
  osm_ref: string | null;
}

export interface AccessPlanInput {
  items: readonly AccessItem[];
  topCourses: readonly TopCourseRef[];
  courseIdByOsmRef: ReadonlyMap<string, string>;
  /** `${state lowercase}/${name lowercase}` to a courses id, for names that are unique in their state. */
  courseIdByName: ReadonlyMap<string, string>;
  now: number;
  existingKeys: readonly string[];
  takenSlugs: ReadonlySet<string>;
  /** removals.yaml URLs, normalized (overrides/load.ts removedUrlSet). An item on one is held as removed. */
  removedUrls?: ReadonlySet<string>;
  /** Names the platform when a link goes past the home page of a site that allows home-page links only. */
  homePageOnly?: (link: string) => string | null;
}

/**
 * A day isn't over until it has ended everywhere in the US, so "past its last
 * day" is judged in the last US time zone, as the site's lists are.
 */
const LAST_US_ZONE = "Pacific/Honolulu";

const baseName = (n: string) =>
  n
    .replace(/\s*\(.*\)\s*$/, "")
    .trim()
    .toLowerCase();

/** An item is its link, kind, course and title: a gala catalog shares one link across its lots. */
export function itemKey(link: string, kind: string, courseName: string, title: string): string {
  return [link, kind, courseName, title].join("\n");
}

export const platformOf = (p: string): string =>
  p
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");

export interface AccessPlan {
  /** Researched items not stored yet: inserted once, never rewritten. */
  rows: AccessRow[];
  /** Hand-checked items (`checked_on`): inserted, or updated in place when the check is at least as new. */
  upserts: AccessRow[];
  skipped: { link: string; reason: string }[];
}

export function buildAccessPlan(input: AccessPlanInput): AccessPlan {
  const iso = new Date(input.now).toISOString();
  const utcDay = iso.slice(0, 10);
  const lastUsDay = localToday(input.now, LAST_US_ZONE);
  const stored = new Set(input.existingKeys);
  const seen = new Set<string>();
  const taken = new Set(input.takenSlugs);
  const rows: AccessRow[] = [];
  const upserts: AccessRow[] = [];
  const skipped: { link: string; reason: string }[] = [];

  for (const it of input.items) {
    const link = normalizeUrl(it.link) ?? it.link;
    const key = itemKey(link, it.kind, it.course_name, it.title);
    const checked = Boolean(it.checked_on);
    if (stored.has(key) && !checked) {
      skipped.push({ link, reason: "already stored" });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ link, reason: "repeated in this load" });
      continue;
    }
    seen.add(key);

    const top = input.topCourses.filter((c) => c.state === it.course_state && baseName(c.name) === baseName(it.course_name));
    const courseId =
      top.map((e) => (e.osm_ref ? input.courseIdByOsmRef.get(e.osm_ref) : undefined)).find(Boolean) ??
      input.courseIdByName.get(`${it.course_state.toLowerCase()}/${it.course_name.trim().toLowerCase()}`) ??
      null;

    let status: string = it.status;
    const end = it.date_end ?? (it.kind === "auction" ? null : it.date_start);
    if ((status === "open" || status === "upcoming") && end !== null && end < lastUsDay) status = "closed";

    // Why an item stays off the site, most serious first.
    const hold = input.removedUrls?.has(link) ? "removed" : input.homePageOnly?.(link) ? "needs_review" : courseId ? null : "course_unmatched";

    // A hand-checked item was last verified on the day it was checked, not the day it was loaded.
    const verifiedAt = it.checked_on && it.checked_on <= utcDay ? `${it.checked_on}T12:00:00.000Z` : iso;
    const slug = withCollisionSuffix(`${it.kind.replace(/_/g, "-")}/${truncateAtHyphen(kebab(`${it.title} ${baseName(it.course_name)}`), 100)}`, taken);
    taken.add(slug);
    const cents = (v: number | null) => (v === null ? null : dollarsToCents(v));

    (checked ? upserts : rows).push({
      id: `acc_${ulid(input.now, createHash("sha256").update(key).digest())}`,
      slug,
      course_id: courseId,
      course_name: it.course_name,
      course_state: it.course_state,
      kind: it.kind,
      title: it.title,
      organizer_name: it.organizer,
      event_name: it.event_name,
      platform: platformOf(it.platform),
      link,
      date_start: it.date_start,
      date_end: it.date_end,
      season: it.season,
      recurring: it.recurring || it.status === "recurring" ? 1 : 0,
      price_kind: it.price_min_usd === null && it.price_max_usd === null ? null : it.price_kind,
      price_min_cents: cents(it.price_min_usd),
      price_max_cents: cents(it.price_max_usd),
      players: it.players,
      member_hosted: it.member_hosted === null ? null : it.member_hosted ? 1 : 0,
      status,
      confirmed: it.confirmed,
      published: hold === null ? 1 : 0,
      hold_reason: hold,
      first_seen: verifiedAt,
      last_verified: verifiedAt,
      created_at: iso,
      updated_at: iso,
    });
  }
  return { rows, upserts, skipped };
}

/** INSERT OR IGNORE: a re-run never overwrites an item already stored. */
export function accessInsertSql(rows: readonly AccessRow[]): string[] {
  return insertStatements("access_opportunities", ACCESS_COLUMNS, rows, { verb: "INSERT OR IGNORE" });
}

/** What a hand-checked entry may change on its stored row. Identity (link, kind, course, title), id, slug and first-seen stay. */
const UPSERT_COLUMNS = [
  "course_id",
  "organizer_name",
  "event_name",
  "platform",
  "date_start",
  "date_end",
  "season",
  "recurring",
  "price_kind",
  "price_min_cents",
  "price_max_cents",
  "players",
  "member_hosted",
  "status",
  "confirmed",
  "published",
  "hold_reason",
  "last_verified",
  "updated_at",
] as const satisfies readonly (typeof ACCESS_COLUMNS)[number][];

/**
 * Hand-checked entries: insert, or update the stored row when this check is at
 * least as new as the one stored. An older copy of the catalog changes nothing.
 */
export function accessUpsertSql(rows: readonly AccessRow[]): string[] {
  const set = UPSERT_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  return insertStatements("access_opportunities", ACCESS_COLUMNS, rows, {
    suffix: `ON CONFLICT(link, kind, course_name, title) DO UPDATE SET ${set} WHERE excluded.last_verified >= access_opportunities.last_verified`,
  });
}

/** Every statement a plan needs, in order. */
export function accessSql(plan: Pick<AccessPlan, "rows" | "upserts">): string[] {
  return [...accessInsertSql(plan.rows), ...accessUpsertSql(plan.upserts)];
}

/** Unpublishes stored rows whose link is in removals.yaml. Nothing to do for an empty list. */
export function accessRemovalSql(removedUrls: ReadonlySet<string>, now: number): string[] {
  if (removedUrls.size === 0) return [];
  const links = [...removedUrls].sort().map((u) => sqlValue(u));
  const out: string[] = [];
  for (let i = 0; i < links.length; i += 50) {
    out.push(
      `UPDATE access_opportunities SET published = 0, hold_reason = 'removed', updated_at = ${sqlValue(new Date(now).toISOString())} ` +
        `WHERE published = 1 AND link IN (${links.slice(i, i + 50).join(", ")});`,
    );
  }
  return out;
}

/** Course lookups for the plan: by OSM ref, and by name for names that are unique in their state. */
export function indexCourses(all: readonly { id: string; name: string; state: string; osm_ref: string | null }[]): {
  byRef: Map<string, string>;
  byName: Map<string, string>;
} {
  const byRef = new Map(all.flatMap((r) => (r.osm_ref ? [[r.osm_ref, r.id] as const] : [])));
  const key = (r: { name: string; state: string }) => `${r.state.toLowerCase()}/${r.name.toLowerCase()}`;
  const nameCount = new Map<string, number>();
  for (const r of all) nameCount.set(key(r), (nameCount.get(key(r)) ?? 0) + 1);
  const byName = new Map(all.flatMap((r) => (nameCount.get(key(r)) === 1 ? [[key(r), r.id] as const] : [])));
  return { byRef, byName };
}

// CLI ----------------------------------------------------------------------

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

type CourseRow = { id: string; name: string; state: string; osm_ref: string | null };
type StoredRow = { link: string; kind: string; course_name: string; title: string; slug: string };
const COURSES_SQL = "SELECT id, name, state, osm_ref FROM courses";
const STORED_SQL = "SELECT link, kind, course_name, title, slug FROM access_opportunities";

/** Courses and stored items from a SQLite file (read-only). The table may not exist yet. */
function readFromFile(path: string): { courses: CourseRow[]; stored: StoredRow[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  const courses = db.prepare(COURSES_SQL).all() as CourseRow[];
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_opportunities'").get();
  const stored = hasTable ? (db.prepare(STORED_SQL).all() as StoredRow[]) : [];
  db.close();
  return { courses, stored };
}

/**
 * `access-load [--courses-db=<sqlite> --sql-out=<file.sql>] [--persist-to=<dir>] [<research.json>...]`
 *
 * With --courses-db and --sql-out it reads that SQLite file and only writes the
 * SQL. Without them it reads the local D1 through wrangler and applies the SQL
 * to it (--persist-to picks the state directory). With no file named it loads
 * the hand-curated link catalog, data/access-links.json, which must pass the
 * curated-link rules.
 */
export async function runLoadAccess(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "courses-db": { type: "string" }, "sql-out": { type: "string" }, "persist-to": { type: "string" } },
    allowPositionals: true,
  });
  const toFile = Boolean(values["courses-db"] || values["sql-out"]);
  if (toFile && (!values["courses-db"] || !values["sql-out"])) {
    console.error("usage: access-load [--courses-db=<sqlite> --sql-out=<file.sql>] [--persist-to=<dir>] [<research.json>...]");
    return 2;
  }
  // Resolved paths, so the catalog gets its rules however its path was typed.
  const files = positionals.length > 0 ? positionals.map((p) => resolve(fromInvocationDir(p))) : [PATHS.accessLinks];
  const homePageOnly = homePageOnlyCheck(platformRulesFrom(await loadPlatforms(PATHS.overrides)));
  const removedUrls = removedUrlSet(await readRemovals(PATHS.removals));

  const items: AccessItem[] = [];
  let dropped = 0;
  for (const file of files) {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    const got = itemsFromFile(json);
    const raw = json as { opportunities?: unknown[]; lots?: unknown[]; listings?: unknown[] };
    dropped += (raw.opportunities?.length ?? 0) + (raw.lots?.length ?? 0) + (raw.listings?.length ?? 0) - got.length;
    if (file === PATHS.accessLinks) {
      const problems = curatedLinkProblems(got, homePageOnly);
      if (problems.length > 0) {
        console.error(`data/access-links.json breaks the curated-link rules:\n  ${problems.join("\n  ")}`);
        return 2;
      }
    }
    items.push(...got);
  }

  const target = { persistTo: values["persist-to"] && fromInvocationDir(values["persist-to"]) };
  const { courses, stored } = toFile
    ? readFromFile(fromInvocationDir(values["courses-db"]!))
    : { courses: queryLocalD1(COURSES_SQL, target) as CourseRow[], stored: queryLocalD1(STORED_SQL, target) as StoredRow[] };
  const { byRef, byName } = indexCourses(courses);
  const now = pipelineNow();

  const plan = buildAccessPlan({
    items,
    topCourses: parseTopCoursesFile(await readFile(PATHS.topCourses, "utf8")).courses,
    courseIdByOsmRef: byRef,
    courseIdByName: byName,
    now,
    existingKeys: stored.map((e) => itemKey(e.link, e.kind, e.course_name, e.title)),
    takenSlugs: new Set(stored.map((e) => e.slug)),
    removedUrls,
    homePageOnly,
  });
  // removals.yaml is honored on every run: rows already stored on a removed link come down too.
  const statements = [...accessRemovalSql(removedUrls, now), ...accessSql(plan)];
  const all = [...plan.rows, ...plan.upserts];
  let where: string;
  if (toFile) {
    where = fromInvocationDir(values["sql-out"]!);
    await writeFile(where, `${statements.join("\n")}\n`);
  } else {
    const sqlFiles = await writeSqlFiles(statements, join(PATHS.cache, "access-sql"), "access");
    executeLocalD1(sqlFiles, target);
    where = "the local D1 (gof)";
  }
  const matched = all.filter((r) => r.course_id !== null).length;
  const held = (reason: string) => all.filter((r) => r.hold_reason === reason).length;
  console.log(
    `access-load: ${all.length} items (${matched} matched to a course, ${all.length - matched} kept unmatched, ` +
      `${held("needs_review")} held for a link the site's terms don't allow, ${held("removed")} held as removed), ` +
      `${plan.skipped.length} skipped, ${dropped} invalid entries dropped -> ${where}`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadAccess(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
