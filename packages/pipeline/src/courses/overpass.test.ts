import { describe, expect, it } from "vitest";
import {
  bboxQuery,
  fetchOverpass,
  overpassResponseSchema,
  stateQuery,
  toOsmFeatures,
} from "./overpass.ts";

describe("query builders", () => {
  it("queries one state for golf courses with out center tags", () => {
    const q = stateQuery("NY");
    expect(q).toContain('area["ISO3166-2"="US-NY"][admin_level=4]->.s;');
    expect(q).toContain('nwr["leisure"="golf_course"](area.s);');
    expect(q).toMatch(/out center tags;$/);
    expect(q.startsWith("[out:json]")).toBe(true);
  });

  it("limits a state query to bounding boxes (south, west, north, east)", () => {
    const q = bboxQuery("CA", [{ minLat: 34.1, minLng: -118.3, maxLat: 34.2, maxLng: -118.2 }]);
    expect(q).toContain('nwr["leisure"="golf_course"](area.s)(34.1,-118.3,34.2,-118.2);');
  });

  it("rejects a state code that is not two letters", () => {
    expect(() => stateQuery("N\"Y")).toThrow();
  });
});

describe("toOsmFeatures", () => {
  it("uses node coordinates or the way/relation centre and keeps tags", () => {
    const res = overpassResponseSchema.parse({
      elements: [
        { type: "node", id: 1, lat: 40.1, lon: -73.1, tags: { leisure: "golf_course", name: "A" } },
        { type: "way", id: 2, center: { lat: 40.2, lon: -73.2 }, tags: { leisure: "golf_course", name: "B" } },
        { type: "relation", id: 3, tags: { name: "No centre" } },
      ],
    });
    expect(toOsmFeatures(res, "NY")).toEqual([
      { osmRef: "node/1", state: "NY", lat: 40.1, lng: -73.1, tags: { leisure: "golf_course", name: "A" } },
      { osmRef: "way/2", state: "NY", lat: 40.2, lng: -73.2, tags: { leisure: "golf_course", name: "B" } },
    ]);
  });
});

describe("fetchOverpass", () => {
  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("backs off and retries on 429 and 504, then succeeds", async () => {
    const statuses = [429, 504];
    const sleeps: number[] = [];
    let calls = 0;
    const res = await fetchOverpass("[out:json];", {
      endpoint: "https://overpass.example/api/interpreter",
      userAgent: "GolfOutingFinderBot/1.0 (+http://localhost/bot)",
      fetch: async () => {
        calls++;
        const s = statuses.shift();
        return s ? new Response("busy", { status: s }) : ok({ elements: [] });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      baseDelayMs: 1000,
    });
    expect(res.elements).toEqual([]);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("retries when Overpass answers 200 with an XML error page", async () => {
    let calls = 0;
    const res = await fetchOverpass("[out:json];", {
      endpoint: "https://overpass.example/api/interpreter",
      userAgent: "ua",
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response("<?xml version='1.0'?><osm>runtime error</osm>") : ok({ elements: [] });
      },
      sleep: async () => {},
      baseDelayMs: 1,
    });
    expect(res.elements).toEqual([]);
    expect(calls).toBe(2);
  });

  it("gives up after the last attempt", async () => {
    await expect(
      fetchOverpass("[out:json];", {
        endpoint: "https://overpass.example/api/interpreter",
        userAgent: "ua",
        fetch: async () => new Response("busy", { status: 429 }),
        sleep: async () => {},
        attempts: 3,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(/429/);
  });

  it("does not retry a 400 (bad query)", async () => {
    let calls = 0;
    await expect(
      fetchOverpass("bad", {
        endpoint: "https://overpass.example/api/interpreter",
        userAgent: "ua",
        fetch: async () => {
          calls++;
          return new Response("parse error", { status: 400 });
        },
        sleep: async () => {},
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});
