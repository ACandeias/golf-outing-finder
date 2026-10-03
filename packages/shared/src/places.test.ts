import { describe, expect, it } from "vitest";
import {
  DATA_ATTRIBUTIONS,
  SEED_STATES,
  US_STATES,
  bboxAround,
  haversineKm,
  inBBox,
  isUsStateCode,
} from "./places.ts";

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm({ lat: 40, lng: -73 }, { lat: 40, lng: -73 })).toBe(0);
  });
  it("measures Mamaroneck to White Plains at about 9 km", () => {
    const d = haversineKm({ lat: 40.94871, lng: -73.73263 }, { lat: 41.03399, lng: -73.76291 });
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(10);
  });
  it("puts Oakmont PA more than 3,000 km from Glendale CA", () => {
    expect(haversineKm({ lat: 40.52, lng: -79.84 }, { lat: 34.17, lng: -118.26 })).toBeGreaterThan(3000);
  });
});

describe("bboxAround", () => {
  it("contains every point within the radius", () => {
    const c = { lat: 40.96, lng: -73.75 };
    const b = bboxAround(c, 25);
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const rad = (bearing * Math.PI) / 180;
      const p = { lat: c.lat + (24.9 / 111) * Math.cos(rad), lng: c.lng + (24.9 / 84) * Math.sin(rad) };
      if (haversineKm(c, p) <= 25) expect(inBBox(p, b)).toBe(true);
    }
    expect(inBBox({ lat: c.lat + 1, lng: c.lng }, b)).toBe(false);
  });
});

describe("states", () => {
  it("knows 50 states plus DC and the ten seed states", () => {
    expect(Object.keys(US_STATES)).toHaveLength(51);
    for (const s of SEED_STATES) expect(isUsStateCode(s)).toBe(true);
    expect(isUsStateCode("ZZ")).toBe(false);
  });
});

describe("attributions", () => {
  it("credits OpenStreetMap, OpenFreeMap and GeoNames (CC BY 4.0)", () => {
    const names = DATA_ATTRIBUTIONS.map((a) => a.name);
    expect(names).toEqual(["OpenStreetMap", "OpenFreeMap", "GeoNames"]);
    expect(DATA_ATTRIBUTIONS.find((a) => a.name === "GeoNames")?.license).toBe("CC BY 4.0");
    expect(DATA_ATTRIBUTIONS[0]?.text).toContain("© OpenStreetMap contributors");
  });
});
