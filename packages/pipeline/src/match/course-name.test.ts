import { describe, expect, it } from "vitest";
import { nameVariants, normalizeCourseName, normalizeCity } from "./course-name.ts";

describe("normalizeCourseName (SPEC 8.6)", () => {
  it.each([
    ["Winged Foot Golf Club", "winged foot"],
    ["Metropolis Country Club", "metropolis"],
    ["The Maidstone Club", "maidstone"],
    ["Maidstone Club", "maidstone"],
    ["Deepdale G.C.", "deepdale"],
    ["Whitmoor CC", "whitmoor"],
    ["Torrey Pines Golf Course (South)", "torrey pines south"],
    ["Torrey Pines South Course", "torrey pines south"],
    ["Bethpage State Park Golf Courses", "bethpage state park"],
    ["The Bear's Club", "bears"],
    ["The Bear’s Club", "bears"],
    ["Medinah Country Club (No. 3)", "medinah no 3"],
    ["Hope & Heroes Links", "hope and heroes"],
    ["Encanto 18 Golf Course", "encanto 18"],
  ])("%s -> %s", (input, out) => {
    expect(normalizeCourseName(input)).toBe(out);
  });

  it("keeps the full name when every word is a stopword", () => {
    expect(normalizeCourseName("The Links")).toBe("the links");
    expect(normalizeCourseName("Golf Club")).toBe("golf club");
  });
});

describe("nameVariants", () => {
  it("adds the name without a parenthetical course designation", () => {
    expect(nameVariants("Medinah Country Club (No. 3)")).toEqual(["medinah no 3", "medinah"]);
    expect(nameVariants("Bethpage State Park (Red Course)")).toEqual([
      "bethpage state park red",
      "bethpage state park",
    ]);
  });
  it("returns one variant when there is no parenthetical", () => {
    expect(nameVariants("Winged Foot Golf Club")).toEqual(["winged foot"]);
  });
});

describe("normalizeCity", () => {
  it("compares city names loosely", () => {
    expect(normalizeCity("St. Louis")).toBe(normalizeCity("Saint Louis"));
    expect(normalizeCity("  Pacific  Palisades ")).toBe("pacific palisades");
    expect(normalizeCity("Mt. Kisco")).toBe(normalizeCity("Mount Kisco"));
  });
});
