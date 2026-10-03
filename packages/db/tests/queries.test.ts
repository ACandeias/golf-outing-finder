import { beforeAll, describe, expect, it } from "vitest";
import {
  cityBySlug,
  countUpcomingByCity,
  countUpcomingByState,
  courseBySlug,
  isCityIndexable,
  listExpectedOutings,
  listUpcomingOutings,
  nearbyCitiesWithOutings,
  nearbyUpcomingOutings,
  organizerBySlug,
  outingById,
  outingBySlug,
  outingsForCourse,
  outingsForOrganizer,
  outingsInBBox,
  searchCities,
  sitemapCharityCities,
  sitemapCities,
  sitemapCourses,
  sitemapOrganizers,
  sitemapOutings,
  sitemapStates,
  twelveMonthsBefore,
  upcomingOutingsByCity,
  upcomingOutingsByCourse,
  upcomingOutingsByOrganizer,
  upcomingOutingsByState,
  zipLookup,
  type GofDb,
} from "../src/queries.ts";
import { drizzleOver, migratedSqlite } from "./helpers.ts";

const TODAY = "2026-09-28";
const T = "2026-09-28T12:00:00.000Z";

const FIXTURE = `
INSERT INTO cities (id, slug, name, state, lat, lng, population, time_zone) VALUES
  (5126183, 'mamaroneck', 'Mamaroneck', 'NY', 40.94871, -73.73263, 19375, 'America/New_York'),
  (5144336, 'white-plains', 'White Plains', 'NY', 41.03399, -73.76291, 58459, 'America/New_York'),
  (5136421, 'scarsdale', 'Scarsdale', 'NY', 41.0051, -73.78458, 17885, 'America/New_York'),
  (5308655, 'phoenix', 'Phoenix', 'AZ', 33.44838, -112.07404, 1608139, 'America/Phoenix');
INSERT INTO zips (zip, lat, lng, city_id) VALUES ('10543', 40.9529, -73.7363, 5126183), ('85007', 33.45, -112.09, NULL);
INSERT INTO courses (id, slug, name, city, state, lat, lng, time_zone, course_type, outing_count, created_at, updated_at, aliases) VALUES
  ('crs_wf', 'ny/winged-foot-golf-club', 'Winged Foot Golf Club', 'Mamaroneck', 'NY', 40.9625, -73.7539, 'America/New_York', 'private', 2, '${T}', '${T}', '["West Course"]'),
  ('crs_met', 'ny/metropolis-country-club', 'Metropolis Country Club', 'White Plains', 'NY', 41.0366, -73.8002, 'America/New_York', 'private', 2, '${T}', '${T}', '[]'),
  ('crs_qr', 'ny/quaker-ridge-golf-club', 'Quaker Ridge Golf Club', 'Scarsdale', 'NY', 40.9691, -73.7625, 'America/New_York', 'private', 1, '${T}', '${T}', '[]'),
  ('crs_empty', 'ny/empty-golf-course', 'Empty Golf Course', 'Mamaroneck', 'NY', 40.95, -73.74, 'America/New_York', 'public', 0, '${T}', '${T}', '[]'),
  ('crs_enc', 'az/encanto-18-golf-course', 'Encanto 18 Golf Course', 'Phoenix', 'AZ', 33.4752, -112.0897, 'America/Phoenix', 'municipal', 2, '${T}', '${T}', '[]'),
  ('crs_lj', 'ca/torrey-pines-south-course', 'Torrey Pines South Course', 'La Jolla Shores', 'CA', 32.8971, -117.2476, 'America/Los_Angeles', 'municipal', 0, '${T}', '${T}', '[]');
INSERT INTO organizers (id, slug, name, org_type, charity_status, created_at, updated_at) VALUES
  ('org_nkf', 'national-kidney-foundation', 'National Kidney Foundation', 'charity', '501c3', '${T}', '${T}'),
  ('org_ford', 'fordham-university', 'Fordham University', 'school', 'unverified', '${T}', '${T}'),
  ('org_bi', 'builders-institute', 'Builders Institute', 'business_association', 'unverified', '${T}', '${T}'),
  ('org_unused', 'unused-org', 'Unused Org', 'charity', 'unverified', '${T}', '${T}');
INSERT INTO outings (id, slug, course_id, organizer_id, title, outing_type, status, start_date, end_date, shotgun_time, expected_month,
    single_price_cents, foursome_price_cents, format, includes, canonical_source_url, confidence, published, hold_reason, source_gone,
    first_seen, last_verified, updated_at) VALUES
  ('o1', '2026/nkf-golf-classic-winged-foot', 'crs_wf', 'org_nkf', 'NKF Golf Classic', 'charity', 'open', '2026-10-19', NULL, '12:00', NULL,
    NULL, NULL, NULL, '["lunch","cart"]', 'https://support.kidney.org/e1', 1, 1, NULL, 0, '${T}', '${T}', '2026-09-28T12:00:01.000Z'),
  ('o2', '2026/fordham-golf-classic-winged-foot', 'crs_wf', 'org_ford', 'Fordham Golf Classic', 'school_fundraiser', 'open', '2026-10-13', NULL, '12:00', NULL,
    NULL, NULL, NULL, '[]', 'https://now.fordham.edu/e', 1, 1, NULL, 0, '${T}', '${T}', '${T}'),
  ('o3', '2027/wchc-golf-outing-metropolis', 'crs_met', 'org_bi', 'Trade Outing', 'business_association', 'expected', NULL, NULL, NULL, '2027-06',
    NULL, NULL, NULL, '[]', 'https://example.org/met', 1, 1, NULL, 0, '${T}', '${T}', '${T}'),
  ('o4', '2026/scramble-encanto-18', 'crs_enc', NULL, 'Scramble', 'charity', 'open', '2026-10-03', NULL, '07:00', NULL,
    12500, NULL, 'scramble', '[]', 'https://azgolf.org/cal', 1, 1, NULL, 0, '${T}', '${T}', '${T}'),
  ('o5', '2026/spring-outing-metropolis', 'crs_met', 'org_nkf', 'Spring Outing', 'charity', 'past', '2026-05-01', NULL, NULL, NULL,
    NULL, NULL, NULL, '[]', 'https://example.org/spring', 1, 1, NULL, 0, '${T}', '${T}', '${T}'),
  ('o6', '2026/held-winged-foot', 'crs_wf', 'org_unused', 'Held Outing', 'charity', 'expected', NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '[]', 'https://example.org/held', 1, 0, 'no_date', 0, '${T}', '${T}', '${T}'),
  ('o7', '2024/old-outing-quaker-ridge', 'crs_qr', 'org_ford', 'Old Outing', 'school_fundraiser', 'past', '2024-05-01', NULL, NULL, NULL,
    NULL, NULL, NULL, '[]', 'https://example.org/old', 1, 1, NULL, 0, '${T}', '${T}', '${T}'),
  ('o8', '2026/gone-encanto-18', 'crs_enc', NULL, 'Gone Outing', 'other', 'open', '2026-11-01', '2026-11-02', NULL, NULL,
    20000, 80000, 'best_ball', '[]', 'https://example.org/gone', 1, 1, NULL, 1, '${T}', '${T}', '${T}'),
  ('o9', '2026/yesterday-winged-foot', 'crs_wf', 'org_ford', 'Yesterday', 'other', 'open', '2026-09-27', NULL, NULL, NULL,
    NULL, NULL, NULL, '[]', 'https://example.org/y', 1, 1, NULL, 0, '${T}', '${T}', '${T}');
`;

let db: GofDb;
beforeAll(() => {
  const sqlite = migratedSqlite();
  sqlite.exec(FIXTURE);
  db = drizzleOver(sqlite);
});

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

describe("upcoming outings", () => {
  it("by state: published, current, soonest first, with labels from the label table", async () => {
    const rows = await upcomingOutingsByState(db, "ny", TODAY);
    expect(ids(rows)).toEqual(["o2", "o1"]);
    expect(rows[1]?.label).toBe("Charity");
    expect(rows[1]?.organizer?.charityStatus).toBe("501c3");
    expect(rows[1]?.includes).toEqual(["lunch", "cart"]);
    expect(rows[0]?.label).toBe("School fundraiser");
    expect(rows[0]?.course).toMatchObject({ slug: "ny/winged-foot-golf-club", city: "Mamaroneck", timeZone: "America/New_York" });
  });

  it("labels a charity outing with no organizer as unverified", async () => {
    const rows = await upcomingOutingsByState(db, "AZ", TODAY);
    expect(ids(rows)).toEqual(["o4", "o8"]);
    expect(rows[0]?.organizer).toBeNull();
    expect(rows[0]?.label).toBe("Fundraiser, charity status unverified");
    expect(rows[1]?.label).toBe("Golf outing");
  });

  it("by city (case-insensitive), course and organizer", async () => {
    expect(ids(await upcomingOutingsByCity(db, "NY", "mamaroneck", TODAY))).toEqual(["o2", "o1"]);
    expect(ids(await upcomingOutingsByCourse(db, "crs_wf", TODAY))).toEqual(["o2", "o1"]);
    expect(ids(await upcomingOutingsByOrganizer(db, "org_nkf", TODAY))).toEqual(["o1"]);
  });

  it("keeps a multi-day outing until its end date", async () => {
    expect(ids(await upcomingOutingsByState(db, "AZ", "2026-11-02"))).toEqual(["o8"]);
    expect(ids(await upcomingOutingsByState(db, "AZ", "2026-11-03"))).toEqual([]);
  });

  it("applies the SPEC 9.2 filters", async () => {
    const q = (f: Parameters<typeof listUpcomingOutings>[1]) => listUpcomingOutings(db, f).then(ids);
    expect(await q({ today: TODAY, charityOnly: true })).toEqual(["o4", "o2", "o1"]);
    expect(await q({ today: TODAY, courseTypes: ["municipal"] })).toEqual(["o4", "o8"]);
    expect(await q({ today: TODAY, maxPriceCents: 15000 })).toEqual(["o4"]);
    expect(await q({ today: TODAY, singlesWelcome: true })).toEqual(["o4", "o8"]);
    expect(await q({ today: TODAY, format: "best_ball" })).toEqual(["o8"]);
    expect(await q({ today: TODAY, from: "2026-10-10", to: "2026-10-31" })).toEqual(["o2", "o1"]);
    expect(await q({ today: TODAY, limit: 1 })).toEqual(["o4"]);
  });

  it("rejects a malformed today", async () => {
    await expect(upcomingOutingsByState(db, "NY", "2026-9-28")).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("expected, course and organizer lists", () => {
  it("lists published expected outings only", async () => {
    const rows = await listExpectedOutings(db);
    expect(ids(rows)).toEqual(["o3"]);
    expect(rows[0]?.expectedMonth).toBe("2027-06");
    expect(rows[0]?.label).toBe("Trade group outing");
    expect(ids(await listExpectedOutings(db, { state: "AZ" }))).toEqual([]);
  });

  it("lists every published outing at a course, newest first", async () => {
    expect(ids(await outingsForCourse(db, "crs_wf"))).toEqual(["o1", "o2", "o9"]);
    expect(ids(await outingsForCourse(db, "crs_met"))).toEqual(["o3", "o5"]);
  });

  it("lists every published outing by an organizer", async () => {
    expect(ids(await outingsForOrganizer(db, "org_ford"))).toEqual(["o2", "o9", "o7"]);
  });
});

describe("geography", () => {
  it("finds upcoming outings inside a bounding box", async () => {
    const rows = await outingsInBBox(db, {
      today: TODAY,
      bbox: { minLat: 33, maxLat: 34, minLng: -113, maxLng: -111 },
    });
    expect(ids(rows)).toEqual(["o4", "o8"]);
  });

  it("finds nearby upcoming outings, nearest first, excluding the current one", async () => {
    const rows = await nearbyUpcomingOutings(db, {
      today: TODAY,
      center: { lat: 40.9625, lng: -73.7539 },
      radiusKm: 50,
      excludeId: "o1",
    });
    expect(ids(rows)).toEqual(["o2"]);
    expect(rows[0]?.distanceKm).toBeLessThan(0.01);
  });

  it("counts upcoming outings by state and by city", async () => {
    expect(await countUpcomingByState(db, TODAY)).toEqual([
      { state: "AZ", count: 2 },
      { state: "NY", count: 2 },
    ]);
    expect(await countUpcomingByCity(db, "NY", TODAY)).toEqual([{ city: "Mamaroneck", count: 2 }]);
  });

  it("lists nearby cities that have indexable outings", async () => {
    const rows = await nearbyCitiesWithOutings(db, {
      center: { lat: 40.94871, lng: -73.73263 },
      today: TODAY,
      excludeCity: "Mamaroneck",
    });
    expect(rows.map((r) => r.city)).toEqual(["White Plains"]);
  });

  it("looks up a ZIP and searches cities by prefix", async () => {
    expect(await zipLookup(db, "10543")).toEqual({ zip: "10543", lat: 40.9529, lng: -73.7363, city: "Mamaroneck", state: "NY" });
    expect(await zipLookup(db, "85007")).toMatchObject({ city: null });
    expect(await zipLookup(db, "1054")).toBeNull();
    expect((await searchCities(db, "Ma")).map((c) => c.slug)).toEqual(["mamaroneck"]);
    expect(await searchCities(db, "%")).toEqual([]);
  });
});

describe("single records", () => {
  it("returns a course by slug, or null when it never had an outing (404)", async () => {
    const wf = await courseBySlug(db, "ny/winged-foot-golf-club");
    expect(wf?.name).toBe("Winged Foot Golf Club");
    expect(wf?.aliasList).toEqual(["West Course"]);
    expect(await courseBySlug(db, "ny/empty-golf-course")).toBeNull();
    expect(await courseBySlug(db, "ny/nope")).toBeNull();
  });

  it("returns a published outing by slug with course and organizer", async () => {
    const o = await outingBySlug(db, "2026/nkf-golf-classic-winged-foot");
    expect(o).toMatchObject({ id: "o1", label: "Charity", courseId: "crs_wf", organizerId: "org_nkf", confidence: 1 });
    expect(o?.organizer?.name).toBe("National Kidney Foundation");
    expect(await outingBySlug(db, "2026/held-winged-foot")).toBeNull();
    expect((await outingById(db, "o3"))?.slug).toBe("2027/wchc-golf-outing-metropolis");
    expect(await outingById(db, "o6")).toBeNull();
  });

  it("returns an organizer only when it has a published outing", async () => {
    expect((await organizerBySlug(db, "fordham-university"))?.name).toBe("Fordham University");
    expect(await organizerBySlug(db, "unused-org")).toBeNull();
  });

  it("resolves a city slug from cities, else from course cities", async () => {
    expect(await cityBySlug(db, "ny", "mamaroneck")).toMatchObject({ id: 5126183, name: "Mamaroneck", state: "NY" });
    expect(await cityBySlug(db, "CA", "la-jolla-shores")).toMatchObject({ id: null, name: "La Jolla Shores", lat: 32.8971 });
    expect(await cityBySlug(db, "NY", "nowhere")).toBeNull();
  });
});

describe("sitemaps and indexing (SPEC 9.1)", () => {
  it("twelveMonthsBefore", () => {
    expect(twelveMonthsBefore("2026-09-28")).toBe("2025-09-28");
  });

  it("lists published outings with a live source, past and expected included", async () => {
    const paths = (await sitemapOutings(db)).map((e) => e.path);
    expect(paths).toEqual([
      "/outings/2024/old-outing-quaker-ridge",
      "/outings/2026/fordham-golf-classic-winged-foot",
      "/outings/2026/nkf-golf-classic-winged-foot",
      "/outings/2026/scramble-encanto-18",
      "/outings/2026/spring-outing-metropolis",
      "/outings/2026/yesterday-winged-foot",
      "/outings/2027/wchc-golf-outing-metropolis",
    ]);
  });

  it("lists courses with outing_count >= 1 and organizers with a published outing", async () => {
    expect((await sitemapCourses(db)).map((e) => e.path)).toEqual([
      "/courses/az/encanto-18-golf-course",
      "/courses/ny/metropolis-country-club",
      "/courses/ny/quaker-ridge-golf-club",
      "/courses/ny/winged-foot-golf-club",
    ]);
    const orgs = await sitemapOrganizers(db);
    expect(orgs.map((e) => e.path)).toEqual([
      "/organizers/builders-institute",
      "/organizers/fordham-university",
      "/organizers/national-kidney-foundation",
    ]);
    expect(orgs.find((o) => o.path.endsWith("national-kidney-foundation"))?.lastmod).toBe("2026-09-28T12:00:01.000Z");
  });

  it("indexes a city with an upcoming, expected or last-12-months outing only", async () => {
    expect((await sitemapCities(db, TODAY)).map((c) => `${c.state}/${c.city}`)).toEqual([
      "AZ/Phoenix",
      "NY/Mamaroneck",
      "NY/White Plains",
    ]);
    expect(await isCityIndexable(db, "NY", "Scarsdale", TODAY)).toBe(false);
    expect(await isCityIndexable(db, "NY", "white plains", TODAY)).toBe(true);
  });

  it("counts only charity and school outings for charity city pages", async () => {
    expect((await sitemapCharityCities(db, TODAY)).map((c) => `${c.state}/${c.city}`)).toEqual([
      "AZ/Phoenix",
      "NY/Mamaroneck",
      "NY/White Plains",
    ]);
    // White Plains qualifies through the May 2026 charity outing (o5), not the trade outing.
    expect(await isCityIndexable(db, "NY", "White Plains", "2027-05-02", true)).toBe(false);
    expect(await isCityIndexable(db, "NY", "White Plains", "2027-05-02", false)).toBe(true);
  });

  it("lists states with a published outing", async () => {
    expect((await sitemapStates(db)).map((s) => s.state)).toEqual(["AZ", "NY"]);
  });
});
