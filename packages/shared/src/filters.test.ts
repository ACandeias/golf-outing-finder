import { describe, expect, it } from "vitest";
import { parseFilterParams } from "./filter-params.ts";
import { courseTypesForFilters, filtersToParams, hasActiveFilters, matchesFilters, NO_FILTERS, type FilterableOuting } from "./filters.ts";

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

  it("swaps a reversed date range", () => {
    const r = p("from=2026-11-01&to=2026-10-01");
    expect([r.filters.from, r.filters.to]).toEqual(["2026-10-01", "2026-11-01"]);
  });
});

describe("matchesFilters", () => {
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

  it("passes everything with no filters", () => {
    expect(matchesFilters(muniScramble, NO_FILTERS)).toBe(true);
    expect(matchesFilters(privateCharity, NO_FILTERS)).toBe(true);
  });

  it("filters by course type group", () => {
    const f = { ...NO_FILTERS, courseTypes: ["private" as const] };
    expect(matchesFilters(privateCharity, f)).toBe(true);
    expect(matchesFilters(muniScramble, f)).toBe(false);
    expect(courseTypesForFilters(["municipal_public"])).toEqual(["municipal", "public"]);
  });

  it("treats school fundraisers as charity", () => {
    const f = { ...NO_FILTERS, charityOnly: true };
    expect(matchesFilters(muniScramble, f)).toBe(true);
    expect(matchesFilters({ ...muniScramble, outingType: "business_association" }, f)).toBe(false);
  });

  it("drops outings without a single price under a price cap or singles filter", () => {
    expect(matchesFilters(privateCharity, { ...NO_FILTERS, maxPriceCents: 50000 })).toBe(false);
    expect(matchesFilters(muniScramble, { ...NO_FILTERS, maxPriceCents: 15000 })).toBe(true);
    expect(matchesFilters(muniScramble, { ...NO_FILTERS, maxPriceCents: 14999 })).toBe(false);
    expect(matchesFilters(privateCharity, { ...NO_FILTERS, singlesWelcome: true })).toBe(false);
  });

  it("filters by date, distance and format", () => {
    expect(matchesFilters(muniScramble, { ...NO_FILTERS, from: "2026-11-01", to: "2026-11-30" })).toBe(true);
    expect(matchesFilters(privateCharity, { ...NO_FILTERS, from: "2026-11-01" })).toBe(false);
    expect(matchesFilters(muniScramble, { ...NO_FILTERS, distanceMiles: 10 })).toBe(true);
    expect(matchesFilters(privateCharity, { ...NO_FILTERS, distanceMiles: 100 })).toBe(false);
    expect(matchesFilters(muniScramble, { ...NO_FILTERS, format: "best_ball" })).toBe(false);
  });
});
