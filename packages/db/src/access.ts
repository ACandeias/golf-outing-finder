/**
 * Read queries for access opportunities (migration 0001): every way a
 * non-member gets onto a course besides a dated outing row. Only published rows
 * at a matched course are ever returned, with the status as of the day asked
 * for: an item whose last day has passed reads as closed.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { accessOpportunities, courses, type AccessKind } from "./schema.ts";
import type { CourseType } from "@gof/shared/schemas";
import type { GofDb } from "./queries.ts";

export interface AccessListItem {
  id: string;
  kind: AccessKind;
  title: string;
  organizerName: string | null;
  eventName: string | null;
  platform: string;
  link: string;
  dateStart: string | null;
  dateEnd: string | null;
  season: string | null;
  recurring: boolean;
  priceKind: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  players: number | null;
  memberHosted: boolean | null;
  status: "open" | "upcoming" | "closed" | "recurring" | "unknown";
  confirmed: "fetched" | "snippet";
  lastVerified: string;
  course: {
    id: string;
    slug: string;
    name: string;
    city: string | null;
    state: string;
    courseType: string;
    notable: boolean;
  };
}

const fields = {
  id: accessOpportunities.id,
  kind: accessOpportunities.kind,
  title: accessOpportunities.title,
  organizerName: accessOpportunities.organizerName,
  eventName: accessOpportunities.eventName,
  platform: accessOpportunities.platform,
  link: accessOpportunities.link,
  dateStart: accessOpportunities.dateStart,
  dateEnd: accessOpportunities.dateEnd,
  season: accessOpportunities.season,
  recurring: accessOpportunities.recurring,
  priceKind: accessOpportunities.priceKind,
  priceMinCents: accessOpportunities.priceMinCents,
  priceMaxCents: accessOpportunities.priceMaxCents,
  players: accessOpportunities.players,
  memberHosted: accessOpportunities.memberHosted,
  status: accessOpportunities.status,
  confirmed: accessOpportunities.confirmed,
  lastVerified: accessOpportunities.lastVerified,
  course: {
    id: courses.id,
    slug: courses.slug,
    name: courses.name,
    city: courses.city,
    state: courses.state,
    courseType: courses.courseType,
    notable: courses.notable,
  },
};

const STATUS_RANK: Record<string, number> = { open: 0, upcoming: 1, recurring: 2, unknown: 3, closed: 4 };

/** Kinds that happen on a day (you enter before they start), as opposed to an auction or a standing offer. */
const EVENT_KINDS: ReadonlySet<string> = new Set(["outing", "qualifier", "pro_am", "charity_dinner", "other"]);

interface Dated {
  kind: string;
  dateStart: string | null;
  dateEnd: string | null;
}

/**
 * The last day someone can still act on an item: an auction's closing day, an
 * event's first day, a standing offer's last day. Null when no date is known.
 */
export function actByDate(item: Dated): string | null {
  if (item.kind === "auction") return item.dateEnd ?? item.dateStart;
  if (EVENT_KINDS.has(item.kind)) return item.dateStart ?? item.dateEnd;
  return item.dateEnd ?? item.dateStart;
}

/**
 * The day after which an item is over. An auction with no closing date never
 * ends on its own: its start date says nothing about when bidding closes.
 */
export function lastDay(item: Dated): string | null {
  return item.dateEnd ?? (item.kind === "auction" ? null : item.dateStart);
}

/**
 * The status as of `today`: an open or upcoming item whose last day has passed
 * is closed, whatever was stored when it was loaded.
 */
export function liveStatus<S extends string>(item: Dated & { status: S }, today: string): S | "closed" {
  if (item.status !== "open" && item.status !== "upcoming") return item.status;
  const end = lastDay(item);
  return end !== null && end < today ? "closed" : item.status;
}

/**
 * Open and upcoming first (soonest act-by date first), then recurring and
 * unknown, then closed (most recent first). `today` puts dated items that are
 * still ahead before ones already under way.
 */
export function orderAccess<T extends Dated & { id: string; status: string }>(items: readonly T[], today: string): T[] {
  return [...items].sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (r !== 0) return r;
    // Closed items sort by the day they ended; everything else by the day to act by.
    const wa = a.status === "closed" ? (lastDay(a) ?? actByDate(a)) : actByDate(a);
    const wb = b.status === "closed" ? (lastDay(b) ?? actByDate(b)) : actByDate(b);
    if (wa === wb) return a.id.localeCompare(b.id);
    if (wa === null) return 1;
    if (wb === null) return -1;
    if (a.status === "closed") return wb.localeCompare(wa);
    const fa = wa >= today ? 0 : 1;
    const fb = wb >= today ? 0 : 1;
    return fa - fb || wa.localeCompare(wb);
  });
}

type Row = Awaited<ReturnType<typeof select>>[number];

function select(db: GofDb, where: ReturnType<typeof and>) {
  return db
    .select(fields)
    .from(accessOpportunities)
    .innerJoin(courses, eq(accessOpportunities.courseId, courses.id))
    .where(where);
}

function toItem(r: Row, today: string): AccessListItem {
  return {
    ...r,
    status: liveStatus(r, today),
    recurring: r.recurring === 1,
    memberHosted: r.memberHosted === null ? null : r.memberHosted === 1,
    course: { ...r.course, notable: r.course.notable === 1 },
  };
}

const published = and(eq(accessOpportunities.published, 1), isNotNull(accessOpportunities.courseId));

/** A course's published items, best first. */
export async function accessForCourse(db: GofDb, courseId: string, today: string): Promise<AccessListItem[]> {
  const rows = await select(db, and(published, eq(accessOpportunities.courseId, courseId)));
  return orderAccess(rows.map((r) => toItem(r, today)), today);
}

/**
 * Items at courses on the top-course list (courses.notable) for the home page,
 * best first. `courseTypes` limits the course types (the home page's municipal default).
 */
export async function featuredAccess(
  db: GofDb,
  today: string,
  limit: number,
  courseTypes?: readonly CourseType[],
): Promise<AccessListItem[]> {
  const rows = await select(
    db,
    and(published, eq(courses.notable, 1), courseTypes ? inArray(courses.courseType, [...courseTypes]) : undefined),
  );
  return orderAccess(rows.map((r) => toItem(r, today)), today).slice(0, limit);
}

/** Every published item (the /top-courses page), best first. */
export async function accessPage(db: GofDb, today: string): Promise<AccessListItem[]> {
  const rows = await select(db, published);
  return orderAccess(rows.map((r) => toItem(r, today)), today);
}

/** True when a course has a published access item (its page then exists). */
export async function courseHasAccess(db: GofDb, courseId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(accessOpportunities)
    .where(and(published, eq(accessOpportunities.courseId, courseId)));
  return (rows[0]?.n ?? 0) > 0;
}
