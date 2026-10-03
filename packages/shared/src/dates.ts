const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function isHhMm(value: string): boolean {
  return HH_MM.test(value);
}

export function isYearMonth(value: string): boolean {
  return YEAR_MONTH.test(value);
}

/** UTC date of an instant. Prefer `localToday` for anything about an outing. */
export function todayIso(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds calendar months to `YYYY-MM`. */
export function addMonths(yearMonth: string, months: number): string {
  if (!isYearMonth(yearMonth)) throw new Error(`not YYYY-MM: ${yearMonth}`);
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** `YYYY-MM` of a `YYYY-MM-DD`. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** SPEC.md 8.9 roll-forward: the month of (last start_date + 1 calendar year). */
export function rollForwardMonth(lastStartDate: string): string {
  return addMonths(monthOf(lastStartDate), 12);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

function wallParts(epochMs: number, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Throws on an unknown IANA zone. */
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

/** "Today" in the course's time zone (SPEC.md 8.0), as `YYYY-MM-DD`. */
export function localToday(nowMs: number, timeZone: string): string {
  const p = wallParts(nowMs, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Offset of `timeZone` from UTC at an instant, in minutes (New York in October is -240). */
export function offsetMinutesAt(epochMs: number, timeZone: string): number {
  const p = wallParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  const whole = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Converts local wall time in `timeZone` to epoch milliseconds. */
export function wallTimeToEpoch(date: string, time: string, timeZone: string): number {
  if (!isIsoDate(date)) throw new Error(`not YYYY-MM-DD: ${date}`);
  if (!isHhMm(time)) throw new Error(`not HH:MM: ${time}`);
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset across DST transitions.
  let guess = naive - offsetMinutesAt(naive, timeZone) * 60_000;
  guess = naive - offsetMinutesAt(guess, timeZone) * 60_000;
  return guess;
}

/**
 * ISO 8601 with the course's UTC offset, for JSON-LD `startDate` (SPEC.md 9.4):
 * `zonedIso("2026-10-19", "12:00", "America/New_York")` is `2026-10-19T12:00:00-04:00`.
 */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const epoch = wallTimeToEpoch(date, time, timeZone);
  return `${date}T${time}:00${formatOffset(offsetMinutesAt(epoch, timeZone))}`;
}

/** JSON-LD startDate: offset timestamp when the shotgun time is known, else the date. */
export function eventStartDate(date: string, shotgunTime: string | null, timeZone: string): string {
  return shotgunTime ? zonedIso(date, shotgunTime, timeZone) : date;
}

/**
 * An outing is past the day after `end_date ?? start_date`, course-local (SPEC.md 8.9).
 */
export function isPast(
  startDate: string,
  endDate: string | null,
  nowMs: number,
  timeZone: string,
): boolean {
  return localToday(nowMs, timeZone) > (endDate ?? startDate);
}
