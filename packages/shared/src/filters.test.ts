import { describe, expect, it } from "vitest";
import { parseFilterParams } from "./filter-params.ts";
import {
  courseTypesForFilters,
  featuredFirst,
  filtersToParams,
  hasActiveFilters,
  isFeaturedCourse,
  listedCourseTypes,
  matchesFilters,
  NO_FILTERS,
  type FeaturableOuting,
  type FilterableOuting,
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

describe("featuredFirst", () => {
  const o = (id: string, startDate: string | null, courseType: string, notable: boolean): FeaturableOuting => ({
    id,
    startDate,
    course: { courseType, notable },
  });

  it("features private and resort courses on the top-course list only", () => {
    expect(isFeaturedCourse({ courseType: "private", notable: true })).toBe(true);
    expect(isFeaturedCourse({ courseType: "resort", notable: true })).toBe(true);
    expect(isFeaturedCourse({ courseType: "private", notable: false })).toBe(false);
    expect(isFeaturedCourse({ courseType: "public", notable: true })).toBe(false);
    expect(isFeaturedCourse({ courseType: "municipal", notable: true })).toBe(false);
  });

  it("puts featured outings first, then the rest, each by date", () => {
    const soon = [
      o("muni-pub", "2026-10-01", "public", false),
      o("semi", "2026-10-02", "semi_private", false),
      o("top-priv-late", "2026-11-20", "private", true),
      o("top-public", "2026-10-03", "public", true),
      o("priv", "2026-10-04", "private", false),
      o("top-resort", "2026-10-10", "resort", true),
    ];
    expect(featuredFirst([soon], 12).map((x) => x.id)).toEqual([
      "top-resort",
      "top-priv-late",
      "muni-pub",
      "semi",
      "top-public",
      "priv",
    ]);
  });

  it("merges overlapping lists, drops repeats and keeps the limit", () => {
    const featured = [o("a", "2026-12-01", "private", true), o("b", "2026-12-05", "resort", true)];
    const soon = [o("c", "2026-10-01", "public", false), o("a", "2026-12-01", "private", true), o("d", "2026-10-02", "unknown", false)];
    expect(featuredFirst([featured, soon], 3).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the incoming order on a tie", () => {
    const soon = [o("x", "2026-10-01", "private", true), o("y", "2026-10-01", "private", true)];
    expect(featuredFirst([soon], 12).map((x) => x.id)).toEqual(["x", "y"]);
  });
});
