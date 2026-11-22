import type { OutingListItem } from "@gof/db/queries";
import { describe, expect, it } from "vitest";
import { listGroups, TOP_COURSES_HEADING } from "./listing.ts";

/** Only the fields listGroups reads. */
const o = (id: string, startDate: string | null, notable: boolean, expectedMonth: string | null = null) =>
  ({ id, startDate, expectedMonth, course: { notable } }) as unknown as OutingListItem;

const dated = [o("oct-1", "2026-10-01", false), o("oct-top", "2026-10-12", true), o("nov-1", "2026-11-03", false)];
const expected = [o("exp-top", null, true, "2027-05"), o("exp-1", null, false, "2027-06")];
const ids = (gs: ReturnType<typeof listGroups>) => gs.map((g) => [g.heading, g.outings.map((x) => x.id)]);

describe("listGroups", () => {
  it("by ranking: top courses first in their own section, then the rest by month", () => {
    expect(ids(listGroups(dated, expected, "ranking"))).toEqual([
      [TOP_COURSES_HEADING, ["oct-top", "exp-top"]],
      ["October 2026", ["oct-1"]],
      ["November 2026", ["nov-1"]],
      ["Expected outings, dates not yet confirmed", ["exp-1"]],
    ]);
  });

  it("by ranking with no top course: months only", () => {
    expect(listGroups([dated[0]!], [], "ranking").map((g) => g.heading)).toEqual(["October 2026"]);
  });

  it("by date: months, then expected outings, whatever the course", () => {
    expect(ids(listGroups(dated, expected, "date"))).toEqual([
      ["October 2026", ["oct-1", "oct-top"]],
      ["November 2026", ["nov-1"]],
      ["Expected outings, dates not yet confirmed", ["exp-top", "exp-1"]],
    ]);
  });
});
