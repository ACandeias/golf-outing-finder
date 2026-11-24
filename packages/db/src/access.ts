/**
 * Read queries for access opportunities (migration 0001): every way a
 * non-member gets onto a course besides a dated outing row. Only published rows
 * at a matched course are ever returned, with the status as of the day asked
 * for (the course's own day when a LocalDay is passed): an item whose last day
 * has passed reads as closed.
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
    timeZone: string;
  };
  /** Today's date at the course when the item was read; its status and countdown are as of this day. */
  localToday: string;
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
    timeZone: courses.timeZone,
  },
};

// Open and upcoming share a rank: among live items only the day to act by decides the order.
const STATUS_RANK: Record<string, number> = { open: 0, upcoming: 0, recurring: 2, unknown: 3, closed: 4 };

/** Kinds that happen on a day (you enter before they start), as opposed to an auction or a standing offer. */
const EVENT_KINDS: ReadonlySet<string> = new Set(["outing", "qualifier", "pro_am", "charity_dinner", "other"]);

interface Dated {
  kind: string;
  dateStart: string | null;
  dateEnd: string | null;
}

/**
 * The last day someone can still act on an item: an auction's closing day, an
 * event's first day, a standing offer's last day. Null when that day isn't
 * known. An auction's start date is never a closing day, so a lot with no
 * closing date has no act-by day.
 */
export function actByDate(item: Dated): string | null {
  if (item.kind === "auction") return item.dateEnd;
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
 * Open and upcoming together, the soonest act-by day first (days still ahead
 * before ones under way, undated last), then recurring and unknown, then
 * closed (most recent first).
 */
export function orderAccess<T extends Dated & { id: string; status: string }>(items: readonly T[], today: string): T[] {
  // Closed items sort by whichever date they carry; everything else by the day to act by.
  const when = (o: T): string | null => (o.status === "closed" ? (o.dateEnd ?? o.dateStart) : actByDate(o));
  return [...items].sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
    if (r !== 0) return r;
    const wa = when(a);
    const wb = when(b);
    if (wa === wb) return a.id.localeCompare(b.id);
    if (wa === null) return 1;
    if (wb === null) return -1;
    if (a.status === "closed") return wb.localeCompare(wa);
    const fa = wa >= today ? 0 : 1;
    const fb = wb >= today ? 0 : 1;
    return fa - fb || wa.localeCompare(wb);
  });
}

/**
 * Today's date in a course's time zone. Passed to the queries so each item's
 * status is as of its own course's day; without it the list day is used.
 */
export type LocalDay = (timeZone: string) => string;

type Row = Awaited<ReturnType<typeof select>>[number];

function select(db: GofDb, where: ReturnType<typeof and>) {
  return db
    .select(fields)
    .from(accessOpportunities)
    .innerJoin(courses, eq(accessOpportunities.courseId, courses.id))
    .where(where);
}

function toItem(r: Row, today: string, localDay?: LocalDay): AccessListItem {
  const day = localDay ? localDay(r.course.timeZone) : today;
  return {
    ...r,
    localToday: day,
    status: liveStatus(r, day),
    recurring: r.recurring === 1,
    memberHosted: r.memberHosted === null ? null : r.memberHosted === 1,
    course: { ...r.course, notable: r.course.notable === 1 },
  };
}

const published = and(eq(accessOpportunities.published, 1), isNotNull(accessOpportunities.courseId));

/** A course's published items, best first. */
export async function accessForCourse(db: GofDb, courseId: string, today: string, localDay?: LocalDay): Promise<AccessListItem[]> {
  const rows = await select(db, and(published, eq(accessOpportunities.courseId, courseId)));
  return orderAccess(rows.map((r) => toItem(r, today, localDay)), today);
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
  localDay?: LocalDay,
): Promise<AccessListItem[]> {
  const rows = await select(
    db,
    and(published, eq(courses.notable, 1), courseTypes ? inArray(courses.courseType, [...courseTypes]) : undefined),
  );
  return orderAccess(rows.map((r) => toItem(r, today, localDay)), today).slice(0, limit);
}

/** Every published item (the /top-courses page), best first. */
export async function accessPage(db: GofDb, today: string, localDay?: LocalDay): Promise<AccessListItem[]> {
  const rows = await select(db, published);
  return orderAccess(rows.map((r) => toItem(r, today, localDay)), today);
}

/** True when a course has a published access item (its page then exists). */
export async function courseHasAccess(db: GofDb, courseId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(accessOpportunities)
    .where(and(published, eq(accessOpportunities.courseId, courseId)));
  return (rows[0]?.n ?? 0) > 0;
}
