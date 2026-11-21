import { describe, expect, it } from "vitest";
import { parseFilterParams } from "./filter-params.ts";
import {
  courseTypesForFilters,
  filtersToParams,
  hasActiveFilters,
  isTopCourse,
  listedCourseTypes,
  listParams,
  matchesFilters,
  NO_FILTERS,
  orderOutings,
  parseSort,
  SORT_LABELS,
  type FilterableOuting,
  type RankableOuting,
} from "./filters.ts";

const p = (q: string) => parseFilterParams(new URLSearchParams(q));

describe("parseFilterParams", () => {
  it("parses course_type=private and flags the URL as filtered", () => {
    const r = p("course_type=private");
    expect(r.filters.courseTypes).toEqual(["private"]);
    expect(r.anyFilterParam).toBe(true);
    expect(hasActiveFilters(r.filters)).toBe(true);
  });

  it("groups municipal and public", () => {
    expect(p("course_type=municipal,public&course_type=resort").filters.courseTypes).toEqual([
      "municipal_public",
      "resort",
    ]);
  });

  it("drops invalid values but still counts the parameter for noindex", () => {
    const r = p("course_type=castle&max_price=abc&from=2026-02-30&distance=7");
    expect(r.filters).toEqual(NO_FILTERS);
    expect(r.anyFilterParam).toBe(true);
    expect(r.invalid.sort()).toEqual(["course_type", "distance", "from", "max_price"]);
  });

  it("ignores parameters that are not filters", () => {
    const r = p("utm_source=x");
    expect(r.anyFilterParam).toBe(false);
  });

  it("parses every filter and round-trips", () => {
    const r = p("charity=1&max_price=150&from=2026-10-01&to=2026-10-31&distance=25&format=scramble&singles=true");
    expect(r.filters).toEqual({
      courseTypes: [],
      includeMunicipal: false,
      charityOnly: true,
      maxPriceCents: 15000,
      from: "2026-10-01",
      to: "2026-10-31",
      distanceMiles: 25,
      format: "scramble",
      singlesWelcome: true,
    });
    expect(parseFilterParams(filtersToParams(r.filters)).filters).toEqual(r.filters);
  });

  it("parses include_municipal=1 as a filter parameter and round-trips it", () => {
    const r = p("include_municipal=1");
    expect(r.filters).toEqual({ ...NO_FILTERS, includeMunicipal: true });
    expect(r.anyFilterParam).toBe(true);
    expect(hasActiveFilters(r.filters)).toBe(true);
    expect(filtersToParams(r.filters).toString()).toBe("include_municipal=1");
    expect(p("include_municipal=nope").invalid).toEqual(["include_municipal"]);
  });

  it("the default view hides municipal courses but sets no parameter", () => {
    expect(NO_FILTERS.includeMunicipal).toBe(false);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(filtersToParams(NO_FILTERS).toString()).toBe("");
  });

  it("swaps a reversed date range", () => {
    const r = p("from=2026-11-01&to=2026-10-01");
    expect([r.filters.from, r.filters.to]).toEqual(["2026-10-01", "2026-11-01"]);
  });
});

describe("matchesFilters", () => {
  // Municipal courses included, so the tests below check one filter at a time.
  const ALL = { ...NO_FILTERS, includeMunicipal: true };
  const muniScramble: FilterableOuting = {
    courseType: "municipal",
    outingType: "school_fundraiser",
    singlePriceCents: 15000,
    startDate: "2026-11-07",
    format: "scramble",
    distanceMiles: 8,
  };
  const privateCharity: FilterableOuting = {
    courseType: "private",
    outingType: "charity",
    singlePriceCents: null,
    startDate: "2026-10-19",
    format: null,
    distanceMiles: null,
  };

  it("hides municipal courses by default and keeps every other type", () => {
    expect(matchesFilters(muniScramble, NO_FILTERS)).toBe(false);
    expect(matchesFilters(privateCharity, NO_FILTERS)).toBe(true);
    for (const courseType of ["public", "semi_private", "private", "resort", "unknown"]) {
      expect(matchesFilters({ ...muniScramble, courseType }, NO_FILTERS), courseType).toBe(true);
    }
  });

  it("shows municipal courses when they're included", () => {
    const f = { ...NO_FILTERS, includeMunicipal: true };
    expect(matchesFilters(muniScramble, f)).toBe(true);
    expect(matchesFilters(privateCharity, f)).toBe(true);
  });

  it("a picked course type replaces the default", () => {
    // municipal_public picked: municipal shows even without include_municipal.
    const groupPicked = { ...NO_FILTERS, courseTypes: ["municipal_public" as const] };
    expect(matchesFilters(muniScramble, groupPicked)).toBe(true);
    expect(matchesFilters({ ...muniScramble, courseType: "public" }, groupPicked)).toBe(true);
    expect(matchesFilters(privateCharity, groupPicked)).toBe(false);
    // private picked with include_municipal: the pick still wins.
    const privatePicked = { ...NO_FILTERS, courseTypes: ["private" as const], includeMunicipal: true };
    expect(matchesFilters(muniScramble, privatePicked)).toBe(false);
    expect(matchesFilters(privateCharity, privatePicked)).toBe(true);
  });

  it("filters by course type group", () => {
    const f = { ...NO_FILTERS, courseTypes: ["private" as const] };
    expect(matchesFilters(privateCharity, f)).toBe(true);
    expect(matchesFilters(muniScramble, f)).toBe(false);
    expect(courseTypesForFilters(["municipal_public"])).toEqual(["municipal", "public"]);
  });

  it("treats school fundraisers as charity", () => {
    const f = { ...ALL, charityOnly: true };
    expect(matchesFilters(muniScramble, f)).toBe(true);
    expect(matchesFilters({ ...muniScramble, outingType: "business_association" }, f)).toBe(false);
  });

  it("drops outings without a single price under a price cap or singles filter", () => {
    expect(matchesFilters(privateCharity, { ...ALL, maxPriceCents: 50000 })).toBe(false);
    expect(matchesFilters(muniScramble, { ...ALL, maxPriceCents: 15000 })).toBe(true);
    expect(matchesFilters(muniScramble, { ...ALL, maxPriceCents: 14999 })).toBe(false);
    expect(matchesFilters(privateCharity, { ...ALL, singlesWelcome: true })).toBe(false);
  });

  it("filters by date, distance and format", () => {
    expect(matchesFilters(muniScramble, { ...ALL, from: "2026-11-01", to: "2026-11-30" })).toBe(true);
    expect(matchesFilters(privateCharity, { ...ALL, from: "2026-11-01" })).toBe(false);
    expect(matchesFilters(muniScramble, { ...ALL, distanceMiles: 10 })).toBe(true);
    expect(matchesFilters(privateCharity, { ...ALL, distanceMiles: 100 })).toBe(false);
    expect(matchesFilters(muniScramble, { ...ALL, format: "best_ball" })).toBe(false);
  });
});

describe("listedCourseTypes", () => {
  it("leaves out municipal by default", () => {
    expect(listedCourseTypes(NO_FILTERS)).toEqual(["public", "semi_private", "private", "resort", "unknown"]);
  });

  it("puts no condition on course type when municipal courses are included", () => {
    expect(listedCourseTypes({ courseTypes: [], includeMunicipal: true })).toBeUndefined();
  });

  it("uses the picked groups, with municipal_public meaning both", () => {
    expect(listedCourseTypes({ courseTypes: ["municipal_public"], includeMunicipal: false })).toEqual(["municipal", "public"]);
    expect(listedCourseTypes({ courseTypes: ["resort"], includeMunicipal: true })).toEqual(["resort"]);
  });
});

describe("sort", () => {
  it("defaults to ranking and flags any sort parameter", () => {
    expect(parseSort(new URLSearchParams(""))).toEqual({ sort: "ranking", present: false });
    expect(parseSort(new URLSearchParams("sort=date"))).toEqual({ sort: "date", present: true });
    expect(parseSort(new URLSearchParams("sort=DATE"))).toEqual({ sort: "date", present: true });
    expect(parseSort(new URLSearchParams("sort=price"))).toEqual({ sort: "ranking", present: true });
    expect(SORT_LABELS).toEqual({ ranking: "By ranking", date: "By date" });
  });

  it("keeps filters and a non-default sort in links", () => {
    expect(listParams({ ...NO_FILTERS, includeMunicipal: true }, "date").toString()).toBe("include_municipal=1&sort=date");
    expect(listParams(NO_FILTERS, "ranking").toString()).toBe("");
  });
});

describe("orderOutings", () => {
  const o = (id: string, startDate: string | null, notable: boolean): RankableOuting => ({
    id,
    startDate,
    course: { notable },
  });
  const list = [
    o("a", "2026-10-01", false),
    o("b", "2026-10-02", false),
    o("top-late", "2026-11-20", true),
    o("c", "2026-10-04", false),
    o("top-early", "2026-10-10", true),
    o("top-expected", null, true),
    o("expected", null, false),
  ];

  it("ranking: courses on the top-course list first, each part by date, undated last", () => {
    expect(isTopCourse({ notable: true })).toBe(true);
    expect(orderOutings([list], "ranking").map((x) => x.id)).toEqual([
      "top-early",
      "top-late",
      "top-expected",
      "a",
      "b",
      "c",
      "expected",
    ]);
  });

  it("date: soonest first whatever the course", () => {
    expect(orderOutings([list], "date").map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
      "top-early",
      "top-late",
      "top-expected",
      "expected",
    ]);
  });

  it("merges overlapping lists, drops repeats and keeps the limit", () => {
    const top = [o("t1", "2026-12-01", true), o("t2", "2026-12-05", true)];
    const soon = [o("s1", "2026-10-01", false), o("t1", "2026-12-01", true), o("s2", "2026-10-02", false)];
    expect(orderOutings([top, soon], "ranking", 3).map((x) => x.id)).toEqual(["t1", "t2", "s1"]);
    expect(orderOutings([top, soon], "date", 3).map((x) => x.id)).toEqual(["s1", "s2", "t1"]);
  });

  it("keeps the incoming order on a tie", () => {
    expect(orderOutings([[o("x", "2026-10-01", true), o("y", "2026-10-01", true)]], "ranking").map((x) => x.id)).toEqual([
      "x",
      "y",
    ]);
  });
});
