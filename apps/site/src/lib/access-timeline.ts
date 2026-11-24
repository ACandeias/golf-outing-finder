/**
 * The access timeline: every dated way onto a course, placed by the day to act
 * by (an auction's closing day, an event's first day, an offer's last day), and
 * every recurring one placed where it is expected to come back. Pure: the
 * caller passes today's date and items whose status is already live.
 */
import { actByDate, lastDay } from "@gof/db/access";
import { monthYear, shortDate } from "./format.ts";

export interface TimelineInput {
  id: string;
  kind: string;
  status: string;
  dateStart: string | null;
  dateEnd: string | null;
  recurring: boolean;
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
  /** Open items with no date: tee times, standing packages. */
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

/**
 * The same month and day in the first year that puts it on or after `today`.
 * Feb 29 becomes Feb 28 in a year without one.
 */
export function nextOccurrence(iso: string, today: string): string {
  if (iso >= today) return iso;
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  const on = (year: number): string => {
    const day = m === 2 && d === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1 ? 28 : d;
    return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const thisYear = Number(today.slice(0, 4));
  const candidate = on(thisYear);
  return candidate >= today ? candidate : on(thisYear + 1);
}

const VERBS: Readonly<Record<"auction" | "event" | "offer", string>> = {
  auction: "Bidding closes",
  event: "Starts",
  offer: "Ends",
};
const OFFER_KINDS: ReadonlySet<string> = new Set(["member_for_a_day", "stay_and_play", "resort_booking", "public_tee_time", "fundraiser_package"]);
const family = (kind: string): "auction" | "event" | "offer" => (kind === "auction" ? "auction" : OFFER_KINDS.has(kind) ? "offer" : "event");

const isLive = (status: string): boolean => status === "open" || status === "upcoming";

/**
 * The countdown for an open or upcoming item: "Bidding closes today", "Starts
 * tomorrow", "Ends in 12 days", "Under way until Jan 3, 2027". Null when the
 * item isn't live, has no date, is already over, or is more than
 * COUNTDOWN_DAYS away.
 */
export function deadlineLabel(item: TimelineInput, today: string): string | null {
  if (!isLive(item.status)) return null;
  const by = actByDate(item);
  if (by === null) return null;
  if (by < today) {
    const end = lastDay(item);
    return end !== null && end >= today && family(item.kind) === "event" ? `Under way until ${shortDate(end)}` : null;
  }
  const days = daysBetween(today, by);
  const verb = VERBS[family(item.kind)];
  if (days === 0) return `${verb} today`;
  if (days === 1) return `${verb} tomorrow`;
  return days <= COUNTDOWN_DAYS ? `${verb} in ${days} days` : null;
}

/** Sort by date and group: optionally a "next 7 days" group first, then one group per month. */
function grouped<T extends { id: string }>(entries: TimelineEntry<T>[], soonHeading: string | null): TimelineGroup<T>[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.item.id.localeCompare(b.item.id));
  const groups: TimelineGroup<T>[] = [];
  for (const e of sorted) {
    const soon = soonHeading !== null && e.daysLeft < SOON_DAYS;
    const key = soon ? "week" : e.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else groups.push({ key, heading: soon ? soonHeading : monthYear(key), entries: [e] });
  }
  return groups;
}

/** Build the timeline. Items keep their type, so the caller renders whatever it passed in. */
export function accessTimeline<T extends TimelineInput>(items: readonly T[], today: string): AccessTimeline<T> {
  const upcoming: TimelineEntry<T>[] = [];
  const expected: TimelineEntry<T>[] = [];
  const anytime: T[] = [];

  for (const item of items) {
    const by = actByDate(item);
    const live = isLive(item.status);
    const returning = item.status === "recurring" || (item.status === "closed" && item.recurring);

    if (live || (item.status === "recurring" && by !== null && by >= today)) {
      if (by === null) {
        if (item.status === "open") anytime.push(item);
        continue;
      }
      if (by >= today) {
        const days = daysBetween(today, by);
        const verb = VERBS[family(item.kind)];
        const label = deadlineLabel({ ...item, status: "open" }, today) ?? `${verb} ${shortDate(by)}`;
        upcoming.push({ item, date: by, daysLeft: days, label });
        continue;
      }
      // An event that has started but not finished sits on today.
      const under = deadlineLabel(item, today);
      if (under !== null) upcoming.push({ item, date: today, daysLeft: 0, label: under });
      continue;
    }

    if (returning) {
      const base = by ?? lastDay(item);
      if (base === null) continue;
      const next = nextOccurrence(base, today);
      const said = family(item.kind) === "auction" ? "Last closed" : family(item.kind) === "offer" ? "Last offered until" : "Last held";
      expected.push({ item, date: next, daysLeft: daysBetween(today, next), label: `${said} ${shortDate(base)}` });
    }
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
 * counts once, by its act-by day.
 */
export function monthsSeen(items: readonly TimelineInput[]): { month: number; name: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    const by = actByDate(item) ?? lastDay(item);
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
