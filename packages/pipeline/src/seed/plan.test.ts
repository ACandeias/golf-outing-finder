import { describe, expect, it } from "vitest";
import type { CourseRecord } from "../courses/import.ts";
import { PlaceLocator } from "../places/locator.ts";
import { SeedMatchError, buildSeedPlan, type SeedPlanInput } from "./plan.ts";
import type { SeedEntry, SeedFile } from "./seed-file.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");

function course(id: string, name: string, state: string, city: string, lat: number, lng: number): CourseRecord {
  return {
    id,
    slug: `${state.toLowerCase()}/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    aliases: [],
    street: null,
    city,
    state,
    zip: null,
    lat,
    lng,
    timeZone: "America/New_York",
    courseType: "private",
    courseTypeSource: "override",
    courseTypeConfidence: 1,
    notable: 0,
    website: null,
    osmRef: `way/${id}`,
    outingCount: 0,
    lastOutingDate: null,
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
  };
}

const COURSES: CourseRecord[] = [
  course("1", "Winged Foot Golf Club", "NY", "Mamaroneck", 40.9625, -73.7539),
  course("2", "Metropolis Country Club", "NY", "White Plains", 41.0366, -73.8002),
  course("3", "Torrey Pines North Course", "CA", "La Jolla", 32.9087, -117.249),
  course("4", "Torrey Pines South Course", "CA", "La Jolla", 32.8971, -117.2476),
  course("5", "Encanto 18 Golf Course", "AZ", "Phoenix", 33.4752, -112.0897),
  course("6", "Arizona Biltmore Golf Club", "AZ", "Phoenix", 33.5262, -112.0226),
];

const LOCATOR = new PlaceLocator(
  [
    { id: 1, slug: "mamaroneck", name: "Mamaroneck", state: "NY", lat: 40.94871, lng: -73.73263, population: 1, timeZone: "America/New_York" },
    { id: 2, slug: "white-plains", name: "White Plains", state: "NY", lat: 41.03399, lng: -73.76291, population: 1, timeZone: "America/New_York" },
    { id: 3, slug: "la-jolla", name: "La Jolla", state: "CA", lat: 32.84727, lng: -117.2742, population: 1, timeZone: "America/Los_Angeles" },
    { id: 4, slug: "phoenix", name: "Phoenix", state: "AZ", lat: 33.44838, lng: -112.07404, population: 1, timeZone: "America/Phoenix" },
  ],
  [],
);

const open = (over: Partial<SeedEntry> & { id: string }): SeedEntry => ({
  status: "open",
  title: "Golf Classic",
  organizer_name: "Example Foundation",
  course_name: "Winged Foot Golf Club",
  course_city: "Mamaroneck",
  course_state: "NY",
  start_date: "2026-10-19",
  shotgun_time: "12:00",
  single_price_usd: null,
  foursome_price_usd: null,
  sponsor_only: false,
  audience: "open",
  source_url: "https://example.org/golf",
  registration_url: "https://example.org/golf/register",
  source_kind: "organizer",
  expected_course_type: "private",
  expected_outing_type: "charity",
  ...over,
});

function input(outings: SeedEntry[], over: Partial<SeedPlanInput> = {}): SeedPlanInput {
  const seed: SeedFile = { version: "test", outings };
  return {
    seed,
    courses: COURSES,
    locator: LOCATOR,
    now: NOW,
    includeTestEntries: false,
    registrationHosts: ["qgiv.com", "networkforgood.com"],
    removals: { outing_ids: [], urls: [] },
    ...over,
  };
}

describe("buildSeedPlan", () => {
  it("loads an open entry: cents, status open, published, sources and links", () => {
    const plan = buildSeedPlan(
      input([open({ id: "s01-a", single_price_usd: 125, foursome_price_usd: 119.22, format: "scramble" })]),
    );
    expect(plan.outings).toHaveLength(1);
    const o = plan.outings[0]!;
    expect(o).toMatchObject({
      courseId: "1",
      status: "open",
      startDate: "2026-10-19",
      shotgunTime: "12:00",
      singlePriceCents: 12500,
      foursomePriceCents: 11922,
      outingType: "charity",
      published: 1,
      holdReason: null,
      registrationUrl: "https://example.org/golf/register",
      canonicalSourceUrl: "https://example.org/golf",
      format: "scramble",
      confidence: 1,
      firstSeen: "2026-09-28T12:00:00.000Z",
    });
    expect(o.id.startsWith("out_")).toBe(true);
    expect(o.slug).toBe("2026/golf-classic-winged-foot");
    expect(plan.sources.map((s) => [s.url, s.kind, s.domain])).toEqual([
      ["https://example.org/golf", "organizer", "example.org"],
      ["https://example.org/golf/register", "organizer", "example.org"],
    ]);
    expect(plan.sourceOutings).toHaveLength(2);
    expect(plan.matches[0]).toMatchObject({ seedId: "s01-a", courseId: "1" });
  });

  it("loads expected entries with the seed's expected_month and an announced date", () => {
    const plan = buildSeedPlan(
      input([
        { ...open({ id: "e01-a" }), status: "expected", start_date: undefined, shotgun_time: undefined, last_date: "2026-06-01", expected_month: "2027-06" },
        {
          ...open({ id: "e05-b", organizer_name: "Other Org" }),
          status: "expected",
          start_date: undefined,
          shotgun_time: undefined,
          last_date: "2026-06-01",
          expected_month: "2027-06",
          announced_date: "2027-06-07",
        },
      ]),
    );
    const [a, b] = plan.outings;
    expect(a).toMatchObject({ status: "expected", expectedMonth: "2027-06", startDate: null, published: 1 });
    expect(a?.slug.startsWith("2027/")).toBe(true);
    expect(b).toMatchObject({ status: "expected", expectedMonth: "2027-06", startDate: "2027-06-07", published: 1 });
  });

  it("holds an expected entry with no month as no_date, unpublished (e17)", () => {
    const plan = buildSeedPlan(
      input([{ ...open({ id: "e17-a" }), status: "expected", start_date: undefined, last_date: null, expected_month: null }]),
    );
    expect(plan.outings[0]).toMatchObject({ status: "expected", published: 0, holdReason: "no_date", expectedMonth: null });
  });

  it("dedupes organizers by name, sets org_type and unverified charity status", () => {
    const plan = buildSeedPlan(
      input([
        open({ id: "s01-a", organizer_name: "National Kidney Foundation" }),
        open({ id: "s02-b", organizer_name: "National Kidney Foundation", start_date: "2026-10-20" }),
        open({ id: "s03-c", organizer_name: "Builders Institute", expected_outing_type: "business_association", start_date: "2026-10-21" }),
        open({ id: "s04-d", organizer_name: "Fordham University", expected_outing_type: "school_fundraiser", start_date: "2026-10-22" }),
        open({ id: "s05-e", organizer_name: "Golf With Access", expected_outing_type: "access_day", start_date: "2026-10-23" }),
        open({ id: "s06-f", organizer_name: "AmateurGolf.com", expected_outing_type: "open_tournament", start_date: "2026-10-24" }),
      ]),
    );
    expect(plan.organizers.map((o) => [o.slug, o.orgType, o.charityStatus])).toEqual([
      ["national-kidney-foundation", "charity", "unverified"],
      ["builders-institute", "business_association", "unverified"],
      ["fordham-university", "school", "unverified"],
      ["golf-with-access", "access_operator", "unverified"],
      ["amateurgolf-com", "tournament_operator", "unverified"],
    ]);
    const nkf = plan.organizers[0]!.id;
    expect(plan.outings.filter((o) => o.organizerId === nkf)).toHaveLength(2);
  });

  it("gives colliding organizer slugs -2", () => {
    const plan = buildSeedPlan(
      input([
        open({ id: "s01-a", organizer_name: "Hope Fund" }),
        open({ id: "s02-b", organizer_name: "Hope Fund!", start_date: "2026-10-20" }),
      ]),
    );
    expect(plan.organizers.map((o) => o.slug)).toEqual(["hope-fund", "hope-fund-2"]);
  });

  it("leaves organizer_id null when the seed has no organizer", () => {
    const plan = buildSeedPlan(input([open({ id: "s01-a", organizer_name: null })]));
    expect(plan.organizers).toEqual([]);
    expect(plan.outings[0]?.organizerId).toBeNull();
  });

  it("skips synthetic and excluded entries unless asked", () => {
    const entries = [
      open({ id: "s01-a" }),
      { ...open({ id: "s14-x", start_date: "2026-10-13" }), status: "excluded" as const },
      {
        ...open({ id: "s15-y", start_date: undefined, organizer_name: undefined }),
        status: "synthetic" as const,
        fixture_text: "Join us Monday, March 15, 2027 for our charity golf tournament.",
      },
    ];
    expect(buildSeedPlan(input(entries)).outings).toHaveLength(1);
    const withTests = buildSeedPlan(input(entries, { includeTestEntries: true }));
    expect(withTests.skipped).toEqual([]);
    const bySeed = new Map(withTests.matches.map((m) => [m.seedId, m.outingId]));
    const out = (id: string) => withTests.outings.find((o) => o.id === bySeed.get(id));
    expect(out("s14-x")).toMatchObject({ published: 0, status: "open" });
    expect(out("s15-y")).toMatchObject({ published: 1, startDate: "2027-03-15" });
  });

  it("fails loudly, listing every entry that does not match a course", () => {
    const run = () =>
      buildSeedPlan(
        input([
          open({ id: "s01-a", course_name: "Nowhere Golf Club" }),
          open({ id: "s02-b" }),
          open({ id: "s03-c", course_name: "Winged Foot Golf Club", course_state: "CA", course_city: "La Jolla" }),
        ]),
      );
    expect(run).toThrow(SeedMatchError);
    try {
      run();
    } catch (err) {
      expect(err instanceof SeedMatchError && err.unmatched.map((u) => u.seedId)).toEqual(["s01-a", "s03-c"]);
      expect(String(err)).toMatch(/s01-a.*Nowhere Golf Club/s);
    }
  });

  it("shares one source row between entries on the same page", () => {
    const plan = buildSeedPlan(
      input([
        open({ id: "s01-a", course_name: "Encanto 18 Golf Course", course_city: "Phoenix", course_state: "AZ", source_url: "https://azgolf.org/cal", registration_url: null, source_kind: "association" }),
        open({ id: "s09-b", course_name: "Arizona Biltmore Golf Club", course_city: "Phoenix", course_state: "AZ", source_url: "https://azgolf.org/cal", registration_url: "https://secure.qgiv.com/for/x", source_kind: "association" }),
      ]),
    );
    const cal = plan.sources.find((s) => s.url === "https://azgolf.org/cal");
    expect(cal?.kind).toBe("association");
    expect(plan.sourceOutings.filter((l) => l.sourceId === cal?.id)).toHaveLength(2);
    expect(plan.sources.find((s) => s.url.includes("qgiv"))?.kind).toBe("platform");
  });

  it("keeps the directory event page as canonical source and adds it as a source", () => {
    const plan = buildSeedPlan(
      input([
        open({
          id: "s10-a",
          source_url: "https://scramblehunter.com/",
          event_url: "https://scramblehunter.com/event/x/",
          registration_url: null,
          source_kind: "directory",
        }),
      ]),
    );
    expect(plan.outings[0]?.canonicalSourceUrl).toBe("https://scramblehunter.com/event/x/");
    expect(plan.sources.map((s) => s.kind)).toEqual(["directory", "directory"]);
  });

  it("drops a registration_url off the page's domain unless its host is allowed (A5)", () => {
    const plan = buildSeedPlan(
      input([
        open({ id: "s01-a", registration_url: "https://evil.example/pay" }),
        open({ id: "s02-b", start_date: "2026-10-20", registration_url: "https://thesecondopinion.networkforgood.com/e/1" }),
        open({ id: "s03-c", start_date: "2026-10-21", registration_url: "https://web.example.org/events/1" }),
      ]),
    );
    expect(plan.outings.map((o) => o.registrationUrl)).toEqual([
      null,
      "https://thesecondopinion.networkforgood.com/e/1",
      "https://web.example.org/events/1",
    ]);
  });

  it("picks the South course at Torrey Pines and records North as its alias", () => {
    const plan = buildSeedPlan(
      input([open({ id: "s13-a", course_name: "Torrey Pines Golf Course (South)", course_city: "La Jolla", course_state: "CA" })]),
    );
    const south = plan.courses.find((c) => c.id === "4");
    expect(plan.outings[0]?.courseId).toBe("4");
    expect(south?.aliases).toEqual(["Torrey Pines North Course"]);
  });

  it("sets outing_count and last_outing_date from published outings", () => {
    const plan = buildSeedPlan(
      input([
        open({ id: "s01-a", start_date: "2026-10-13" }),
        open({ id: "s02-b", start_date: "2026-10-19", organizer_name: "Other" }),
        { ...open({ id: "e17-c", organizer_name: "Third" }), status: "expected", start_date: undefined, expected_month: null },
      ]),
    );
    const wf = plan.courses.find((c) => c.id === "1");
    expect(wf?.outingCount).toBe(2);
    expect(wf?.lastOutingDate).toBe("2026-10-19");
    expect(plan.courses.find((c) => c.id === "2")?.outingCount).toBe(0);
  });

  it("honors removals.yaml by seed id, outing id or URL", () => {
    const plan = buildSeedPlan(
      input(
        [
          open({ id: "s01-a" }),
          open({ id: "s02-b", start_date: "2026-10-20", source_url: "https://gone.example.org/x", registration_url: null }),
        ],
        { removals: { outing_ids: ["s01-a"], urls: ["https://gone.example.org/x"] } },
      ),
    );
    expect(plan.outings.map((o) => [o.published, o.holdReason])).toEqual([
      [0, "removed"],
      [0, "removed"],
    ]);
  });

  it("gives colliding outing slugs -2", () => {
    const plan = buildSeedPlan(
      input([open({ id: "s01-a" }), open({ id: "s02-b", organizer_name: "Other", start_date: "2026-10-20" })]),
    );
    expect(plan.outings.map((o) => o.slug)).toEqual(["2026/golf-classic-winged-foot", "2026/golf-classic-winged-foot-2"]);
  });

  it("writes a short summary in our own words", () => {
    const plan = buildSeedPlan(
      input([open({ id: "s01-a", single_price_usd: 125, format: "scramble", shotgun_time: "07:00" })]),
    );
    const s = plan.outings[0]?.summary ?? "";
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain("Winged Foot Golf Club");
    expect(s).toContain("$125");
    expect(s).not.toMatch(/exclusive|elite|prestigious|bucket list/i);
  });

  it("is deterministic for the same input and clock", () => {
    const a = buildSeedPlan(input([open({ id: "s01-a" })]));
    const b = buildSeedPlan(input([open({ id: "s01-a" })]));
    expect(a).toEqual(b);
  });
});
