import { describe, expect, it } from "vitest";
import { accessItemSchema, buildAccessPlan, itemKey, itemsFromFile, type AccessItem } from "./load.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const TOP = [
  { name: "The Grove XXIII", state: "FL", osm_ref: "way/976384744" },
  { name: "Winged Foot Golf Club (West)", state: "NY", osm_ref: "way/122734591" },
  { name: "Pine Valley Golf Club", state: "NJ", osm_ref: null },
];
const BY_REF = new Map([
  ["way/976384744", "crs_grove"],
  ["way/122734591", "crs_wf"],
]);
const BY_NAME = new Map([["ny/maidstone club", "crs_maid"]]);
const GROVE = "https://www.32auctions.com/organizations/71786/auctions/206177/auction_items/7139828";

function item(over: Partial<AccessItem> = {}): AccessItem {
  return accessItemSchema.parse({
    course_name: "The Grove XXIII",
    course_state: "FL",
    kind: "auction",
    title: "Foursome with lunch, drinks and caddies",
    organizer: "First Tee Greater Washington DC",
    event_name: "First Tee DC 2026 auction",
    platform: "www.32auctions.com",
    link: GROVE,
    date_start: null,
    date_end: "2026-09-28",
    season: null,
    recurring: false,
    price_kind: "sold",
    price_min_usd: 14000,
    price_max_usd: null,
    players: 4,
    member_hosted: null,
    status: "closed",
    confirmed: "fetched",
    note: null,
    ...over,
  });
}

const plan = (items: AccessItem[], existingKeys: string[] = []) =>
  buildAccessPlan({ items, topCourses: TOP, courseIdByOsmRef: BY_REF, courseIdByName: BY_NAME, now: NOW, existingKeys, takenSlugs: new Set() });

describe("buildAccessPlan", () => {
  it("ties an item to its course through the top-course list and publishes it", () => {
    const { rows } = plan([item()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      course_id: "crs_grove",
      kind: "auction",
      platform: "32auctions.com",
      price_kind: "sold",
      price_min_cents: 1_400_000,
      date_end: "2026-09-28",
      status: "closed",
      published: 1,
      hold_reason: null,
      slug: "auction/foursome-with-lunch-drinks-and-caddies-the-grove-xxiii",
    });
    expect(rows[0]?.id).toMatch(/^acc_[0-9A-Z]{26}$/);
  });

  it("matches a club name without the course suffix, then any course by exact name and state", () => {
    expect(plan([item({ course_name: "Winged Foot Golf Club", course_state: "NY" })]).rows[0]?.course_id).toBe("crs_wf");
    expect(plan([item({ course_name: "Maidstone Club", course_state: "NY" })]).rows[0]?.course_id).toBe("crs_maid");
  });

  it("keeps an item at an unknown course, unpublished", () => {
    const { rows } = plan([item({ course_name: "Pine Valley Golf Club", course_state: "NJ" }), item({ course_name: "Somewhere CC", link: "https://x.org/a" })]);
    expect(rows.map((r) => [r.course_id, r.published, r.hold_reason])).toEqual([
      [null, 0, "course_unmatched"],
      [null, 0, "course_unmatched"],
    ]);
  });

  it("an open item whose end date has passed is closed; recurring stays recurring", () => {
    expect(plan([item({ status: "open", price_kind: "current_bid", date_end: "2026-11-01" })]).rows[0]?.status).toBe("closed");
    expect(plan([item({ status: "open", price_kind: "current_bid", date_end: "2026-12-05" })]).rows[0]?.status).toBe("open");
    expect(plan([item({ status: "recurring", recurring: true, date_end: null, kind: "member_for_a_day" })]).rows[0]).toMatchObject({
      status: "recurring",
      recurring: 1,
    });
  });

  it("skips repeats within a load and items already stored; catalog lots sharing a link stay apart", () => {
    const stored = itemKey(GROVE, "auction", "The Grove XXIII", "Foursome with lunch, drinks and caddies");
    expect(plan([item()], [stored]).skipped.map((s) => s.reason)).toEqual(["already stored"]);
    expect(plan([item(), item()]).skipped.map((s) => s.reason)).toEqual(["repeated in this load"]);
    const catalog = "https://e.givesmart.com/events/Nkt/i/_All/";
    expect(plan([item({ link: catalog }), item({ link: catalog, title: "Golf and lunch for 3" })]).rows).toHaveLength(2);
  });

  it("refuses non-http links, bad dates and over-long titles at parse time", () => {
    expect(() => item({ link: "javascript:alert(1)" })).toThrow();
    expect(() => item({ date_end: "Sept 2026" })).toThrow();
    expect(() => item({ title: "x".repeat(200) })).toThrow();
  });
});

describe("itemsFromFile", () => {
  it("reads the research runner's files", () => {
    const items = itemsFromFile({ club: { club: "X" }, opportunities: [item()], queries_run: [] });
    expect(items).toHaveLength(1);
  });

  it("converts the first-round agent files: lots to auctions, listings to their kind", () => {
    const items = itemsFromFile({
      lots: [
        {
          club: "The Grove XXIII",
          state: "FL",
          title: "Foursome",
          players: 4,
          member_hosted: null,
          includes: [],
          organizer: "First Tee DC",
          auction_name: null,
          platform: "32auctions.com",
          close_date: "2026-09-28",
          price_kind: "sold",
          price_usd: 14000,
          value_usd: null,
          status: "closed",
          url: GROVE,
          confirmed: "fetched",
        },
      ],
      listings: [
        { club: "Maidstone Club", state: "NY", kind: "outing", title: "Charity outing", organizer: null, date: "2026-06-01", platform: "x.org", url: "https://x.org/o", confirmed: "snippet" },
      ],
    });
    expect(items.map((i) => [i.kind, i.course_name, i.date_end ?? i.date_start, i.price_min_usd])).toEqual([
      ["auction", "The Grove XXIII", "2026-09-28", 14000],
      ["outing", "Maidstone Club", "2026-06-01", null],
    ]);
  });

  it("drops an entry that doesn't validate instead of failing the whole file", () => {
    const items = itemsFromFile({ opportunities: [item(), { ...item(), link: "not a url" }] });
    expect(items).toHaveLength(1);
  });
});
