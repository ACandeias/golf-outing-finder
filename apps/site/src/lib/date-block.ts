/**
 * The tee sheet's date column ("Mon / 19 / Oct", with the year when it isn't this year), like the hole-number column
 * on a scorecard. Pure and import-free so the browser's near-you list can use it
 * too. Dates are course-local wall dates (YYYY-MM or YYYY-MM-DD), read from their
 * parts, never through a Date in the viewer's zone.
 */

export interface DateBlock {
  /** Weekday, "Expected", or "Date". */
  top: string;
  /** Day of month, a day range, or a month when only the month is known. */
  big: string;
  /** "Oct 2026", or the year alone under a month. */
  bottom: string;
}

export interface DateBlockInput {
  status: string;
  startDate: string | null;
  endDate?: string | null;
  expectedMonth?: string | null;
}

export interface DateBlockOptions {
  /** The site's current year: dates in it show the month alone ("Oct"). */
  currentYear?: number;
  /** Always show the year (past outings). */
  alwaysYear?: boolean;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?/;

function parts(iso: string): { y: number; m: number; d: number | null } | null {
  const hit = ISO.exec(iso);
  if (!hit) return null;
  const m = Number(hit[2]);
  if (m < 1 || m > 12) return null;
  return { y: Number(hit[1]), m, d: hit[3] ? Number(hit[3]) : null };
}

export function dateBlock(o: DateBlockInput, opts: DateBlockOptions = {}): DateBlock {
  const withYear = (month: string, y: number): string =>
    opts.alwaysYear || opts.currentYear === undefined || y !== opts.currentYear ? `${month} ${y}` : month;
  const expected = o.status === "expected";
  const start = o.startDate ? parts(o.startDate) : null;
  if (start?.d) {
    const wd = WD[new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay()] ?? "";
    const end = o.endDate && o.endDate !== o.startDate ? parts(o.endDate) : null;
    const big = end?.d ? `${start.d}–${end.d}` : String(start.d);
    const month = end?.d && end.m !== start.m ? `${MON[start.m - 1]}–${MON[end.m - 1]}` : MON[start.m - 1];
    return { top: expected ? "Expected" : wd, big, bottom: withYear(month ?? "", start.y) };
  }
  const month = o.expectedMonth ? parts(o.expectedMonth) : start;
  if (month) return { top: expected ? "Expected" : "", big: MON[month.m - 1] ?? "", bottom: String(month.y) };
  return { top: "Date", big: "–", bottom: "to come" };
}
