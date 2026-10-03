/** Display strings for one outing, shared by the card and the outing page. */
import type { OutingListItem } from "@gof/db/queries";
import { clockTime, COURSE_TYPE_LABELS, dateRange, includesText, longDate, monthYear, placeText, priceText, shortDate } from "./format.ts";

export interface OutingView {
  /** "Monday, October 19, 2026" / "Dec 15 to 18, 2026" / "Expected in June 2027, date not yet announced". */
  when: string;
  /** "12:00 PM shotgun" or "". */
  time: string;
  place: string;
  courseTypeLabel: string;
  price: string;
  includes: string;
  isExpected: boolean;
  isPast: boolean;
}

export function whenText(o: Pick<OutingListItem, "status" | "startDate" | "endDate" | "expectedMonth">): string {
  if (o.status === "expected") {
    if (o.startDate) return `Expected ${longDate(o.startDate)}`;
    if (o.expectedMonth) return `Expected in ${monthYear(o.expectedMonth)}, date not yet announced`;
    return "Date not yet announced";
  }
  if (!o.startDate) return "Date not yet announced";
  if (o.endDate && o.endDate !== o.startDate) return dateRange(o.startDate, o.endDate);
  return longDate(o.startDate);
}

export function outingView(o: OutingListItem): OutingView {
  return {
    when: whenText(o),
    time: o.shotgunTime && o.status !== "expected" ? `${clockTime(o.shotgunTime)} shotgun` : "",
    place: placeText(o.course.city, o.course.state),
    courseTypeLabel: COURSE_TYPE_LABELS[o.course.courseType],
    price: priceText(o),
    includes: includesText(o.includes),
    isExpected: o.status === "expected",
    isPast: o.status === "past",
  };
}

/** SPEC.md 9.4 outing title. */
export function outingTitle(o: OutingListItem): string {
  // "{Title} at {Course}", without repeating the course when the title already names it.
  const named = o.title.toLowerCase().includes(o.course.name.toLowerCase());
  const where = `${o.title}${named ? "" : ` at ${o.course.name}`}, ${placeText(o.course.city, o.course.state)}`;
  if (o.status === "expected") {
    const month = o.expectedMonth ?? o.startDate;
    return month ? `${where} (expected ${monthYear(month)})` : where;
  }
  return o.startDate ? `${where} (${shortDate(o.startDate)})` : where;
}
