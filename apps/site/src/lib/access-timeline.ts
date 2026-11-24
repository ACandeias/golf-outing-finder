/**
 * The access timeline: every dated way onto a course, placed by the day to act
 * by (an auction's closing day, an event's first day, an offer's last day), and
 * every recurring one placed where it is expected to come back. Pure: the
 * caller passes today's date and items whose status is already live. Day
 * counts run from each item's own `localToday` when it has one, so a lot at a
 * New York club says "closes today" on its closing day in New York.
 */
import { actByDate, lastDay } from "@gof/db/access";
import { addDaysIso } from "@gof/shared/dates";
import { monthYear, shortDate } from "./format.ts";

export interface TimelineInput {
  id: string;
  kind: string;
  status: string;
  dateStart: string | null;
  dateEnd: string | null;
  recurring: boolean;
  /** Today at the item's course (set by the queries). Countdowns use it; without it the caller's day is used. */
  localToday?: string;
}

export interface TimelineEntry<T> {
  item: T;
  /** The day the entry sits on: the act-by day, or the expected return day. */
  date: string;
  /** Whole days from today to `date`; never negative. */
  daysLeft: number;
  /** "Bidding closes tomorrow", "Starts in 12 days", "Last closed Apr 12, 2026". */
  label: string;
}

export interface TimelineGroup<T> {
  /** "week" or YYYY-MM. */
  key: string;
  heading: string;
  entries: TimelineEntry<T>[];
}

export interface AccessTimeline<T> {
  /** Open and upcoming items with a date, soonest first: the next 7 days, then by month. */
  upcoming: TimelineGroup<T>[];
  /** Recurring items by the month they are expected back. */
  expected: TimelineGroup<T>[];
  /** Open items with no act-by day: tee times, standing packages, a lot with no closing date listed. */
  anytime: T[];
}

/** Days in the "next 7 days" group, today included. */
export const SOON_DAYS = 7;
/** A countdown is spelled out this far ahead; past it the date alone is shown. */
export const COUNTDOWN_DAYS = 30;

const utcDay = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(utcDay(to) - utcDay(from));
}

/** A date's month and day in another year. Feb 29 becomes Feb 28 in a year without one. */
function inYear(iso: string, year: number): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  const day = m === 2 && d === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1 ? 28 : d;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The same month and day in the first year that puts it on or after `today`. A date already ahead is returned as is. */
export function nextOccurrence(iso: string, today: string): string {
  if (iso >= today) return iso;
  const thisYear = Number(today.slice(0, 4));
  const candidate = inYear(iso, thisYear);
  return candidate >= today ? candidate : inYear(iso, thisYear + 1);
}

/** A past date's most recent anniversary on or before `today`. A date not yet past is returned as is. */
export function lastOccurrence(iso: string, today: string): string {
  if (iso >= today) return iso;
  const thisYear = Number(today.slice(0, 4));
  const candidate = inYear(iso, thisYear);
  return candidate <= today ? candidate : inYear(iso, thisYear - 1);
}

const VERBS: Readonly<Record<"auction" | "event" | "offer", string>> = {
  auction: "Bidding closes",
  event: "Starts",
  offer: "Ends",
};
const OFFER_KINDS: ReadonlySet<string> = new Set(["member_for_a_day", "stay_and_play", "resort_booking", "public_tee_time", "fundraiser_package"]);
const family = (kind: string): "auction" | "event" | "offer" => (kind === "auction" ? "auction" : OFFER_KINDS.has(kind) ? "offer" : "event");

const isLive = (status: string): boolean => status === "open" || status === "upcoming";

/** "today", "tomorrow", "in N days" inside COUNTDOWN_DAYS; null past it. */
function inDays(days: number): string | null {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days <= COUNTDOWN_DAYS ? `in ${days} days` : null;
}

/**
 * The countdown for an open or upcoming item: "Bidding closes today", "Starts
 * tomorrow", "Ends in 12 days", "Under way until Jan 3, 2027", or "Bidding
 * opens in 8 days" for a lot that only has its opening day. Null when the item
 * isn't live, has no usable date, is already over, or is more than
 * COUNTDOWN_DAYS away. `today` is the day at the item's course.
 */
export function deadlineLabel(item: TimelineInput, today: string): string | null {
  if (!isLive(item.status)) return null;
  const by = actByDate(item);
  if (by === null) {
    // A lot with no closing day: its start date is the day bidding opens.
    if (item.kind !== "auction" || item.dateStart === null || item.dateStart < today) return null;
    const when = inDays(daysBetween(today, item.dateStart));
    return when === null ? null : `Bidding opens ${when}`;
  }
  if (by < today) {
    const end = lastDay(item);
    return end !== null && end >= today && family(item.kind) === "event" ? `Under way until ${shortDate(end)}` : null;
  }
  const when = inDays(daysBetween(today, by));
  return when === null ? null : `${VERBS[family(item.kind)]} ${when}`;
}

/**
 * Group entries: optionally a "next 7 days" group first, then one group per
 * month. Day counts run from each item's own day, so two items on the same
 * date can fall either side of the 7-day line; the soon ones are gathered
 * first so each group appears once.
 */
function grouped<T extends { id: string }>(entries: TimelineEntry<T>[], soonHeading: string | null): TimelineGroup<T>[] {
  const soon = (e: TimelineEntry<T>): boolean => soonHeading !== null && e.daysLeft < SOON_DAYS;
  const sorted = [...entries].sort(
    (a, b) => Number(!soon(a)) - Number(!soon(b)) || a.date.localeCompare(b.date) || a.item.id.localeCompare(b.item.id),
  );
  const groups: TimelineGroup<T>[] = [];
  for (const e of sorted) {
    const key = soon(e) ? "week" : e.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else groups.push({ key, heading: key === "week" && soonHeading !== null ? soonHeading : monthYear(key), entries: [e] });
  }
  return groups;
}

/** Build the timeline. Items keep their type, so the caller renders whatever it passed in. */
export function accessTimeline<T extends TimelineInput>(items: readonly T[], today: string): AccessTimeline<T> {
  const upcoming: TimelineEntry<T>[] = [];
  const expected: TimelineEntry<T>[] = [];
  const anytime: T[] = [];

  for (const item of items) {
    const now = item.localToday ?? today;
    const by = actByDate(item);
    const end = lastDay(item);
    const kin = family(item.kind);
    // A recurring listing whose dates are still ahead, or under way, is on the calendar like any live one.
    const current = isLive(item.status) || (item.status === "recurring" && end !== null && end >= now);

    if (current) {
      if (by === null) {
        // A lot that only has its opening day sits on that day until it opens.
        if (item.kind === "auction" && item.dateStart !== null && item.dateStart >= now) {
          const opens = deadlineLabel({ ...item, status: "open" }, now) ?? `Bidding opens ${shortDate(item.dateStart)}`;
          upcoming.push({ item, date: item.dateStart, daysLeft: daysBetween(now, item.dateStart), label: opens });
        } else if (item.status === "open") anytime.push(item);
        continue;
      }
      if (by >= now) {
        const label = deadlineLabel({ ...item, status: "open" }, now) ?? `${VERBS[kin]} ${shortDate(by)}`;
        upcoming.push({ item, date: by, daysLeft: daysBetween(now, by), label });
        continue;
      }
      // An event that has started but not finished sits on today.
      const under = deadlineLabel({ ...item, status: "open" }, now);
      if (under !== null) upcoming.push({ item, date: now, daysLeft: 0, label: under });
      continue;
    }

    const returning = item.status === "recurring" || (item.status === "closed" && item.recurring);
    if (!returning) continue;
    // A recurring lot that only has a future opening day is on the calendar, not "expected back".
    if (item.kind === "auction" && by === null && item.dateStart !== null && item.dateStart >= now) {
      const opens = deadlineLabel({ ...item, status: "open" }, now) ?? `Bidding opens ${shortDate(item.dateStart)}`;
      upcoming.push({ item, date: item.dateStart, daysLeft: daysBetween(now, item.dateStart), label: opens });
      continue;
    }
    // A standing offer comes back when its season opens; anything else on the day it ran.
    const base = kin === "offer" ? (item.dateStart ?? item.dateEnd) : (by ?? item.dateEnd ?? item.dateStart);
    const last = end ?? item.dateEnd ?? item.dateStart;
    // Only something that has already happened can be expected back.
    if (base === null || last === null || last >= now) continue;

    // A season offer whose dates, moved forward by whole years, cover today is probably running now.
    if (kin === "offer" && item.dateStart !== null && item.dateEnd !== null) {
      const opened = lastOccurrence(item.dateStart, now);
      const closes = addDaysIso(opened, daysBetween(item.dateStart, item.dateEnd));
      if (closes >= now) {
        const label = `Likely in season now. Last ran ${shortDate(item.dateStart)} to ${shortDate(item.dateEnd)}`;
        expected.push({ item, date: now, daysLeft: 0, label });
        continue;
      }
    }

    const next = nextOccurrence(base, now);
    const said =
      kin === "offer" ? (item.dateEnd ? "Last offered until" : "Last offered from") : kin === "auction" ? (item.dateEnd ? "Last closed" : "Last listed") : "Last held";
    const shown = kin === "offer" ? (item.dateEnd ?? base) : base;
    expected.push({ item, date: next, daysLeft: daysBetween(now, next), label: `${said} ${shortDate(shown)}` });
  }

  return {
    upcoming: grouped(upcoming, "In the next 7 days"),
    // An expected return is a month, not a day, so there is no "next 7 days" group.
    expected: grouped(expected, null),
    anytime,
  };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * The calendar months in which a course's dated items have fallen, in calendar
 * order, with a count: when rounds here tend to come up. Every dated item
 * counts once, by its act-by day (or the only date it carries).
 */
export function monthsSeen(items: readonly TimelineInput[]): { month: number; name: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    const by = actByDate(item) ?? item.dateEnd ?? item.dateStart;
    if (by === null) continue;
    const m = Number(by.slice(5, 7));
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([month, count]) => ({ month, name: MONTH_NAMES[month - 1] ?? "", count }));
}

/** "April (3), November (2)" style sentence part; empty when nothing is dated. */
export function monthsSeenText(items: readonly TimelineInput[]): string {
  const seen = monthsSeen(items);
  if (seen.length === 0) return "";
  const parts = seen.map((s) => (s.count > 1 ? `${s.name} (${s.count})` : s.name));
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
