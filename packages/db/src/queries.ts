/**
 * Typed read queries for the site and the loaders (SPEC.md v1.1 sections 8.5 and
 * 9.1). Plain Drizzle over D1 (or any async SQLite driver); no business logic
 * beyond what decides visibility and indexing.
 *
 * Every function that talks about "upcoming" takes `today` (YYYY-MM-DD) from the
 * caller, which resolves the clock (SITE_NOW outside production) so tests pin it.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { outingLabel, type CharityStatus } from "@gof/shared/labels";
import { bboxAround, haversineKm, type BBox, type LatLng } from "@gof/shared/places";
import { citySlug } from "@gof/shared/slug";
import type { CourseType, OutingStatus, OutingType } from "@gof/shared/schemas";
import { cities, courses, organizers, outings, zips } from "./schema.ts";

/** D1 in the Worker, sqlite-proxy over node:sqlite in tests. */
export type GofDb = BaseSQLiteDatabase<"async", unknown>;

/** Statuses that are dated and current; these carry Event markup. */
export const LISTED_STATUSES = ["open", "waitlist", "sold_out", "cancelled"] as const satisfies readonly OutingStatus[];
/** "Charity only" (SPEC.md 8.5). */
export const CHARITY_TYPES = ["charity", "school_fundraiser"] as const satisfies readonly OutingType[];
export const MAX_API_RESULTS = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(d: string, name = "today"): void {
  if (!ISO_DATE.test(d)) throw new Error(`${name} must be YYYY-MM-DD, got ${d}`);
}

/** `today` minus 12 months, for the city indexing rule (SPEC.md 9.1). */
export function twelveMonthsBefore(today: string): string {
  assertDate(today);
  const [y, m, d] = today.split("-") as [string, string, string];
  return `${Number(y) - 1}-${m}-${d}`;
}

const listFields = {
  id: outings.id,
  slug: outings.slug,
  title: outings.title,
  summary: outings.summary,
  outingType: outings.outingType,
  audience: outings.audience,
  audienceNote: outings.audienceNote,
  startDate: outings.startDate,
  endDate: outings.endDate,
  shotgunTime: outings.shotgunTime,
  format: outings.format,
  singlePriceCents: outings.singlePriceCents,
  foursomePriceCents: outings.foursomePriceCents,
  sponsorOnly: outings.sponsorOnly,
  includes: outings.includes,
  handicapRequired: outings.handicapRequired,
  status: outings.status,
  expectedMonth: outings.expectedMonth,
  registrationUrl: outings.registrationUrl,
  canonicalSourceUrl: outings.canonicalSourceUrl,
  sourceGone: outings.sourceGone,
  nextOutingId: outings.nextOutingId,
  lastVerified: outings.lastVerified,
  updatedAt: outings.updatedAt,
  course: {
    id: courses.id,
    slug: courses.slug,
    name: courses.name,
    street: courses.street,
    city: courses.city,
    state: courses.state,
    zip: courses.zip,
    lat: courses.lat,
    lng: courses.lng,
    timeZone: courses.timeZone,
    courseType: courses.courseType,
  },
  organizer: {
    id: organizers.id,
    slug: organizers.slug,
    name: organizers.name,
    charityStatus: organizers.charityStatus,
    website: organizers.website,
  },
};

export interface OutingCourse {
  id: string;
  slug: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  lat: number;
  lng: number;
  timeZone: string;
  courseType: CourseType;
}

export interface OutingOrganizer {
  id: string;
  slug: string;
  name: string;
  charityStatus: CharityStatus;
  website: string | null;
}

/** One outing with its course, organizer and display label (SPEC.md 8.5 label table). */
export interface OutingListItem {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  outingType: OutingType;
  /** "Charity", "Fundraiser, charity status unverified", "School fundraiser", ... */
  label: string;
  audience: "open" | "aimed_at_group";
  audienceNote: string | null;
  startDate: string | null;
  endDate: string | null;
  shotgunTime: string | null;
  format: "scramble" | "best_ball" | "shamble" | "stroke" | "other" | null;
  singlePriceCents: number | null;
  foursomePriceCents: number | null;
  sponsorOnly: boolean;
  includes: string[];
  handicapRequired: boolean | null;
  status: OutingStatus;
  expectedMonth: string | null;
  registrationUrl: string | null;
  canonicalSourceUrl: string;
  sourceGone: boolean;
  nextOutingId: string | null;
  lastVerified: string;
  updatedAt: string;
  course: OutingCourse;
  organizer: OutingOrganizer | null;
}

function parseIncludes(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type SelectedRow = Awaited<ReturnType<typeof selectList>>[number];

function toItem(r: SelectedRow): OutingListItem {
  const organizer: OutingOrganizer | null = r.organizer?.id ? r.organizer : null;
  return {
    ...r,
    sponsorOnly: r.sponsorOnly === 1,
    handicapRequired: r.handicapRequired === null ? null : r.handicapRequired === 1,
    sourceGone: r.sourceGone === 1,
    includes: parseIncludes(r.includes),
    label: outingLabel(r.outingType, organizer?.charityStatus ?? null),
    course: r.course,
    organizer,
  };
}

function selectList(db: GofDb, where: SQL | undefined, order: SQL[], limit?: number) {
  const q = db
    .select(listFields)
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .leftJoin(organizers, eq(outings.organizerId, organizers.id))
    .where(where)
    .orderBy(...order);
  return limit === undefined ? q : q.limit(limit);
}

/** Filters from SPEC.md 9.2. All optional. */
export interface OutingFilters {
  state?: string;
  /** City name as stored in courses.city (resolve a slug with `cityBySlug`). */
  city?: string;
  courseId?: string;
  organizerId?: string;
  bbox?: BBox;
  courseTypes?: readonly CourseType[];
  charityOnly?: boolean;
  /** Price per player, cents; outings with no single price are kept out when set. */
  maxPriceCents?: number;
  /** Inclusive YYYY-MM-DD range on start_date. */
  from?: string;
  to?: string;
  format?: "scramble" | "best_ball" | "shamble" | "stroke" | "other";
  /** Singles welcome: a single price is listed. */
  singlesWelcome?: boolean;
  excludeId?: string;
}

function filterClauses(f: OutingFilters): SQL[] {
  const c: SQL[] = [];
  if (f.state) c.push(eq(courses.state, f.state.toUpperCase()));
  if (f.city) c.push(sql`lower(${courses.city}) = lower(${f.city})`);
  if (f.courseId) c.push(eq(outings.courseId, f.courseId));
  if (f.organizerId) c.push(eq(outings.organizerId, f.organizerId));
  if (f.bbox) {
    c.push(gte(courses.lat, f.bbox.minLat), lte(courses.lat, f.bbox.maxLat));
    c.push(gte(courses.lng, f.bbox.minLng), lte(courses.lng, f.bbox.maxLng));
  }
  if (f.courseTypes && f.courseTypes.length > 0) c.push(inArray(courses.courseType, [...f.courseTypes]));
  if (f.charityOnly) c.push(inArray(outings.outingType, [...CHARITY_TYPES]));
  if (f.maxPriceCents !== undefined) {
    c.push(isNotNull(outings.singlePriceCents), lte(outings.singlePriceCents, f.maxPriceCents));
  }
  if (f.from) {
    assertDate(f.from, "from");
    c.push(gte(outings.startDate, f.from));
  }
  if (f.to) {
    assertDate(f.to, "to");
    c.push(lte(outings.startDate, f.to));
  }
  if (f.format) c.push(eq(outings.format, f.format));
  if (f.singlesWelcome) c.push(isNotNull(outings.singlePriceCents));
  if (f.excludeId) c.push(sql`${outings.id} <> ${f.excludeId}`);
  return c;
}

/** Published, dated, current: listed status and `end_date ?? start_date` on or after today. */
function upcomingClause(today: string): SQL {
  assertDate(today);
  return and(
    eq(outings.published, 1),
    inArray(outings.status, [...LISTED_STATUSES]),
    gte(sql`coalesce(${outings.endDate}, ${outings.startDate})`, today),
  ) as SQL;
}

const byDate = [asc(outings.startDate), asc(outings.shotgunTime), asc(outings.title), asc(outings.id)];

/** Upcoming published outings, soonest first, with optional filters. */
export async function listUpcomingOutings(
  db: GofDb,
  opts: OutingFilters & { today: string; limit?: number },
): Promise<OutingListItem[]> {
  const rows = await selectList(db, and(upcomingClause(opts.today), ...filterClauses(opts)), byDate, opts.limit);
  return rows.map(toItem);
}

export const upcomingOutingsByState = (db: GofDb, state: string, today: string, limit?: number) =>
  listUpcomingOutings(db, { state, today, limit });

export const upcomingOutingsByCity = (db: GofDb, state: string, city: string, today: string, limit?: number) =>
  listUpcomingOutings(db, { state, city, today, limit });

export const upcomingOutingsByCourse = (db: GofDb, courseId: string, today: string) =>
  listUpcomingOutings(db, { courseId, today });

export const upcomingOutingsByOrganizer = (db: GofDb, organizerId: string, today: string) =>
  listUpcomingOutings(db, { organizerId, today });

/** Published expected outings (SPEC.md 8.8 amendment A2), by expected month. */
export async function listExpectedOutings(
  db: GofDb,
  opts: Pick<OutingFilters, "state" | "city" | "courseId" | "organizerId" | "charityOnly" | "courseTypes" | "bbox"> & {
    limit?: number;
  } = {},
): Promise<OutingListItem[]> {
  const rows = await selectList(
    db,
    and(eq(outings.published, 1), eq(outings.status, "expected"), ...filterClauses(opts)),
    [asc(outings.expectedMonth), asc(outings.startDate), asc(outings.title), asc(outings.id)],
    opts.limit,
  );
  return rows.map(toItem);
}

/** Every published outing at a course, past, upcoming and expected (course page). */
export async function outingsForCourse(db: GofDb, courseId: string): Promise<OutingListItem[]> {
  const rows = await selectList(
    db,
    and(eq(outings.published, 1), eq(outings.courseId, courseId)),
    [desc(sql`coalesce(${outings.startDate}, ${outings.expectedMonth} || '-01')`), asc(outings.id)],
  );
  return rows.map(toItem);
}

/** Every published outing by an organizer across courses (organizer page). */
export async function outingsForOrganizer(db: GofDb, organizerId: string): Promise<OutingListItem[]> {
  const rows = await selectList(
    db,
    and(eq(outings.published, 1), eq(outings.organizerId, organizerId)),
    [desc(sql`coalesce(${outings.startDate}, ${outings.expectedMonth} || '-01')`), asc(outings.id)],
  );
  return rows.map(toItem);
}

/**
 * Upcoming outings inside a bounding box, for /api/outings and the map (SPEC.md
 * 9.1): at most 200, soonest first.
 */
export async function outingsInBBox(
  db: GofDb,
  opts: OutingFilters & { bbox: BBox; today: string; limit?: number },
): Promise<OutingListItem[]> {
  const limit = Math.min(opts.limit ?? MAX_API_RESULTS, MAX_API_RESULTS);
  return listUpcomingOutings(db, { ...opts, limit });
}

/**
 * Upcoming outings within `radiusKm` of a point, nearest first (outing page's
 * "five nearby upcoming outings", /api/outings with lat/lng and radius).
 */
export async function nearbyUpcomingOutings(
  db: GofDb,
  opts: OutingFilters & { center: LatLng; radiusKm: number; today: string; limit?: number },
): Promise<(OutingListItem & { distanceKm: number })[]> {
  const limit = Math.min(opts.limit ?? 5, MAX_API_RESULTS);
  const { center, radiusKm, ...rest } = opts;
  const rows = await listUpcomingOutings(db, { ...rest, bbox: bboxAround(center, radiusKm), limit: undefined });
  return rows
    .map((r) => ({ ...r, distanceKm: haversineKm(center, r.course) }))
    .filter((r) => r.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.startDate ?? "").localeCompare(b.startDate ?? ""))
    .slice(0, limit);
}

/** Upcoming published outings per state (national hub). */
export async function countUpcomingByState(db: GofDb, today: string): Promise<{ state: string; count: number }[]> {
  const rows = await db
    .select({ state: courses.state, count: sql<number>`count(*)` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(upcomingClause(today))
    .groupBy(courses.state)
    .orderBy(asc(courses.state));
  return rows.map((r) => ({ state: r.state, count: Number(r.count) }));
}

/** Upcoming published outings per city in a state (state page city links). */
export async function countUpcomingByCity(
  db: GofDb,
  state: string,
  today: string,
): Promise<{ city: string; count: number }[]> {
  const rows = await db
    .select({ city: courses.city, count: sql<number>`count(*)` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(and(upcomingClause(today), eq(courses.state, state.toUpperCase()), isNotNull(courses.city)))
    .groupBy(courses.city)
    .orderBy(asc(courses.city));
  return rows.flatMap((r) => (r.city ? [{ city: r.city, count: Number(r.count) }] : []));
}

export interface OutingDetail extends OutingListItem {
  courseId: string;
  organizerId: string | null;
  confidence: number;
  firstSeen: string;
}

/** A published outing by slug (`2026/nkf-golf-classic-...`); null when unknown or unpublished. */
export async function outingBySlug(db: GofDb, slug: string): Promise<OutingDetail | null> {
  const rows = await db
    .select({
      ...listFields,
      courseId: outings.courseId,
      organizerId: outings.organizerId,
      confidence: outings.confidence,
      firstSeen: outings.firstSeen,
    })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .leftJoin(organizers, eq(outings.organizerId, organizers.id))
    .where(and(eq(outings.slug, slug), eq(outings.published, 1)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const { courseId, organizerId, confidence, firstSeen, ...rest } = r;
  return { ...toItem(rest), courseId, organizerId, confidence, firstSeen };
}

/** An outing by id (for next_outing_id links); published only. */
export async function outingById(db: GofDb, id: string): Promise<OutingListItem | null> {
  const rows = await selectList(db, and(eq(outings.id, id), eq(outings.published, 1)), [asc(outings.id)], 1);
  const r = rows[0];
  return r ? toItem(r) : null;
}

export type CourseRow = typeof courses.$inferSelect;

/**
 * A course by slug (`ny/winged-foot-golf-club`). Returns null, so the page can
 * 404, when the course has never had a published outing (SPEC.md 9.1).
 */
export async function courseBySlug(db: GofDb, slug: string): Promise<(CourseRow & { aliasList: string[] }) | null> {
  const rows = await db
    .select()
    .from(courses)
    .where(and(eq(courses.slug, slug), gte(courses.outingCount, 1)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { ...r, aliasList: parseIncludes(r.aliases) };
}

export type OrganizerRow = typeof organizers.$inferSelect;

/** An organizer with at least one published outing; null otherwise. */
export async function organizerBySlug(db: GofDb, slug: string): Promise<OrganizerRow | null> {
  const rows = await db
    .select()
    .from(organizers)
    .where(
      and(
        eq(organizers.slug, slug),
        sql`exists (select 1 from ${outings} where ${outings.organizerId} = ${organizers.id} and ${outings.published} = 1)`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface CityInfo {
  id: number | null;
  slug: string;
  name: string;
  state: string;
  lat: number | null;
  lng: number | null;
  population: number;
  timeZone: string | null;
}

/**
 * A city by state and slug: the `cities` row (GeoNames), else a course city with
 * that slug (OSM addr:city not in cities1000). Null when neither exists.
 */
export async function cityBySlug(db: GofDb, state: string, slug: string): Promise<CityInfo | null> {
  const st = state.toUpperCase();
  const rows = await db
    .select()
    .from(cities)
    .where(and(eq(cities.state, st), eq(cities.slug, slug)))
    .limit(1);
  const c = rows[0];
  if (c) return { ...c };
  const names = await db
    .selectDistinct({ city: courses.city })
    .from(courses)
    .where(and(eq(courses.state, st), isNotNull(courses.city)));
  const match = names.find((n) => n.city !== null && citySlug(n.city) === slug);
  if (!match?.city) return null;
  const centre = await db
    .select({ lat: sql<number>`avg(${courses.lat})`, lng: sql<number>`avg(${courses.lng})` })
    .from(courses)
    .where(and(eq(courses.state, st), eq(courses.city, match.city)));
  return {
    id: null,
    slug,
    name: match.city,
    state: st,
    lat: centre[0]?.lat ?? null,
    lng: centre[0]?.lng ?? null,
    population: 0,
    timeZone: null,
  };
}

/**
 * Cities near a point that have a published outing that is upcoming, expected,
 * or within the last 12 months (so the link goes to an indexable page).
 */
export async function nearbyCitiesWithOutings(
  db: GofDb,
  opts: { center: LatLng; state?: string; radiusKm?: number; today: string; excludeCity?: string; limit?: number },
): Promise<{ city: string; state: string; distanceKm: number }[]> {
  const radius = opts.radiusKm ?? 60;
  const box = bboxAround(opts.center, radius);
  const rows = await db
    .select({ city: courses.city, state: courses.state, lat: sql<number>`avg(${courses.lat})`, lng: sql<number>`avg(${courses.lng})` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(
      and(
        indexableCityOutingClause(opts.today),
        isNotNull(courses.city),
        gte(courses.lat, box.minLat),
        lte(courses.lat, box.maxLat),
        gte(courses.lng, box.minLng),
        lte(courses.lng, box.maxLng),
        opts.state ? eq(courses.state, opts.state.toUpperCase()) : undefined,
      ),
    )
    .groupBy(courses.state, courses.city);
  const exclude = opts.excludeCity?.toLowerCase();
  return rows
    .flatMap((r) => (r.city && r.city.toLowerCase() !== exclude ? [{ city: r.city, state: r.state, distanceKm: haversineKm(opts.center, { lat: Number(r.lat), lng: Number(r.lng) }) }] : []))
    .filter((r) => r.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, opts.limit ?? 8);
}

/** A ZIP's centroid and city, for zip search on `/`. */
export async function zipLookup(
  db: GofDb,
  zip: string,
): Promise<{ zip: string; lat: number; lng: number; city: string | null; state: string | null } | null> {
  if (!/^\d{5}$/.test(zip)) return null;
  const rows = await db
    .select({ zip: zips.zip, lat: zips.lat, lng: zips.lng, city: cities.name, state: cities.state })
    .from(zips)
    .leftJoin(cities, eq(zips.cityId, cities.id))
    .where(eq(zips.zip, zip))
    .limit(1);
  return rows[0] ?? null;
}

/** Cities matching a typed prefix, most populous first (search box on `/`). */
export async function searchCities(
  db: GofDb,
  prefix: string,
  limit = 10,
): Promise<{ slug: string; name: string; state: string; lat: number; lng: number }[]> {
  const p = prefix.trim().toLowerCase().replace(/[%_\\]/g, "");
  if (p.length < 2) return [];
  return db
    .select({ slug: cities.slug, name: cities.name, state: cities.state, lat: cities.lat, lng: cities.lng })
    .from(cities)
    .where(sql`lower(${cities.name}) like ${`${p}%`}`)
    .orderBy(desc(cities.population), asc(cities.name))
    .limit(limit);
}

// ---------------------------------------------------------------- sitemaps (SPEC.md 9.1, 9.4)

export interface SitemapEntry {
  path: string;
  lastmod: string;
}

/** Published outings with a live source, including expected and past ones. */
export async function sitemapOutings(db: GofDb): Promise<SitemapEntry[]> {
  const rows = await db
    .select({ slug: outings.slug, updatedAt: outings.updatedAt })
    .from(outings)
    .where(and(eq(outings.published, 1), eq(outings.sourceGone, 0)))
    .orderBy(asc(outings.slug));
  return rows.map((r) => ({ path: `/outings/${r.slug}`, lastmod: r.updatedAt }));
}

/** Courses with at least one published outing; others 404. */
export async function sitemapCourses(db: GofDb): Promise<SitemapEntry[]> {
  const rows = await db
    .select({ slug: courses.slug, updatedAt: courses.updatedAt })
    .from(courses)
    .where(gte(courses.outingCount, 1))
    .orderBy(asc(courses.slug));
  return rows.map((r) => ({ path: `/courses/${r.slug}`, lastmod: r.updatedAt }));
}

/** Organizers with at least one published outing. */
export async function sitemapOrganizers(db: GofDb): Promise<SitemapEntry[]> {
  const rows = await db
    .select({ slug: organizers.slug, updatedAt: sql<string>`max(${outings.updatedAt})` })
    .from(organizers)
    .innerJoin(outings, eq(outings.organizerId, organizers.id))
    .where(eq(outings.published, 1))
    .groupBy(organizers.id)
    .orderBy(asc(organizers.slug));
  return rows.map((r) => ({ path: `/organizers/${r.slug}`, lastmod: r.updatedAt }));
}

/**
 * A city page is indexed when the city has a published outing that is upcoming
 * (dated or expected) or happened in the last 12 months (SPEC.md 9.1).
 */
function indexableCityOutingClause(today: string): SQL {
  const since = twelveMonthsBefore(today);
  return and(
    eq(outings.published, 1),
    or(eq(outings.status, "expected"), gte(sql`coalesce(${outings.endDate}, ${outings.startDate})`, since)),
  ) as SQL;
}

export interface IndexableCity {
  state: string;
  city: string;
  lastmod: string;
}

async function indexableCities(db: GofDb, today: string, charityOnly: boolean): Promise<IndexableCity[]> {
  const rows = await db
    .select({ state: courses.state, city: courses.city, lastmod: sql<string>`max(${outings.updatedAt})` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(
      and(
        indexableCityOutingClause(today),
        isNotNull(courses.city),
        charityOnly ? inArray(outings.outingType, [...CHARITY_TYPES]) : undefined,
      ),
    )
    .groupBy(courses.state, courses.city)
    .orderBy(asc(courses.state), asc(courses.city));
  return rows.flatMap((r) => (r.city ? [{ state: r.state, city: r.city, lastmod: r.lastmod }] : []));
}

/** City pages to index: `/golf-outings/{state}/{kebab(city)}`. */
export const sitemapCities = (db: GofDb, today: string) => indexableCities(db, today, false);

/** Charity city pages to index: `/charity-golf-tournaments/{state}/{kebab(city)}`. */
export const sitemapCharityCities = (db: GofDb, today: string) => indexableCities(db, today, true);

/** True when the city page should be indexed (same rule as the sitemap). */
export async function isCityIndexable(
  db: GofDb,
  state: string,
  city: string,
  today: string,
  charityOnly = false,
): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(
      and(
        indexableCityOutingClause(today),
        eq(courses.state, state.toUpperCase()),
        sql`lower(${courses.city}) = lower(${city})`,
        charityOnly ? inArray(outings.outingType, [...CHARITY_TYPES]) : undefined,
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** States with at least one published outing, for `/golf-outings/{state}`. */
export async function sitemapStates(db: GofDb): Promise<{ state: string; lastmod: string }[]> {
  const rows = await db
    .select({ state: courses.state, lastmod: sql<string>`max(${outings.updatedAt})` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(eq(outings.published, 1))
    .groupBy(courses.state)
    .orderBy(asc(courses.state));
  return rows;
}

/**
 * States whose page is indexed: at least one published outing that is upcoming
 * (listed status, `end_date ?? start_date` on or after today) or expected. Past-only
 * states render with noindex, so they stay out of the sitemap.
 */
export async function sitemapStatesCurrent(db: GofDb, today: string): Promise<{ state: string; lastmod: string }[]> {
  return db
    .select({ state: courses.state, lastmod: sql<string>`max(${outings.updatedAt})` })
    .from(outings)
    .innerJoin(courses, eq(outings.courseId, courses.id))
    .where(or(upcomingClause(today), and(eq(outings.published, 1), eq(outings.status, "expected"))))
    .groupBy(courses.state)
    .orderBy(asc(courses.state));
}
