import { describe, expect, it } from "vitest";
import {
  citySlug,
  courseShortSlug,
  courseSlug,
  kebab,
  organizerSlug,
  outingSlug,
  truncateAtHyphen,
  withCollisionSuffix,
} from "./slug.ts";

describe("kebab", () => {
  it("lowercases and hyphenates", () => {
    expect(kebab("Winged Foot Golf Club")).toBe("winged-foot-golf-club");
  });
  it("strips diacritics", () => {
    expect(kebab("Café Épée")).toBe("cafe-epee");
  });
  it("trims edge hyphens and collapses runs", () => {
    expect(kebab("  --Foo  Bar!!--  ")).toBe("foo-bar");
  });
  it("spells out ampersands and drops apostrophes", () => {
    expect(kebab("Hope & Heroes Children's Cancer Fund")).toBe(
      "hope-and-heroes-childrens-cancer-fund",
    );
    expect(kebab("The Bear’s Club")).toBe("the-bears-club");
  });
});

describe("courseShortSlug", () => {
  it("drops stopwords", () => {
    expect(courseShortSlug("Winged Foot Golf Club")).toBe("winged-foot");
    expect(courseShortSlug("The Maidstone Club")).toBe("maidstone");
    expect(courseShortSlug("Philadelphia Country Club")).toBe("philadelphia");
    expect(courseShortSlug("Encanto 18 Golf Course")).toBe("encanto-18");
    expect(courseShortSlug("Torrey Pines Golf Course (South)")).toBe("torrey-pines-south");
  });
  it("cuts to 40 characters at a hyphen boundary", () => {
    const slug = courseShortSlug(
      "Bethpage State Park Black Course Championship Practice Facility West",
    );
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe("bethpage-state-park-black-championship");
    expect(slug.endsWith("-")).toBe(false);
  });
  it("keeps the full kebab when every word is a stopword", () => {
    expect(courseShortSlug("The Links")).toBe("the-links");
  });
});

describe("truncateAtHyphen", () => {
  it("leaves short slugs alone", () => {
    expect(truncateAtHyphen("abc-def", 40)).toBe("abc-def");
  });
  it("hard-cuts a single long word", () => {
    expect(truncateAtHyphen("a".repeat(50), 40)).toBe("a".repeat(40));
  });
  it("keeps a word that ends exactly at the limit", () => {
    expect(truncateAtHyphen("abcd-efgh-ij", 9)).toBe("abcd-efgh");
  });
});

describe("withCollisionSuffix", () => {
  it("returns the base when free, then -2, -3", () => {
    expect(withCollisionSuffix("nkf", new Set())).toBe("nkf");
    expect(withCollisionSuffix("nkf", new Set(["nkf"]))).toBe("nkf-2");
    expect(withCollisionSuffix("nkf", new Set(["nkf", "nkf-2"]))).toBe("nkf-3");
  });
  it("accepts a predicate", () => {
    expect(withCollisionSuffix("a", (s) => s === "a")).toBe("a-2");
  });
});

describe("courseSlug", () => {
  it("uses state and name", () => {
    expect(courseSlug("NY", "Winged Foot Golf Club", "Mamaroneck")).toBe(
      "ny/winged-foot-golf-club",
    );
  });
  it("appends the city on collision, then a number", () => {
    const taken = new Set(["ca/oakmont-country-club"]);
    expect(courseSlug("CA", "Oakmont Country Club", "Glendale", taken)).toBe(
      "ca/oakmont-country-club-glendale",
    );
    taken.add("ca/oakmont-country-club-glendale");
    expect(courseSlug("CA", "Oakmont Country Club", "Glendale", taken)).toBe(
      "ca/oakmont-country-club-glendale-2",
    );
  });
  it("goes straight to a number when there is no city", () => {
    expect(courseSlug("AZ", "Encanto", null, new Set(["az/encanto"]))).toBe("az/encanto-2");
  });
});

describe("organizerSlug and citySlug", () => {
  it("kebabs and suffixes on collision", () => {
    expect(organizerSlug("National Kidney Foundation")).toBe("national-kidney-foundation");
    expect(organizerSlug("Golf With Access", new Set(["golf-with-access"]))).toBe(
      "golf-with-access-2",
    );
    expect(citySlug("Pacific Palisades")).toBe("pacific-palisades");
  });
});

describe("outingSlug", () => {
  it("drops the year token and uses the course short slug", () => {
    expect(outingSlug(2026, "NKF Golf Classic 2026", "Winged Foot Golf Club")).toBe(
      "2026/nkf-golf-classic-winged-foot",
    );
  });
  it("matches the SPEC example shape", () => {
    expect(outingSlug(2026, "2026 Fordham Golf Classic", "Winged Foot Golf Club")).toBe(
      "2026/fordham-golf-classic-winged-foot",
    );
  });
  it("suffixes on collision", () => {
    const taken = new Set(["2026/nkf-golf-classic-winged-foot"]);
    expect(outingSlug(2026, "NKF Golf Classic", "Winged Foot Golf Club", taken)).toBe(
      "2026/nkf-golf-classic-winged-foot-2",
    );
  });
});
