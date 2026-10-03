/**
 * Structured data (SPEC.md 9.4, G3, 11): Event JSON-LD validated against a zod
 * model of the Event shape, BreadcrumbList on every page, ItemList on list pages.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, siteOrigin, test } from "./support/fixtures.ts";
import { jsonLdBlocks } from "./support/html.ts";
import {
  BreadcrumbListModel,
  EventModel,
  ISO_DATE,
  ItemListModel,
  itemListUrls,
  nodesOfType,
  offersOf,
  parseJsonLd,
  type EventLd,
  type JsonLdNode,
} from "./support/jsonld.ts";
import {
  AUTISM_SPEAKS_EXPECTED,
  BUILDERS_METROPOLIS,
  DATED_OUTING_SLUGS,
  FORDHAM_WINGED_FOOT,
  GRADY,
  NKF_WINGED_FOOT,
  TORREY_TWO_MAN,
  VALLEY_HOSPITAL_ANNOUNCED,
} from "./support/seed-facts.ts";

async function ldNodes(request: APIRequestContext, path: string): Promise<JsonLdNode[]> {
  const res = await request.get(path);
  expect(res.status(), path).toBe(200);
  return parseJsonLd(jsonLdBlocks(await res.text()));
}

function oneEvent(nodes: JsonLdNode[], path: string): EventLd {
  const events = nodesOfType(nodes, "Event");
  expect(events, `${path} has exactly one Event`).toHaveLength(1);
  const parsed = EventModel.safeParse(events[0]);
  expect(parsed.success ? null : parsed.error.issues, `${path} Event matches the 9.4 model`).toBeNull();
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

test.describe("Event JSON-LD on outing pages", () => {
  test("NKF Winged Foot: startDate 2026-10-19T12:00:00-04:00 and the full 9.4 shape", async ({ request }) => {
    // 13 Phase 1, item 2: "its Event JSON-LD passes ... and startDate ends in -04:00".
    // seed s06 expected_jsonld_start.
    const path = `/outings/${NKF_WINGED_FOOT.slug}`;
    const e = oneEvent(await ldNodes(request, path), path);
    expect(e.startDate).toBe("2026-10-19T12:00:00-04:00");
    expect(e.name).toContain("NKF Golf Classic");
    // 9.4: endDate "only when end_date is set".
    expect(e.endDate).toBeUndefined();
    expect(e.eventStatus).toMatch(/schema\.org\/EventScheduled$/);
    expect(e.location.name).toBe("Winged Foot Golf Club");
    expect(e.location.address.addressRegion).toBe("NY");
    expect(e.location.address.addressLocality).toBe("Mamaroneck");
    // 9.4: organizer.
    expect(e.organizer?.name).toBe("National Kidney Foundation");
    // No price in the seed: an offer, if any, still points at the registration URL.
    for (const offer of offersOf(e)) expect(offer.url).toBe(NKF_WINGED_FOOT.registrationUrl);
  });

  test("every dated outing has a valid Event", async ({ request }) => {
    // G3: "Every indexable outing page that carries Event markup (status open, ...)".
    for (const slug of DATED_OUTING_SLUGS) {
      const path = `/outings/${slug}`;
      oneEvent(await ldNodes(request, path), path);
    }
  });

  test("a date-only startDate when there is no shotgun time", async ({ request }) => {
    // 9.4: "otherwise a date-only YYYY-MM-DD". Builders Institute has no shotgun_time.
    const path = `/outings/${BUILDERS_METROPOLIS.slug}`;
    const e = oneEvent(await ldNodes(request, path), path);
    expect(e.startDate).toBe("2026-10-07");
    expect(e.startDate).toMatch(ISO_DATE);
  });

  test("endDate on a multi-day event", async ({ request }) => {
    // 9.4: "endDate only when end_date is set". Torrey Pines runs Dec 15 to 18, 2026.
    const path = `/outings/${TORREY_TWO_MAN.slug}`;
    const e = oneEvent(await ldNodes(request, path), path);
    expect(e.startDate).toBe("2026-12-15");
    expect(e.endDate).toBe("2026-12-18");
  });

  test("offers carry the price in USD when a price exists", async ({ request }) => {
    // 9.4: "offers with price, USD, registration URL and availability". Grady: $150 single, $600 foursome.
    const path = `/outings/${GRADY.slug}`;
    const e = oneEvent(await ldNodes(request, path), path);
    const offers = offersOf(e);
    expect(offers.length).toBeGreaterThan(0);
    const prices = offers.map((o) => Number(o.price));
    expect(prices).toContain(150);
    for (const offer of offers) {
      expect(offer.priceCurrency).toBe("USD");
      expect(offer.availability).toMatch(/schema\.org\/InStock$/);
    }
    // 9.4 "startDate with the course's UTC offset": Tampa in November is -05:00.
    expect(e.startDate).toBe("2026-11-07T08:30:00-05:00");
  });

  test("expected outings have no Event markup, even with an announced date", async ({ request }) => {
    // 9.4: "Expected outings get no Event markup, even when an announced start_date is known";
    // 11: "an expected outing shows its expected month and no Event markup".
    for (const o of [AUTISM_SPEAKS_EXPECTED, VALLEY_HOSPITAL_ANNOUNCED]) {
      const nodes = await ldNodes(request, `/outings/${o.slug}`);
      expect(nodesOfType(nodes, "Event"), o.slug).toHaveLength(0);
    }
  });
});

const EVERY_PAGE = [
  "/",
  "/golf-outings",
  "/golf-outings/ny",
  "/golf-outings/ny/mamaroneck",
  "/charity-golf-tournaments/ny/mamaroneck",
  "/courses/ny/winged-foot-golf-club",
  "/organizers/national-kidney-foundation",
  `/outings/${NKF_WINGED_FOOT.slug}`,
  `/outings/${AUTISM_SPEAKS_EXPECTED.slug}`,
  "/map",
  "/about",
];

test("BreadcrumbList on every page", async ({ request }) => {
  // 9.4: "BreadcrumbList on every page".
  for (const path of EVERY_PAGE) {
    const crumbs = nodesOfType(await ldNodes(request, path), "BreadcrumbList");
    expect(crumbs, `${path} has one BreadcrumbList`).toHaveLength(1);
    const parsed = BreadcrumbListModel.safeParse(crumbs[0]);
    expect(parsed.success ? null : parsed.error.issues, `${path} BreadcrumbList`).toBeNull();
  }
});

const LIST_PAGES: { path: string; mustInclude: string[] }[] = [
  { path: "/golf-outings", mustInclude: [] },
  { path: "/golf-outings/ny", mustInclude: [NKF_WINGED_FOOT.slug, FORDHAM_WINGED_FOOT.slug] },
  { path: "/golf-outings/ny/mamaroneck", mustInclude: [NKF_WINGED_FOOT.slug, FORDHAM_WINGED_FOOT.slug] },
  { path: "/charity-golf-tournaments/ny/mamaroneck", mustInclude: [NKF_WINGED_FOOT.slug, FORDHAM_WINGED_FOOT.slug] },
  { path: "/courses/ny/winged-foot-golf-club", mustInclude: [NKF_WINGED_FOOT.slug, FORDHAM_WINGED_FOOT.slug] },
  { path: "/organizers/national-kidney-foundation", mustInclude: [NKF_WINGED_FOOT.slug] },
];

test("ItemList of outing URLs on list pages", async ({ request, baseURL }) => {
  // 9.4: "ItemList of outing URLs on list pages".
  const origin = siteOrigin(baseURL);
  for (const { path, mustInclude } of LIST_PAGES) {
    const lists = nodesOfType(await ldNodes(request, path), "ItemList");
    expect(lists.length, `${path} has an ItemList`).toBeGreaterThanOrEqual(1);
    const parsed = ItemListModel.safeParse(lists[0]);
    expect(parsed.success ? null : parsed.error.issues, `${path} ItemList`).toBeNull();
    if (!parsed.success) continue;
    const urls = itemListUrls(parsed.data);
    expect(urls.length, `${path} ItemList is not empty`).toBeGreaterThan(0);
    for (const u of urls) {
      expect(new URL(u).origin, u).toBe(origin);
      expect(new URL(u).pathname, u).toMatch(/^\/outings\/\d{4}\/[a-z0-9-]+$/);
    }
    for (const slug of mustInclude) expect(urls).toContain(`${origin}/outings/${slug}`);
  }
});
