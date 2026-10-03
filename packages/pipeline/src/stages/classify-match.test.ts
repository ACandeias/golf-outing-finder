import { describe, expect, it } from "vitest";
import { matchIrs } from "../classify/irs-match.ts";
import { isSchoolOrganizer, outingTypeFor } from "../classify/rules.ts";
import { tokenSetSimilarity } from "../classify/similarity.ts";
import { extracted, testCtx } from "../extract/test-helpers.ts";
import { classify } from "./classify.ts";
import { memoryIrsLookup } from "./irs-memory.ts";
import { match } from "./match.ts";
import type { CourseRow, IrsRecord } from "./types.ts";

const rec = (ein: string, name: string, state: string, subsection: string, sort_name: string | null = null): IrsRecord => ({
  ein,
  name,
  city: "X",
  state,
  subsection,
  sort_name,
});
const irs = memoryIrsLookup([
  rec("990000101", "NATIONAL KIDNEY FOUNDATION INC", "NY", "03"),
  rec("990000122", "BUILDERS INSTITUTE INC", "NY", "06"),
  rec("990000118", "BOYS CLUB OF NEW YORK", "NY", "03", "BCNY"),
  rec("990000200", "ROTARY CLUB OF PHOENIX", "AZ", "04"),
]);

describe("name similarity", () => {
  it("ignores case, order, punctuation and legal-form words", () => {
    expect(tokenSetSimilarity("National Kidney Foundation", "NATIONAL KIDNEY FOUNDATION INC")).toBe(1);
    expect(tokenSetSimilarity("Hope & Heroes Children's Cancer Fund", "HOPE AND HEROES CHILDRENS CANCER FUND")).toBe(1);
    expect(tokenSetSimilarity("Rotary Club of Phoenix", "Rotary Club of Tucson")).toBeLessThan(0.8);
  });
});

describe("IRS lookup", () => {
  it("tries the EIN, then the venue state at 0.92, then nationwide at 0.95", () => {
    expect(matchIrs(irs, { name: "Whatever", ein: "99-0000122", state: "CA" }).kind).toBe("ein");
    expect(matchIrs(irs, { name: "Builders Institute", ein: null, state: "NY" })).toMatchObject({
      kind: "state_name",
      record: { subsection: "06" },
    });
    expect(matchIrs(irs, { name: "National Kidney Foundation", ein: null, state: "PA" })).toMatchObject({
      kind: "national_name",
      record: { ein: "990000101" },
    });
    expect(matchIrs(irs, { name: "BCNY", ein: null, state: "NY" }).record?.ein).toBe("990000118");
    expect(matchIrs(irs, { name: "Kidney Friends", ein: null, state: "NY" }).kind).toBe("none");
    expect(matchIrs(irs, { name: null, ein: null, state: "NY" }).kind).toBe("none");
  });
});

describe("outing type rules", () => {
  const base = {
    organizerDomain: "example.org",
    organizerName: null,
    hint: "other" as const,
    irsSubsection: null,
    charityStatus: "unverified" as const,
    accessOperators: ["golfwithaccess.com"],
    tournamentOperators: ["amateurgolf.com"],
  };
  it("applies rules 1 to 7 in order", () => {
    expect(outingTypeFor({ ...base, organizerDomain: "golfwithaccess.com", hint: "charity" })).toBe("access_day");
    expect(outingTypeFor({ ...base, organizerDomain: "amateurgolf.com", hint: "pro_am" })).toBe("open_tournament");
    expect(outingTypeFor({ ...base, hint: "open_tournament" })).toBe("open_tournament");
    expect(outingTypeFor({ ...base, hint: "pro_am", organizerName: "Fordham University" })).toBe("pro_am");
    expect(outingTypeFor({ ...base, organizerName: "Fordham University", charityStatus: "501c3" })).toBe(
      "school_fundraiser",
    );
    expect(outingTypeFor({ ...base, irsSubsection: "06", charityStatus: "other_nonprofit", hint: "charity" })).toBe(
      "business_association",
    );
    expect(outingTypeFor({ ...base, charityStatus: "501c3" })).toBe("charity");
    expect(outingTypeFor({ ...base, hint: "charity" })).toBe("charity");
    expect(outingTypeFor(base)).toBe("other");
  });
  it("recognizes schools and booster clubs", () => {
    for (const n of ["Lincoln High School PTA", "Central Boosters", "Arizona State University", "St. Mary's Academy"])
      expect(isSchoolOrganizer(n), n).toBe(true);
    expect(isSchoolOrganizer("Boys Club of New York")).toBe(false);
  });
});

describe("classify stage", () => {
  it("excludes non-outings, rejected events and lodging-only packages", () => {
    const { output, result } = classify(testCtx(), {
      irs,
      events: [
        extracted({ is_outing: false, reject_reason: "members_only" }),
        extracted({ is_outing: false }),
        extracted({ lodging_required: true }),
        extracted(),
      ],
    });
    expect(output.outings.map((o) => o.exclude_reason)).toEqual(["members_only", "not_outing", "lodging_required", null]);
    expect(result.counters.events_excluded).toBe(3);
  });

  it("sets charity status, org_type and organizer domain", () => {
    const { output } = classify(testCtx(), {
      irs,
      events: [
        extracted({ organizer_name: "National Kidney Foundation", venue_state: "NY", source_url: "https://support.kidney.org/e/1" }),
        extracted({ organizer_name: "Rotary Club of Phoenix", outing_type_hint: "other" }),
      ],
    });
    expect(output.outings[0]).toMatchObject({
      charity_status: "501c3",
      outing_type: "charity",
      org_type: "charity",
      irs_match: "state_name",
      organizer_domain: "kidney.org",
    });
    expect(output.outings[1]).toMatchObject({ charity_status: "other_nonprofit", outing_type: "other", org_type: "other" });
  });
});

describe("match stage", () => {
  const course = (id: string, name: string, state: string, city: string, lat: number, lng: number): CourseRow => ({
    id,
    slug: `${state.toLowerCase()}/${id}`,
    name,
    aliases: "[]",
    street: null,
    city,
    state,
    zip: null,
    lat,
    lng,
    time_zone: state === "CA" ? "America/Los_Angeles" : "America/New_York",
    course_type: "private",
    course_type_source: null,
    course_type_confidence: null,
    notable: 0,
    website: null,
    osm_ref: null,
    outing_count: 0,
    last_outing_date: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  });
  const courses = [
    course("crs_glendale", "Oakmont Country Club", "CA", "Glendale", 34.18, -118.23),
    course("crs_pa", "Oakmont Country Club", "PA", "Oakmont", 40.53, -79.83),
  ];
  const classified = (patch: Parameters<typeof extracted>[0]) =>
    classify(testCtx(), { irs, events: [extracted(patch)] }).output.outings;

  it("matches within the venue state and holds the unmatched (course_unmatched)", () => {
    const { output, result } = match(testCtx(), {
      courses,
      places: [{ name: "Glendale", state: "CA", lat: 34.15, lng: -118.25 }],
      outings: [
        ...classified({ course_name: "Oakmont Country Club", venue_city: "Glendale", venue_state: "CA" }),
        ...classified({ course_name: "Nowhere Links", venue_state: "CA", event_index: 1 }),
        ...classified({ course_name: "Nowhere Links", venue_state: "CA", is_outing: false, event_index: 2 }),
      ],
    });
    expect(output.outings[0]!.match).toMatchObject({ kind: "matched", course_id: "crs_glendale", time_zone: "America/Los_Angeles" });
    expect(output.outings[1]!.hold_reason).toBe("course_unmatched");
    expect(output.outings[2]!.hold_reason).toBeNull();
    expect(result.holds).toEqual([
      { scope: "source", key: "https://example.org/golf", reason: "course_unmatched", event_index: 1 },
    ]);
  });

  it("keeps an earlier hold reason", () => {
    const { output } = match(testCtx(), {
      courses,
      places: [],
      outings: classified({ course_name: "Nowhere", hold_reason: "status_unknown" }),
    });
    expect(output.outings[0]!.hold_reason).toBe("status_unknown");
  });
});
