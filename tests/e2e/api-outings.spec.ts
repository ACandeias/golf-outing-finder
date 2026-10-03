/**
 * /api/outings (SPEC.md 9.1, 9.2, 9.6): "Worker JSON, cache 10 minutes ... bbox or
 * lat/lng plus radius, filters, 200 results max", GeoJSON for the map.
 *
 * Parameter names the spec leaves open, assumed here:
 *   bbox=west,south,east,north   (RFC 7946 order)
 *   lat=..&lng=..&radius=..      (radius in miles or km; the checks hold for both)
 *   filters use the 9.2 names    (course_type, charity, ...)
 */
import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./support/fixtures.ts";
import {
  BUILDERS_METROPOLIS,
  COORDS,
  DATED_OUTING_SLUGS,
  FORDHAM_WINGED_FOOT,
  NKF_WINGED_FOOT,
  WESTCHESTER_BBOX as B,
} from "./support/seed-facts.ts";

const FeatureModel = z.object({
  type: z.literal("Feature"),
  geometry: z.object({
    type: z.literal("Point"),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  properties: z.record(z.unknown()),
});
const CollectionModel = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(FeatureModel),
});
type Feature = z.infer<typeof FeatureModel>;

const MAX_RESULTS = 200;
const MILES_10_IN_KM = 16.1;

async function getCollection(request: APIRequestContext, query: string): Promise<Feature[]> {
  const res = await request.get(`/api/outings?${query}`);
  expect(res.status(), query).toBe(200);
  expect(res.headers()["content-type"] ?? "").toMatch(/application\/(geo\+)?json/);
  const parsed = CollectionModel.safeParse(await res.json());
  expect(
    parsed.success ? null : parsed.error.issues,
    `${query} is a GeoJSON FeatureCollection`,
  ).toBeNull();
  return parsed.success ? parsed.data.features : [];
}

/** True when the feature's properties mention the outing slug (as slug, path or URL). */
function isOuting(f: Feature, slug: string): boolean {
  return JSON.stringify(f.properties).includes(slug);
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const bboxQuery = `bbox=${B.west},${B.south},${B.east},${B.north}`;

test("bbox around Westchester returns the Winged Foot outings and nothing outside the box", async ({
  request,
}) => {
  // 9.1 "/api/outings: bbox"; 9.6 "clustered markers from /api/outings GeoJSON".
  const features = await getCollection(request, bboxQuery);
  for (const o of [NKF_WINGED_FOOT, FORDHAM_WINGED_FOOT, BUILDERS_METROPOLIS]) {
    expect(
      features.some((f) => isOuting(f, o.slug)),
      o.slug,
    ).toBe(true);
  }
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    expect(lng).toBeGreaterThanOrEqual(B.west);
    expect(lng).toBeLessThanOrEqual(B.east);
    expect(lat).toBeGreaterThanOrEqual(B.south);
    expect(lat).toBeLessThanOrEqual(B.north);
  }
  // East Hampton (Maidstone) is outside the box.
  expect(features.some((f) => isOuting(f, "2026/george-d-yates-golf-outing-maidstone"))).toBe(
    false,
  );
  // Upcoming only: every feature is one of the dated seed outings in the box.
  expect(features.length).toBe(3);
  // 9.1: "cache 10 minutes".
  const res = await request.get(`/api/outings?${bboxQuery}`);
  expect(res.headers()["cache-control"] ?? "").toMatch(/(s-)?max-age=600\b/);
});

test("lat/lng plus radius returns outings near Winged Foot only", async ({ request }) => {
  // 9.1 "/api/outings: ... lat/lng plus radius".
  const c = COORDS.wingedFoot;
  const features = await getCollection(request, `lat=${c.lat}&lng=${c.lng}&radius=10`);
  expect(features.some((f) => isOuting(f, NKF_WINGED_FOOT.slug))).toBe(true);
  expect(features.some((f) => isOuting(f, FORDHAM_WINGED_FOOT.slug))).toBe(true);
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates;
    expect(haversineKm(c, { lat, lng })).toBeLessThanOrEqual(MILES_10_IN_KM);
  }
  expect(features.some((f) => isOuting(f, "2026/george-d-yates-golf-outing-maidstone"))).toBe(
    false,
  );
});

test("filters apply on the server", async ({ request }) => {
  // 9.2: "/api/outings filters on the server". Every Westchester outing is at a private club.
  const priv = await getCollection(request, `${bboxQuery}&course_type=private`);
  expect(priv.length).toBe(3);
  const muni = await getCollection(request, `${bboxQuery}&course_type=municipal`);
  expect(muni.length).toBe(0);
  // Charity only (8.5): charity and school_fundraiser; Builders Institute is a trade group.
  const charity = await getCollection(request, `${bboxQuery}&charity=1`);
  expect(charity.some((f) => isOuting(f, BUILDERS_METROPOLIS.slug))).toBe(false);
  expect(charity.some((f) => isOuting(f, NKF_WINGED_FOOT.slug))).toBe(true);
});

test("results are capped at 200", async ({ request }) => {
  // 9.1: "200 results max". The seed has 13 upcoming outings, so the cap itself
  // can't be exceeded here; this checks the bound and that a larger limit is refused
  // or clamped.
  const all = await getCollection(request, "bbox=-180,-90,180,90");
  expect(all.length).toBeLessThanOrEqual(MAX_RESULTS);
  expect(all.length).toBe(DATED_OUTING_SLUGS.length);
  const res = await request.get("/api/outings?bbox=-180,-90,180,90&limit=500");
  if (res.status() === 200) {
    const parsed = CollectionModel.parse(await res.json());
    expect(parsed.features.length).toBeLessThanOrEqual(MAX_RESULTS);
  } else {
    expect(res.status()).toBe(400);
  }
});

const BAD = [
  "",
  "bbox=foo",
  "bbox=1,2,3",
  "bbox=-73.5,40.85,-73.95,41.4", // west > east
  "bbox=-73.95,41.4,-73.5,40.85", // south > north
  "bbox=-200,40,-73,41",
  "lat=40.96",
  "lat=999&lng=-73.75&radius=10",
  "lat=40.96&lng=-73.75&radius=-5",
  "lat=40.96&lng=-73.75&radius=abc",
  `${bboxQuery}&course_type=castle`,
  `${bboxQuery}&from=2026-13-45`,
];

for (const q of BAD) {
  test(`bad parameters answer 400: ${q || "(none)"}`, async ({ request }) => {
    // 10: input validation on /api; CLAUDE.md "Validate every external input with zod".
    const res = await request.get(`/api/outings${q ? `?${q}` : ""}`);
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"] ?? "").toMatch(/json/);
  });
}
