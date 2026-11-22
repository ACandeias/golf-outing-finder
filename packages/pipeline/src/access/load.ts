import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type * as NodeSqlite from "node:sqlite";
import { z } from "zod";
import { ulid } from "@gof/shared/ids";
import { dollarsToCents } from "@gof/shared/money";
import { kebab, truncateAtHyphen, withCollisionSuffix } from "@gof/shared/slug";
import { normalizeUrl } from "../discovery/url.ts";
import { pipelineNow } from "../lib/clock.ts";
import { fromInvocationDir, PATHS } from "../lib/paths.ts";
import { insertStatements } from "../sql/literal.ts";
import { parseTopCoursesFile } from "../topcourses/list.ts";

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
}

const baseName = (n: string) =>
  n
    .replace(/\s*\(.*\)\s*$/, "")
    .trim()
    .toLowerCase();

/** An item is its link, kind, course and title: a gala catalog shares one link across its lots. */
export function itemKey(link: string, kind: string, courseName: string, title: string): string {
  return [link, kind, courseName, title].join("\n");
}

const platformOf = (p: string) =>
  p
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");

export function buildAccessPlan(input: AccessPlanInput): { rows: AccessRow[]; skipped: { link: string; reason: string }[] } {
  const iso = new Date(input.now).toISOString();
  const today = iso.slice(0, 10);
  const stored = new Set(input.existingKeys);
  const seen = new Set<string>();
  const taken = new Set(input.takenSlugs);
  const rows: AccessRow[] = [];
  const skipped: { link: string; reason: string }[] = [];

  for (const it of input.items) {
    const link = normalizeUrl(it.link) ?? it.link;
    const key = itemKey(link, it.kind, it.course_name, it.title);
    if (stored.has(key)) {
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
    if ((status === "open" || status === "upcoming") && end !== null && end < today) status = "closed";

    const slug = withCollisionSuffix(`${it.kind.replace(/_/g, "-")}/${truncateAtHyphen(kebab(`${it.title} ${baseName(it.course_name)}`), 100)}`, taken);
    taken.add(slug);
    const cents = (v: number | null) => (v === null ? null : dollarsToCents(v));

    rows.push({
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
      published: courseId ? 1 : 0,
      hold_reason: courseId ? null : "course_unmatched",
      first_seen: iso,
      last_verified: iso,
      created_at: iso,
      updated_at: iso,
    });
  }
  return { rows, skipped };
}

/** INSERT OR IGNORE: a re-run never overwrites an item already stored. */
export function accessInsertSql(rows: readonly AccessRow[]): string[] {
  return insertStatements("access_opportunities", ACCESS_COLUMNS, rows, { verb: "INSERT OR IGNORE" });
}

// CLI ----------------------------------------------------------------------

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

export async function runLoadAccess(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "courses-db": { type: "string" }, "sql-out": { type: "string" } },
    allowPositionals: true,
  });
  if (!values["courses-db"] || !values["sql-out"] || positionals.length === 0) {
    console.error("usage: access-load --courses-db=<sqlite> --sql-out=<file.sql> <research.json>...");
    return 2;
  }
  const items: AccessItem[] = [];
  let dropped = 0;
  for (const p of positionals) {
    const json: unknown = JSON.parse(await readFile(fromInvocationDir(p), "utf8"));
    const got = itemsFromFile(json);
    const raw = json as { opportunities?: unknown[]; lots?: unknown[]; listings?: unknown[] };
    dropped += (raw.opportunities?.length ?? 0) + (raw.lots?.length ?? 0) + (raw.listings?.length ?? 0) - got.length;
    items.push(...got);
  }
  const top = parseTopCoursesFile(await readFile(PATHS.topCourses, "utf8")).courses;
  const db = new DatabaseSync(fromInvocationDir(values["courses-db"]), { readOnly: true });
  const all = db.prepare("SELECT id, name, state, osm_ref FROM courses").all() as {
    id: string;
    name: string;
    state: string;
    osm_ref: string | null;
  }[];
  const byRef = new Map(all.flatMap((r) => (r.osm_ref ? [[r.osm_ref, r.id] as const] : [])));
  const nameCount = new Map<string, number>();
  for (const r of all) {
    const k = `${r.state.toLowerCase()}/${r.name.toLowerCase()}`;
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  const byName = new Map(
    all.flatMap((r) => {
      const k = `${r.state.toLowerCase()}/${r.name.toLowerCase()}`;
      return nameCount.get(k) === 1 ? [[k, r.id] as const] : [];
    }),
  );
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_opportunities'").get();
  const existing = hasTable
    ? (db.prepare("SELECT link, kind, course_name, title, slug FROM access_opportunities").all() as {
        link: string;
        kind: string;
        course_name: string;
        title: string;
        slug: string;
      }[])
    : [];
  db.close();

  const plan = buildAccessPlan({
    items,
    topCourses: top,
    courseIdByOsmRef: byRef,
    courseIdByName: byName,
    now: pipelineNow(),
    existingKeys: existing.map((e) => itemKey(e.link, e.kind, e.course_name, e.title)),
    takenSlugs: new Set(existing.map((e) => e.slug)),
  });
  await writeFile(fromInvocationDir(values["sql-out"]), `${accessInsertSql(plan.rows).join("\n")}\n`);
  const matched = plan.rows.filter((r) => r.course_id !== null).length;
  console.log(
    `access-load: ${plan.rows.length} items (${matched} matched to a course, ${plan.rows.length - matched} kept unmatched), ` +
      `${plan.skipped.length} skipped, ${dropped} invalid entries dropped -> ${values["sql-out"]}`,
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
