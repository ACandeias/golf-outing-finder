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
import { fromInvocationDir, PATHS } from "../lib/paths.ts";
import { pipelineNow } from "../lib/clock.ts";
import { insertStatements } from "../sql/literal.ts";
import { parseTopCoursesFile } from "../topcourses/list.ts";

/**
 * Loads researched auction lots (docs/plans/auction-lots.md) into
 * `auction_lots`: a JSON file of lots in, insert-only SQL out. Pure apart from
 * the CLI at the bottom. Each lot's club is found on data/top-courses.json and
 * tied to its `courses` row by osm_ref. Every lot waits for the owner's review
 * (published = 0, needs_review), the gate the plan proposes.
 */

const httpUrl = z
  .string()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: "must be an http(s) URL" });
const usd = z.number().nonnegative().max(1_000_000).nullable();

export const lotInputSchema = z.object({
  club: z.string().min(1).max(200),
  state: z.string().regex(/^[A-Z]{2}$/),
  title: z.string().min(1).max(120),
  players: z.number().int().min(1).max(8).nullable().default(null),
  member_hosted: z.boolean().nullable().default(null),
  includes: z.array(z.string().min(1).max(60)).max(12).default([]),
  organizer: z.string().min(1).max(200).nullable().default(null),
  auction_name: z.string().min(1).max(200).nullable().default(null),
  platform: z.string().min(3).max(100),
  close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  price_kind: z.enum(["current_bid", "starting_bid", "buy_now", "sold"]).nullable().default(null),
  price_usd: usd.default(null),
  value_usd: usd.default(null),
  status: z.enum(["open", "closed", "upcoming", "unknown"]),
  url: httpUrl,
  confirmed: z.enum(["fetched", "snippet"]),
});
export type LotInput = z.infer<typeof lotInputSchema>;

export const lotFileSchema = z.object({ lots: z.array(lotInputSchema) }).passthrough();

export const LOT_COLUMNS = [
  "id",
  "slug",
  "course_id",
  "organizer_name",
  "auction_name",
  "title",
  "players",
  "member_hosted",
  "includes",
  "platform",
  "closes_at",
  "price_kind",
  "price_cents",
  "value_cents",
  "price_checked_at",
  "status",
  "lot_url",
  "confirmed",
  "published",
  "hold_reason",
  "first_seen",
  "last_verified",
  "created_at",
  "updated_at",
] as const;
export type LotRow = Record<(typeof LOT_COLUMNS)[number], string | number | null>;

export interface TopCourseRef {
  name: string;
  state: string;
  osm_ref: string | null;
}

export interface LotPlanInput {
  lots: readonly LotInput[];
  topCourses: readonly TopCourseRef[];
  courseIdByOsmRef: ReadonlyMap<string, string>;
  now: number;
  /** `lotKey` of every lot already in the target database. */
  existingKeys: readonly string[];
  takenSlugs: ReadonlySet<string>;
}

const baseName = (n: string) => n.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();

/**
 * A lot is its link, course and title: a gala catalog with no page per lot
 * shares one link across its lots (the table's unique index).
 */
export function lotKey(url: string, courseId: string, title: string): string {
  return `${url}\n${courseId}\n${title}`;
}

/** Deterministic id: the same lot gets the same id on every load. */
function lotId(key: string, now: number): string {
  return `lot_${ulid(now, createHash("sha256").update(key).digest())}`;
}

export function buildLotPlan(input: LotPlanInput): { rows: LotRow[]; skipped: { url: string; reason: string }[] } {
  const iso = new Date(input.now).toISOString();
  const today = iso.slice(0, 10);
  const stored = new Set(input.existingKeys);
  const seen = new Set<string>();
  const taken = new Set(input.takenSlugs);
  const rows: LotRow[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const lot of input.lots) {
    const url = normalizeUrl(lot.url) ?? lot.url;
    const entries = input.topCourses.filter((c) => c.state === lot.state && baseName(c.name) === baseName(lot.club));
    if (entries.length === 0) {
      skipped.push({ url, reason: `no course for ${lot.club}, ${lot.state}` });
      continue;
    }
    const courseId = entries.map((e) => (e.osm_ref ? input.courseIdByOsmRef.get(e.osm_ref) : undefined)).find(Boolean);
    if (!courseId) {
      skipped.push({ url, reason: `no course row for ${lot.club}, ${lot.state}` });
      continue;
    }
    const key = lotKey(url, courseId, lot.title);
    if (stored.has(key)) {
      skipped.push({ url, reason: "already stored" });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ url, reason: "repeated in this load" });
      continue;
    }
    seen.add(key);

    let status: string = lot.price_kind === "sold" ? "sold" : lot.status;
    if (status === "open" && lot.close_date !== null && lot.close_date < today) status = "closed";
    const year = (lot.close_date ?? today).slice(0, 4);
    const slug = withCollisionSuffix(`${year}/${truncateAtHyphen(kebab(`${lot.title} ${baseName(lot.club)}`), 90)}`, taken);
    taken.add(slug);

    rows.push({
      id: lotId(key, input.now),
      slug,
      course_id: courseId,
      organizer_name: lot.organizer,
      auction_name: lot.auction_name,
      title: lot.title,
      players: lot.players,
      member_hosted: lot.member_hosted === null ? null : lot.member_hosted ? 1 : 0,
      includes: JSON.stringify(lot.includes),
      platform: lot.platform.toLowerCase().replace(/^www\./, ""),
      closes_at: lot.close_date,
      price_kind: lot.price_usd === null ? null : lot.price_kind,
      price_cents: lot.price_usd === null ? null : dollarsToCents(lot.price_usd),
      value_cents: lot.value_usd === null ? null : dollarsToCents(lot.value_usd),
      price_checked_at: iso,
      status,
      lot_url: url,
      confirmed: lot.confirmed,
      published: 0,
      hold_reason: "needs_review",
      first_seen: iso,
      last_verified: iso,
      created_at: iso,
      updated_at: iso,
    });
  }
  return { rows, skipped };
}

/** INSERT OR IGNORE, so a re-run never overwrites a lot the owner has reviewed. */
export function lotInsertSql(rows: readonly LotRow[]): string[] {
  return insertStatements("auction_lots", LOT_COLUMNS, rows, { verb: "INSERT OR IGNORE" });
}

// CLI ----------------------------------------------------------------------

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

export async function runLoadLots(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "courses-db": { type: "string" }, "sql-out": { type: "string" } },
    allowPositionals: true,
  });
  if (!values["courses-db"] || !values["sql-out"] || positionals.length === 0) {
    console.error("usage: auction-lots --courses-db=<sqlite> --sql-out=<file.sql> <lots.json>...");
    return 2;
  }
  const lots: LotInput[] = [];
  for (const p of positionals) {
    const parsed = lotFileSchema.safeParse(JSON.parse(await readFile(fromInvocationDir(p), "utf8")));
    if (!parsed.success) {
      console.error(`${p}: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return 1;
    }
    lots.push(...parsed.data.lots);
  }
  const top = parseTopCoursesFile(await readFile(PATHS.topCourses, "utf8")).courses;
  const db = new DatabaseSync(fromInvocationDir(values["courses-db"]), { readOnly: true });
  const byRef = new Map(
    (db.prepare("SELECT id, osm_ref FROM courses WHERE osm_ref IS NOT NULL").all() as { id: string; osm_ref: string }[]).map(
      (r) => [r.osm_ref, r.id] as const,
    ),
  );
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auction_lots'").get();
  const existing = hasTable
    ? (db.prepare("SELECT lot_url, course_id, title, slug FROM auction_lots").all() as {
        lot_url: string;
        course_id: string;
        title: string;
        slug: string;
      }[])
    : [];
  db.close();

  const plan = buildLotPlan({
    lots,
    topCourses: top,
    courseIdByOsmRef: byRef,
    now: pipelineNow(),
    existingKeys: existing.map((e) => lotKey(e.lot_url, e.course_id, e.title)),
    takenSlugs: new Set(existing.map((e) => e.slug)),
  });
  await writeFile(fromInvocationDir(values["sql-out"]), `${lotInsertSql(plan.rows).join("\n")}\n`);
  console.log(`auction-lots: ${plan.rows.length} lots to insert, ${plan.skipped.length} skipped -> ${values["sql-out"]}`);
  for (const s of plan.skipped) console.log(`  - ${s.reason}: ${s.url}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadLots(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
