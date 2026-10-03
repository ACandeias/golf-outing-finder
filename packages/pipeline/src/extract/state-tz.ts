/**
 * The westernmost IANA zone in each state. Extract-collect checks "start date is
 * today or later" before the course (and so its exact zone) is known; the
 * westernmost zone has the latest-starting "today", so an outing is never
 * rejected early. Publish checks again with the matched course's own zone.
 */
const WESTERNMOST_ZONE: Readonly<Record<string, string>> = {
  AL: "America/Chicago",
  AK: "America/Adak",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/Chicago",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Los_Angeles",
  IL: "America/Chicago",
  IN: "America/Chicago",
  IA: "America/Chicago",
  KS: "America/Denver",
  KY: "America/Chicago",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Chicago",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Denver",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Denver",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Denver",
  TN: "America/Chicago",
  TX: "America/Denver",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
  PR: "America/Puerto_Rico",
};

/** With no state, the latest "today" in the US. */
export const FALLBACK_ZONE = "Pacific/Honolulu";

export function lenientZoneForState(state: string | null): string {
  if (!state) return FALLBACK_ZONE;
  return WESTERNMOST_ZONE[state.toUpperCase()] ?? FALLBACK_ZONE;
}
