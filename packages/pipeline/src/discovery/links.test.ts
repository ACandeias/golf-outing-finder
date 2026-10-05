import { describe, expect, it } from "vitest";
import { looksLikeEventLink } from "./links.ts";

describe("looksLikeEventLink (series index pages)", () => {
  const index = "https://acsgolf.org/golf-classic-tournaments/";

  it("takes event pages and per-event sites on a subdomain (ACS: akroncanton.acsgolf.org)", () => {
    expect(looksLikeEventLink({ url: "https://akroncanton.acsgolf.org/", text: "" }, index)).toBe(true);
    expect(
      looksLikeEventLink(
        { url: "https://support.kidney.org/event/2026-nkf-golf-classic-at-winged-foot-golf-club/e766893", text: "Register Now" },
        "https://www.kidney.org/take-action/nkf-golf-classic",
      ),
    ).toBe(true);
  });

  it("not the index itself, its own home page, or navigation", () => {
    expect(looksLikeEventLink({ url: "https://acsgolf.org/", text: "Home" }, index)).toBe(false);
    expect(looksLikeEventLink({ url: index, text: "Golf Classic Tournaments" }, index)).toBe(false);
    expect(looksLikeEventLink({ url: "https://acsgolf.org/about/", text: "About Us" }, index)).toBe(false);
  });
});
