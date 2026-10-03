import type { APIRoute } from "astro";
import { z } from "zod";
import { listUpcomingOutings, MAX_API_RESULTS, nearbyUpcomingOutings, type OutingFilters, type OutingListItem } from "@gof/db/queries";
import { parseFilterParams } from "@gof/shared/filter-params";
import { courseTypesForFilters } from "@gof/shared/filters";
import { milesToKm, type BBox } from "@gof/shared/places";
import { getDb } from "../../lib/db.ts";
import { listToday } from "../../lib/clock.ts";
import { cacheControl, TTL } from "../../lib/cache.ts";
import { outingView } from "../../lib/outing-view.ts";
import { outingPath } from "../../lib/urls.ts";

export const prerender = false;

const num = (min: number, max: number) => z.coerce.number().finite().min(min).max(max);

/** bbox=minLng,minLat,maxLng,maxLat (the GeoJSON order MapLibre's getBounds gives). */
const bboxParam = z
  .string()
  .max(200)
  .transform((s) => s.split(",").map((p) => Number(p.trim())))
  .pipe(z.tuple([num(-180, 180), num(-90, 90), num(-180, 180), num(-90, 90)]))
  .refine(([minLng, minLat, maxLng, maxLat]) => minLng <= maxLng && minLat <= maxLat, {
    message: "bbox must be minLng,minLat,maxLng,maxLat",
  })
  .transform(([minLng, minLat, maxLng, maxLat]): BBox => ({ minLng, minLat, maxLng, maxLat }));

const querySchema = z
  .object({
    bbox: bboxParam.optional(),
    lat: num(-90, 90).optional(),
    lng: num(-180, 180).optional(),
    /** Miles. */
    radius: num(1, 250).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_API_RESULTS).optional(),
  })
  .refine((q) => q.bbox !== undefined || (q.lat !== undefined && q.lng !== undefined), {
    message: "give bbox, or lat and lng (with an optional radius in miles)",
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), { message: "lat and lng go together" });

const KNOWN = new Set(["bbox", "lat", "lng", "radius", "limit", "course_type", "charity", "max_price", "from", "to", "distance", "format", "singles"]);

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": status === 200 ? "application/geo+json; charset=utf-8" : "application/json; charset=utf-8",
      "x-robots-tag": "noindex",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

function feature(o: OutingListItem & { distanceKm?: number }) {
  const v = outingView(o);
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [o.course.lng, o.course.lat] },
    properties: {
      url: outingPath(o.slug),
      title: o.title,
      course: o.course.name,
      place: v.place,
      when: v.when,
      time: v.time,
      startDate: o.startDate,
      status: o.status,
      courseType: v.courseTypeLabel,
      courseTypeCode: o.course.courseType,
      label: o.label,
      outingType: o.outingType,
      price: v.price,
      singlePriceCents: o.singlePriceCents,
      foursomePriceCents: o.foursomePriceCents,
      registrationUrl: o.registrationUrl,
      ...(o.distanceKm !== undefined ? { distanceMiles: Math.round((o.distanceKm / 1.609344) * 10) / 10 } : {}),
    },
  };
}

/**
 * Upcoming outings as GeoJSON (SPEC.md 9.1): bbox, or lat/lng plus a radius in
 * miles; the 9.2 filters; 200 results at most; cached for 10 minutes.
 */
export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams;
  const unknown = [...new Set(params.keys())].filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) return json({ error: `unknown parameter: ${unknown.join(", ")}` }, 400);

  const raw = Object.fromEntries(["bbox", "lat", "lng", "radius", "limit"].flatMap((k) => (params.has(k) ? [[k, params.get(k)]] : [])));
  const q = querySchema.safeParse(raw);
  if (!q.success) return json({ error: q.error.issues.map((i) => i.message).join("; ") }, 400);

  const parsed = parseFilterParams(params);
  if (parsed.invalid.length > 0) return json({ error: `invalid filter: ${parsed.invalid.join(", ")}` }, 400);
  const f = parsed.filters;

  const filters: OutingFilters = {
    courseTypes: f.courseTypes.length > 0 ? courseTypesForFilters(f.courseTypes) : undefined,
    charityOnly: f.charityOnly || undefined,
    maxPriceCents: f.maxPriceCents ?? undefined,
    from: f.from ?? undefined,
    to: f.to ?? undefined,
    format: f.format ?? undefined,
    singlesWelcome: f.singlesWelcome || undefined,
  };
  const db = getDb();
  const today = listToday();
  const limit = q.data.limit ?? MAX_API_RESULTS;

  let rows: (OutingListItem & { distanceKm?: number })[];
  if (q.data.lat !== undefined && q.data.lng !== undefined) {
    const miles = q.data.radius ?? f.distanceMiles ?? 50;
    rows = await nearbyUpcomingOutings(db, {
      ...filters,
      center: { lat: q.data.lat, lng: q.data.lng },
      radiusKm: milesToKm(miles),
      today,
      limit,
    });
    if (q.data.bbox) {
      const b = q.data.bbox;
      rows = rows.filter((r) => r.course.lat >= b.minLat && r.course.lat <= b.maxLat && r.course.lng >= b.minLng && r.course.lng <= b.maxLng);
    }
  } else {
    rows = await listUpcomingOutings(db, { ...filters, bbox: q.data.bbox, today, limit });
  }

  return json(
    { type: "FeatureCollection", features: rows.slice(0, limit).map(feature) },
    200,
    { "cache-control": cacheControl(TTL.api).replace("max-age=0", `max-age=${TTL.api}`) },
  );
};
