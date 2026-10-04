import { localToday } from "@gof/shared/dates";
import { siteNow } from "./env.ts";

/**
 * The zone that decides "upcoming" on national and state lists. Hawaii is the
 * westernmost US zone, so an outing stays listed until its own day has ended
 * everywhere in the country.
 */
export const LIST_TIME_ZONE = "Pacific/Honolulu";

/** Request time, overridden by SITE_NOW outside production (SPEC.md 9.4). */
export function requestNow(): number {
  return siteNow();
}

/** Today's date (YYYY-MM-DD) for list queries. */
export function listToday(nowMs: number = requestNow()): string {
  return localToday(nowMs, LIST_TIME_ZONE);
}

/** The site's current year (from the list zone's today), for the tee sheet's date column. */
export function siteYear(nowMs: number = requestNow()): number {
  return Number(listToday(nowMs).slice(0, 4));
}
