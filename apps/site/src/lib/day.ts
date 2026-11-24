/**
 * Day arithmetic per time zone, with no clock or environment of its own: the
 * caller passes the instant. Used for per-course "today" and for cache
 * lifetimes that must end when a course's day does.
 */
import { addDaysIso, localToday, wallTimeToEpoch } from "@gof/shared/dates";

/** Today's date in any time zone, at one instant. */
export function dayAt(nowMs: number): (timeZone: string) => string {
  return (timeZone) => localToday(nowMs, timeZone);
}

/** Whole seconds until the next midnight in `timeZone`; at least 1. */
export function secondsToNextDay(nowMs: number, timeZone: string): number {
  const tomorrow = addDaysIso(localToday(nowMs, timeZone), 1);
  return Math.max(1, Math.ceil((wallTimeToEpoch(tomorrow, "00:00", timeZone) - nowMs) / 1000));
}

/**
 * A cache lifetime that ends no later than the next midnight at any of the
 * given courses. Pages that say "closes tomorrow" or mark a listing closed
 * must not be served from cache into a day when that is no longer true.
 */
export function ttlEndingWithDay(ttlSeconds: number, timeZones: Iterable<string>, nowMs: number): number {
  let ttl = ttlSeconds;
  for (const zone of new Set(timeZones)) ttl = Math.min(ttl, secondsToNextDay(nowMs, zone));
  return ttl;
}
