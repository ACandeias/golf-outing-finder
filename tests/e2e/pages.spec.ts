/**
 * Every Phase 1 page route renders from the seed (SPEC.md 9.1, 9.3, 9.4, 13
 * Phase 1) with the clock pinned to 2026-09-28.
 */
import {
  cardFor,
  expect,
  linkPaths,
  outingLinkSlugs,
  rowTextForLink,
  sameUrl,
  test,
} from "./support/fixtures.ts";
import type { Page } from "@playwright/test";
import { titleOf } from "./support/html.ts";
import {
  AUTISM_SPEAKS_EXPECTED,
  BUILDERS_METROPOLIS,
  DATED_OUTING_SLUGS,
  ENCANTO,
  FORDHAM_WINGED_FOOT,
  GWA_QUAKER_RIDGE_EXPECTED,
  NKF_WINGED_FOOT,
  STATES_WITH_OUTINGS,
  UPCOMING_BY_STATE,
} from "./support/seed-facts.ts";

test.describe("home /", () => {
  /** Outing slugs in the "Coming up" list, in order. */
  const comingUp = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('section[aria-labelledby="soonest"] .tee-title a')].map((a) =>
        new URL(a.href).pathname.slice("/outings/".length),
      ),
    );
  const TOP_PRIVATE_IN_DATE_ORDER = [
    "2026/nkf-golf-classic-at-philadelphia-country-club-philadelphia", // Oct 12
    FORDHAM_WINGED_FOOT.slug, // Oct 13
    NKF_WINGED_FOOT.slug, // Oct 19
    "2026/george-d-yates-golf-outing-maidstone", // Oct 30
    "2026/legends-on-the-links-riviera", // Nov 2
  ];
  const MUNICIPAL = [
    ENCANTO.slug,
    "2026/thrivers-and-survivors-charity-golf-tournament-tpc-harding-park",
    "2026/grady-charity-golf-scramble-rocky-point",
    "2026/amateurgolf-com-two-man-links-and-father-and-son-at-torrey-pines-torrey-pines-south",
  ];

  test("links to states and lists upcoming outings nationally", async ({ page }) => {
    // 9.1 `/`: "upcoming outings near the visitor (browser location, falling back
    // to a national list), state links". No geolocation is granted here.
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const paths = await linkPaths(page);
    expect(paths).toContain("/golf-outings/ny");
    expect(await comingUp(page)).toContain(BUILDERS_METROPOLIS.slug);
  });

  test("leaves out municipal courses and puts top private clubs first, then by date", async ({ page }) => {
    await page.goto("/");
    const slugs = await comingUp(page);
    for (const m of MUNICIPAL) expect(slugs, m).not.toContain(m);
    // Private clubs on the top-course list lead, soonest first; then the rest by
    // date (Metropolis is private but not on the list, so it waits its turn).
    expect(slugs.slice(0, TOP_PRIVATE_IN_DATE_ORDER.length)).toEqual(TOP_PRIVATE_IN_DATE_ORDER);
    expect(slugs.slice(TOP_PRIVATE_IN_DATE_ORDER.length)).toEqual([
      BUILDERS_METROPOLIS.slug, // Oct 7
      "2026/scramble-for-charity-golf-tournament-whitmoor-north", // Oct 19
      "2026/hyslop-drive-fore-a-cure-arizona-biltmore", // Oct 30
      "2026/12th-annual-brian-ong-memorial-charity-golf-tournament-mccormick-ranch", // Oct 31, public
    ]);
    const toggle = page.getByRole("switch", { name: "Include municipal courses" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });

  test("the toggle brings municipal courses back, noindexed", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("switch", { name: "Include municipal courses" }).click();
    await expect(page).toHaveURL(/[?&]include_municipal=1/);
    await expect(page.getByRole("switch", { name: "Include municipal courses" })).toHaveAttribute("aria-checked", "true");
    const slugs = await comingUp(page);
    expect(slugs).toContain(ENCANTO.slug);
    // Top private clubs still come first.
    expect(slugs.slice(0, TOP_PRIVATE_IN_DATE_ORDER.length)).toEqual(TOP_PRIVATE_IN_DATE_ORDER);
    expect(slugs.at(TOP_PRIVATE_IN_DATE_ORDER.length)).toBe(ENCANTO.slug); // Oct 3
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/$/);
  });

  test("a picked course type replaces the default", async ({ page }) => {
    await page.goto("/?course_type=municipal_public");
    const slugs = await comingUp(page);
    expect(slugs).toContain(ENCANTO.slug);
    expect(slugs).not.toContain(NKF_WINGED_FOOT.slug);
    await expect(page.getByRole("switch", { name: "Include municipal courses" })).toBeHidden();
  });

  test("has a city or zip search field with a label", async ({ page }) => {
    // 9.1 `/`: "city or zip search"; 9.7: "labeled form fields".
    await page.goto("/");
    const box = page.getByRole("searchbox").or(page.getByRole("textbox")).first();
    await expect(box).toBeVisible();
    await expect(box).toHaveAccessibleName(/city|zip/i);
  });
});

test.describe("national hub /golf-outings", () => {
  test("shows upcoming counts by state and the soonest outings", async ({ page }) => {
    // 9.1 `/golf-outings`: "national hub: upcoming counts by state, soonest outings, state links".
    const res = await page.goto("/golf-outings");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const [state, count] of Object.entries(UPCOMING_BY_STATE)) {
      const row = await rowTextForLink(page, `/golf-outings/${state.toLowerCase()}`);
      expect(row, `link to /golf-outings/${state.toLowerCase()}`).not.toBeNull();
      // The first number in the state's row is its upcoming count.
      expect(
        /\d+/.exec(row ?? "")?.[0],
        `${state} row "${row ?? ""}" shows ${count} upcoming`,
      ).toBe(String(count));
    }
    expect(await outingLinkSlugs(page)).toContain(ENCANTO.slug);
  });
});

test.describe("state /golf-outings/ny", () => {
  test("lists New York outings by month and links to its cities", async ({ page }) => {
    // 9.1 `/golf-outings/[state]`: "outings in the state by month, city links".
    const res = await page.goto("/golf-outings/ny");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/New York|NY/);
    await expect(page.getByText(/October 2026/).first()).toBeVisible();
    const slugs = await outingLinkSlugs(page);
    for (const o of [BUILDERS_METROPOLIS, FORDHAM_WINGED_FOOT, NKF_WINGED_FOOT])
      expect(slugs).toContain(o.slug);
    // Only New York outings among the dated ones.
    expect(slugs).not.toContain(ENCANTO.slug);
    const paths = await linkPaths(page);
    for (const city of ["mamaroneck", "white-plains", "east-hampton"])
      expect(paths).toContain(`/golf-outings/ny/${city}`);
  });

  test("every state with a published outing has a page", async ({ request }) => {
    // 9.1: the state route exists for each state with outings (sitemapped in 9.4).
    for (const st of STATES_WITH_OUTINGS) {
      const res = await request.get(`/golf-outings/${st}`);
      expect(res.status(), `/golf-outings/${st}`).toBe(200);
    }
  });
});

test.describe("city /golf-outings/ny/mamaroneck", () => {
  test("Phase 1 acceptance: both Winged Foot outings show as Private with Register links", async ({
    page,
  }) => {
    // 13 Phase 1, item 1: "when I open /golf-outings/ny/mamaroneck, then both Winged
    // Foot outings (October 13 and October 19, 2026) show as Private with working
    // Register links".
    const res = await page.goto("/golf-outings/ny/mamaroneck");
    expect(res?.status()).toBe(200);
    // 9.4 titles: "City: Golf Outings and Charity Tournaments in {City}, {ST}".
    await expect(page).toHaveTitle("Golf Outings and Charity Tournaments in Mamaroneck, NY");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Mamaroneck");

    // Exactly the two dated outings in Mamaroneck; expected ones may also be listed.
    const dated = (await outingLinkSlugs(page)).filter((s) =>
      (DATED_OUTING_SLUGS as readonly string[]).includes(s),
    );
    expect(dated.sort()).toEqual([FORDHAM_WINGED_FOOT.slug, NKF_WINGED_FOOT.slug].sort());

    for (const [o, date] of [
      [FORDHAM_WINGED_FOOT, /Oct(ober)?\.? 13,? 2026/],
      [NKF_WINGED_FOOT, /Oct(ober)?\.? 19,? 2026/],
    ] as const) {
      const card = await cardFor(page, o.slug);
      expect(card, `card for ${o.slug}`).not.toBeNull();
      // 9.3: "a course type badge"; badges carry text.
      expect(card?.text).toContain("Private");
      expect(card?.text).toContain(o.courseName);
      expect(card?.text).toMatch(date);
      // 9.3: outing type badge from the label table (8.5).
      expect(card?.text).toContain(o.label);
      // 9.3: "a Register button to registration_url".
      expect(card?.registerHrefs.length, `Register link on ${o.slug}`).toBeGreaterThan(0);
      expect(card?.registerHrefs.some((h) => sameUrl(h, o.registrationUrl ?? ""))).toBe(true);
    }
  });

  test("links to nearby cities", async ({ page }) => {
    // 9.1 city: "nearby cities"; 9.4: "city to nearby cities". White Plains is ~9 km away.
    await page.goto("/golf-outings/ny/mamaroneck");
    expect(await linkPaths(page)).toContain("/golf-outings/ny/white-plains");
  });

  test("offers filters and a map toggle", async ({ page }) => {
    // 9.1 city: "list, filters, map toggle"; 9.2 course type filter.
    await page.goto("/golf-outings/ny/mamaroneck");
    // The filter panel may start collapsed; the controls must exist and be labeled.
    await expect(page.getByText(/course type/i).first()).toBeAttached();
    await expect(
      page
        .getByRole("checkbox", { name: /private/i, includeHidden: true })
        .or(page.getByRole("combobox", { name: /course type/i, includeHidden: true }))
        .first(),
    ).toBeAttached();
    await expect(
      page
        .getByRole("button", { name: /map/i })
        .or(page.getByRole("link", { name: /map/i }))
        .first(),
    ).toBeVisible();
  });
});

test.describe("charity city /charity-golf-tournaments/ny/mamaroneck", () => {
  test("lists charity and school fundraiser outings only, with the IRS intro", async ({ page }) => {
    // 9.1 charity route: "outings with outing_type charity or school_fundraiser,
    // with an intro saying charity status is checked against IRS records".
    const res = await page.goto("/charity-golf-tournaments/ny/mamaroneck");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Mamaroneck");
    await expect(page.locator("body")).toContainText(/IRS/);
    const slugs = await outingLinkSlugs(page);
    expect(slugs).toContain(FORDHAM_WINGED_FOOT.slug); // school_fundraiser
    expect(slugs).toContain(NKF_WINGED_FOOT.slug); // charity
    expect(slugs).not.toContain(GWA_QUAKER_RIDGE_EXPECTED.slug); // access_day
  });

  test("leaves out trade group outings in White Plains", async ({ page }) => {
    // 8.5 "Charity only": outing_type IN (charity, school_fundraiser).
    const res = await page.goto("/charity-golf-tournaments/ny/white-plains");
    expect(res?.status()).toBe(200);
    expect(await outingLinkSlugs(page)).not.toContain(BUILDERS_METROPOLIS.slug);
  });
});

test.describe("course /courses/ny/winged-foot-golf-club", () => {
  test("shows name, city, type, every outing and OSM attribution", async ({ page }) => {
    // 9.1 course: "course name, city, course type, every outing past and upcoming, OSM attribution".
    const res = await page.goto("/courses/ny/winged-foot-golf-club");
    expect(res?.status()).toBe(200);
    // 9.4 titles: "Course: Golf Outings at {Course}, {City}, {ST}".
    await expect(page).toHaveTitle("Golf Outings at Winged Foot Golf Club, Mamaroneck, NY");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Winged Foot Golf Club");
    const body = page.locator("body");
    await expect(body).toContainText("Mamaroneck");
    await expect(body).toContainText("Private");
    // CLAUDE.md: "© OpenStreetMap contributors" on course pages.
    await expect(body).toContainText("© OpenStreetMap contributors");
    const slugs = await outingLinkSlugs(page);
    for (const o of [FORDHAM_WINGED_FOOT, NKF_WINGED_FOOT, AUTISM_SPEAKS_EXPECTED])
      expect(slugs).toContain(o.slug);
  });
});

test.describe("organizer /organizers/national-kidney-foundation", () => {
  test("lists the organizer's outings across courses", async ({ page }) => {
    // 9.1 organizer: "the organizer's outings across courses".
    const res = await page.goto("/organizers/national-kidney-foundation");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "National Kidney Foundation",
    );
    const slugs = await outingLinkSlugs(page);
    expect(slugs).toContain(NKF_WINGED_FOOT.slug);
    expect(slugs).toContain("2026/nkf-golf-classic-at-philadelphia-country-club-philadelphia");
  });
});

test.describe("outing /outings/2026/nkf-golf-classic-at-winged-foot-golf-club-winged-foot", () => {
  test("shows details, Register, source link, last verified and internal links", async ({
    page,
    request,
  }) => {
    const o = NKF_WINGED_FOOT;
    const res = await page.goto(`/outings/${o.slug}`);
    expect(res?.status()).toBe(200);
    // 9.4 titles: "Outing: {Title} at {Course}, {City}, {ST} ({Mon D, YYYY})".
    const title = titleOf(await (await request.get(`/outings/${o.slug}`)).text());
    expect(title.startsWith(o.title)).toBe(true);
    expect(title).toMatch(/Mamaroneck, NY \(Oct 19, 2026\)$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(o.title);
    const body = page.locator("body");
    await expect(body).toContainText("Private");
    await expect(body).toContainText(o.label);
    // 9.3: date and shotgun time.
    await expect(body).toContainText(/Oct(ober)?\.? 19,? 2026/);
    await expect(body).toContainText(/12(:00)?\s*(p\.?m\.?|PM)|noon/i);
    // 9.1 outing: "Register button, source link, last-verified date".
    const register = page.getByRole("link", { name: /register/i }).first();
    await expect(register).toHaveAttribute("href", o.registrationUrl ?? "");
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.some((h) => sameUrl(h, o.sourceUrl))).toBe(true);
    await expect(body).toContainText(/Last verified/i);
    // 9.4 internal links: "Outing to course, organizer and city; five nearby upcoming outings".
    const paths = await linkPaths(page);
    expect(paths).toContain(`/courses/${o.courseSlug}`);
    expect(paths).toContain(`/organizers/${o.organizerSlug ?? ""}`);
    expect(paths).toContain(`/golf-outings/ny/${o.citySlug}`);
    const nearby = (await outingLinkSlugs(page)).filter((s) => s !== o.slug);
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.length).toBeLessThanOrEqual(5);
    expect(nearby).toContain(FORDHAM_WINGED_FOOT.slug);
  });

  test("an expected outing shows its expected month", async ({ page, request }) => {
    // 11: "an expected outing shows its expected month and no Event markup" (markup in jsonld.spec).
    // 9.3: "Expected {Month YYYY}"; 9.4: title ends "(expected {Month YYYY})".
    const o = AUTISM_SPEAKS_EXPECTED;
    const res = await page.goto(`/outings/${o.slug}`);
    expect(res?.status()).toBe(200);
    // 9.3 writes it "Expected {Month YYYY}"; "Expected in June 2027" says the same thing.
    await expect(page.locator("main")).toContainText(/Expected (in )?June 2027/);
    const title = titleOf(await (await request.get(`/outings/${o.slug}`)).text());
    expect(title).toBe(`${o.title} at ${o.courseName}, ${o.city}, ${o.state} (expected June 2027)`);
  });
});

test.describe("map and about", () => {
  test("/map renders with both map attributions and is not indexed", async ({ page }) => {
    // 9.1 `/map`: server, not indexed. 9.6: "Attribution shows OpenFreeMap © OpenMapTiles
    // Data from OpenStreetMap and © OpenStreetMap contributors". Tiles are blocked offline.
    const res = await page.goto("/map");
    expect(res?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const body = page.locator("body");
    await expect(body).toContainText("OpenFreeMap");
    await expect(body).toContainText("OpenStreetMap");
  });

  test("/about carries the OpenStreetMap, OpenFreeMap and GeoNames attributions", async ({
    page,
  }) => {
    // 9.1 `/about`: "carries the OpenStreetMap, OpenFreeMap and GeoNames attributions"; indexed.
    const res = await page.goto("/about");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const body = page.locator("body");
    await expect(body).toContainText("OpenStreetMap");
    await expect(body).toContainText("OpenFreeMap");
    await expect(body).toContainText("GeoNames");
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });
});

test.describe("municipal courses on list pages", () => {
  const PHOENIX = `/golf-outings/az/${ENCANTO.citySlug}`;
  const encantoRow = (page: Page) => page.locator(`[data-outing]:has(a[href="/outings/${ENCANTO.slug}"])`);

  test("a city page keeps municipal outings in the HTML but hidden, and the toggle shows them", async ({ page }) => {
    await page.goto(PHOENIX);
    // Still in the page for crawlers, just not shown.
    await expect(encantoRow(page)).toHaveCount(1);
    await expect(encantoRow(page)).toBeHidden();
    await expect(page.locator("[data-filter-count]")).toHaveText(/Showing \d+ of \d+ outings/);
    const toggle = page.getByRole("switch", { name: "Include municipal courses" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveURL(/[?&]include_municipal=1/);
    await expect(encantoRow(page)).toBeVisible();
  });

  test("a picked course type overrides the default, and the outing page stays up", async ({ page, request }) => {
    await page.goto(`${PHOENIX}?course_type=municipal_public`);
    await expect(encantoRow(page)).toBeVisible();
    await expect(page.getByRole("switch", { name: "Include municipal courses" })).toBeHidden();
    expect((await request.get(`/outings/${ENCANTO.slug}`)).status()).toBe(200);
    expect((await request.get(`/courses/${ENCANTO.courseSlug}`)).status()).toBe(200);
  });
});
