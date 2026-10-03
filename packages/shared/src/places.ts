/**
 * Places helpers shared by the pipeline and the site (SPEC.md v1.1 amendment A4):
 * state codes, distances, bounding boxes and the data attributions /about must show.
 */

/** The ten states the Phase 1 seed covers (SPEC.md section 13). */
export const SEED_STATES = ["NY", "NJ", "CT", "PA", "CA", "FL", "AZ", "MO", "IL", "GA"] as const;

/** USPS codes for the 50 states and DC, with display names. */
export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
});

export function isUsStateCode(code: string): boolean {
  return Object.hasOwn(US_STATES, code);
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const KM_PER_MILE = 1.609344;

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE;
}

/** A bounding box that contains every point within `km` of the centre. */
export function bboxAround(center: LatLng, km: number): BBox {
  const dLat = km / 110.574;
  const cos = Math.max(Math.cos(toRad(center.lat)), 0.01);
  const dLng = km / (111.32 * cos);
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLng: center.lng - dLng,
    maxLng: center.lng + dLng,
  };
}

export function inBBox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

export interface Attribution {
  name: string;
  text: string;
  url: string;
  license: string;
}

/** "© OpenStreetMap contributors" goes on the map and on every course page. */
export const OSM_ATTRIBUTION_TEXT = "© OpenStreetMap contributors";
/** Required by OpenFreeMap on the map (SPEC.md section 9.6). */
export const OPENFREEMAP_ATTRIBUTION_TEXT = "OpenFreeMap © OpenMapTiles Data from OpenStreetMap";
/** GeoNames data is CC BY 4.0; /about credits it. */
export const GEONAMES_ATTRIBUTION_TEXT =
  "City and ZIP code locations from GeoNames (geonames.org), licensed under CC BY 4.0.";

/** Every attribution /about carries (SPEC.md section 9.1). */
export const DATA_ATTRIBUTIONS: readonly Attribution[] = Object.freeze([
  {
    name: "OpenStreetMap",
    text: `Course names and locations ${OSM_ATTRIBUTION_TEXT}, available under the Open Database License.`,
    url: "https://www.openstreetmap.org/copyright",
    license: "ODbL 1.0",
  },
  {
    name: "OpenFreeMap",
    text: OPENFREEMAP_ATTRIBUTION_TEXT,
    url: "https://openfreemap.org",
    license: "OpenMapTiles / ODbL",
  },
  {
    name: "GeoNames",
    text: GEONAMES_ATTRIBUTION_TEXT,
    url: "https://www.geonames.org",
    license: "CC BY 4.0",
  },
]);
