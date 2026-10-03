import { z } from "zod";
import type { BBox } from "@gof/shared/places";

/**
 * Overpass API edge for the course import (SPEC.md 8.1 step 1). Query builders
 * and response parsing are pure; `fetchOverpass` takes `fetch` and `sleep` so the
 * backoff is tested offline.
 */

export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

const STATE = /^[A-Z]{2}$/;

function assertState(state: string): void {
  if (!STATE.test(state)) throw new Error(`bad state code: ${state}`);
}

function areaClause(state: string): string {
  assertState(state);
  return `area["ISO3166-2"="US-${state}"][admin_level=4]->.s;`;
}

/** Every golf course in a state (the live monthly import). */
export function stateQuery(state: string, timeoutSec = 600): string {
  return `[out:json][timeout:${timeoutSec}];${areaClause(state)}(nwr["leisure"="golf_course"](area.s););out center tags;`;
}

const coord = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** Golf courses in a state, limited to bounding boxes (used to record the fixture). */
export function bboxQuery(state: string, boxes: readonly BBox[], timeoutSec = 180): string {
  const parts = boxes
    .map(
      (b) =>
        `nwr["leisure"="golf_course"](area.s)(${coord(b.minLat)},${coord(b.minLng)},${coord(b.maxLat)},${coord(b.maxLng)});`,
    )
    .join("");
  return `[out:json][timeout:${timeoutSec}];${areaClause(state)}(${parts});out center tags;`;
}

/** Golf courses in a state whose name matches a case-insensitive regex. */
export function nameQuery(state: string, nameRegex: string, timeoutSec = 180): string {
  if (/["\\\n]/.test(nameRegex)) throw new Error("name regex must not contain quotes or backslashes");
  return `[out:json][timeout:${timeoutSec}];${areaClause(state)}(nwr["leisure"="golf_course"]["name"~"${nameRegex}",i](area.s););out center tags;`;
}

const latLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

export const overpassElementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int().positive(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  center: latLon.optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type OverpassElement = z.infer<typeof overpassElementSchema>;

export const overpassResponseSchema = z.object({
  elements: z.array(overpassElementSchema),
});
export type OverpassResponse = z.infer<typeof overpassResponseSchema>;

export interface OsmFeature {
  osmRef: string;
  state: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

export function toOsmFeatures(res: OverpassResponse, state: string): OsmFeature[] {
  const out: OsmFeature[] = [];
  for (const e of res.elements) {
    const lat = e.center?.lat ?? e.lat;
    const lng = e.center?.lon ?? e.lon;
    if (lat === undefined || lng === undefined) continue;
    out.push({ osmRef: `${e.type}/${e.id}`, state, lat, lng, tags: e.tags ?? {} });
  }
  return out;
}

export interface OverpassClientOptions {
  endpoint?: string;
  userAgent: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  baseDelayMs?: number;
  /** Largest response accepted, in bytes. */
  maxBytes?: number;
  /** Per-request timeout; Overpass queries carry their own server-side timeout too. */
  timeoutMs?: number;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

class RetryableError extends Error {}

/**
 * POSTs a query and validates the JSON with zod. Retries with exponential backoff
 * on 429, 502, 503, 504, network errors, and the XML error page Overpass returns
 * with status 200 when a query times out or runs out of memory.
 */
export async function fetchOverpass(query: string, opts: OverpassClientOptions): Promise<OverpassResponse> {
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(base * 2 ** (attempt - 1));
    try {
      const res = await doFetch(opts.endpoint ?? OVERPASS_ENDPOINT, {
        method: "POST",
        headers: {
          "user-agent": opts.userAgent,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ data: query }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 11 * 60_000),
      });
      const text = await res.text();
      if (text.length > maxBytes) throw new Error(`Overpass response over ${maxBytes} bytes`);
      if (RETRY_STATUSES.has(res.status)) throw new RetryableError(`Overpass HTTP ${res.status}`);
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${text.slice(0, 200)}`);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RetryableError(`Overpass returned non-JSON: ${text.slice(0, 120)}`);
      }
      const remark = z.object({ remark: z.string() }).safeParse(json);
      if (remark.success && /runtime error|timed out|out of memory/i.test(remark.data.remark)) {
        throw new RetryableError(`Overpass remark: ${remark.data.remark}`);
      }
      return overpassResponseSchema.parse(json);
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof RetryableError ||
        (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) ||
        (err instanceof TypeError && !(err instanceof z.ZodError));
      if (!retryable) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Overpass request failed");
}
