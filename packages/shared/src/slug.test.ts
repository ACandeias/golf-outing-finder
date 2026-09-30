import { describe, expect, it } from "vitest";
import { courseSlug, kebab, outingSlug, shortCourseSlug } from "./slug.ts";

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
});

describe("courseSlug", () => {
  it("uses state and name", () => {
    expect(courseSlug("NY", "Winged Foot Golf Club")).toBe("ny/winged-foot-golf-club");
  });
  it("appends city on collision", () => {
    expect(courseSlug("CA", "Oakmont Country Club", "Glendale")).toBe(
      "ca/oakmont-country-club-glendale",
    );
  });
});

describe("outingSlug", () => {
  it("drops the year token from the title", () => {
    expect(outingSlug(2026, "NKF Golf Classic 2026", "winged-foot-golf-club")).toBe(
      "2026/nkf-golf-classic-winged-foot-golf-club",
    );
  });
});

describe("shortCourseSlug", () => {
  it("drops the state prefix", () => {
    expect(shortCourseSlug("ny/winged-foot-golf-club")).toBe("winged-foot-golf-club");
  });
});
