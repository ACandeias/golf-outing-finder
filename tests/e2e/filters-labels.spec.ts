/**
 * Filters and indexing (SPEC.md 9.2, 9.4, 13 Phase 1 item 4) and the display
 * label table (8.5, 9.3).
 */
import { cardFor, expect, siteOrigin, test } from "./support/fixtures.ts";
import { canonicals, isNoindex } from "./support/html.ts";
import {
  BUILDERS_METROPOLIS,
  ENCANTO,
  FORDHAM_WINGED_FOOT,
  GRADY,
  GWA_QUAKER_RIDGE_EXPECTED,
  NKF_WINGED_FOOT,
  TORREY_TWO_MAN,
  type SeedOuting,
} from "./support/seed-facts.ts";

const CITY = "/golf-outings/ny/mamaroneck";

test.describe("filter parameters", () => {
  test("?course_type=private: noindex and a canonical to the unfiltered URL", async ({
    request,
    baseURL,
  }) => {
    // 13 Phase 1, item 4: "Given ?course_type=private on a city page, the page has
    // noindex and a canonical to the unfiltered URL". 9.2: "Any URL with a filter
    // parameter gets noindex and a canonical pointing at the unfiltered page".
    const res = await request.get(`${CITY}?course_type=private`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<meta\s[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i);
    expect(isNoindex(html)).toBe(true);
    expect(canonicals(html)).toEqual([`${siteOrigin(baseURL)}${CITY}`]);
  });

  test("the unfiltered city page is indexable and self-canonical", async ({ request, baseURL }) => {
    // 9.1 city: indexed "when the city has an upcoming outing"; 9.4: canonicals on every page.
    const res = await request.get(CITY);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(isNoindex(html, res.headers()["x-robots-tag"])).toBe(false);
    expect(canonicals(html)).toEqual([`${siteOrigin(baseURL)}${CITY}`]);
  });

  for (const query of [
    "charity=1",
    "max_price=200",
    "format=scramble",
    "singles=1",
    "distance=25",
    "from=2026-10-01",
  ]) {
    test(`?${query} is noindex with the unfiltered canonical`, async ({ request, baseURL }) => {
      // 9.2: every filter parameter (course type, charity only, max price, date range,
      // distance, format, singles welcome) triggers the noindex rule.
      const res = await request.get(`${CITY}?${query}`);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(isNoindex(html)).toBe(true);
      expect(canonicals(html)).toEqual([`${siteOrigin(baseURL)}${CITY}`]);
    });
  }

  test("?course_type=private on a charity city page and a state page", async ({
    request,
    baseURL,
  }) => {
    // 9.2 applies to "City and state pages".
    for (const path of ["/charity-golf-tournaments/ny/mamaroneck", "/golf-outings/ny"]) {
      const res = await request.get(`${path}?course_type=private`);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(isNoindex(html), path).toBe(true);
      expect(canonicals(html), path).toEqual([`${siteOrigin(baseURL)}${path}`]);
    }
  });

  test("a city with no outings in the last 12 months is not indexed", async ({ request }) => {
    // 9.1 city: indexed only "when the city has an upcoming outing or one in the last
    // 12 months". Scarsdale, NY is a GeoNames city with no seeded outing.
    const res = await request.get("/golf-outings/ny/scarsdale");
    if (res.status() === 200) {
      expect(isNoindex(await res.text(), res.headers()["x-robots-tag"])).toBe(true);
    } else {
      expect(res.status()).toBe(404);
    }
  });
});

test.describe("display labels (8.5 label table)", () => {
  // Every seeded organizer is `unverified` (the IRS lookup is Phase 2), so a charity
  // outing shows "Fundraiser, charity status unverified" and never "Charity".
  const CASES: [SeedOuting, string][] = [
    [NKF_WINGED_FOOT, "Fundraiser, charity status unverified"],
    [ENCANTO, "Fundraiser, charity status unverified"], // no organizer (gc4)
    [FORDHAM_WINGED_FOOT, "School fundraiser"], // gc2
    [GRADY, "School fundraiser"], // gc5
    [BUILDERS_METROPOLIS, "Trade group outing"], // gc3
    [GWA_QUAKER_RIDGE_EXPECTED, "Access day"],
    [TORREY_TWO_MAN, "Open tournament"], // gc6
  ];

  for (const [o, label] of CASES) {
    test(`${o.seedId} shows "${label}"`, async ({ page }) => {
      // 9.3: "an outing type badge from the label table in section 8.5".
      const res = await page.goto(`/outings/${o.slug}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator("main")).toContainText(label);
    });
  }

  test("unverified charity outings never show the plain Charity badge", async ({ page }) => {
    // 8.5: "Charity" only when the organizer's charity_status is 501c3.
    await page.goto(`/outings/${NKF_WINGED_FOOT.slug}`);
    const exactCharity = page.locator("main").getByText("Charity", { exact: true });
    await expect(exactCharity).toHaveCount(0);
  });

  test("cards on the Mamaroneck page carry their labels", async ({ page }) => {
    // 9.3 card: "an outing type badge"; e10 is listed only if expected outings appear on city pages.
    await page.goto(CITY);
    const nkf = await cardFor(page, NKF_WINGED_FOOT.slug);
    expect(nkf?.text).toContain("Fundraiser, charity status unverified");
    const fordham = await cardFor(page, FORDHAM_WINGED_FOOT.slug);
    expect(fordham?.text).toContain("School fundraiser");
  });
});
