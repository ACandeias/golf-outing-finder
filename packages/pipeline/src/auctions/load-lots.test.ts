import { describe, expect, it } from "vitest";
import { buildLotPlan, lotFileSchema, lotKey, type LotInput } from "./load-lots.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const TOP = [
  { name: "The Grove XXIII", state: "FL", osm_ref: "way/976384744" },
  { name: "Winged Foot Golf Club (West)", state: "NY", osm_ref: "way/122734591" },
  { name: "Pine Valley Golf Club", state: "NJ", osm_ref: null },
];
const COURSES = new Map([
  ["way/976384744", "crs_grove"],
  ["way/122734591", "crs_wf"],
]);

function lot(over: Partial<LotInput> = {}): LotInput {
  return lotFileSchema.parse({
    lots: [
      {
        club: "The Grove XXIII",
        state: "FL",
        title: "Foursome with lunch, drinks and caddies",
        players: 4,
        member_hosted: null,
        includes: ["lunch", "caddies"],
        organizer: "First Tee Greater Washington DC",
        auction_name: "First Tee DC 2026",
        platform: "32auctions.com",
        close_date: "2026-09-28",
        price_kind: "sold",
        price_usd: 14000,
        value_usd: null,
        status: "closed",
        url: "https://www.32auctions.com/organizations/71786/auctions/206177/auction_items/7139828",
        confirmed: "fetched",
        ...over,
      },
    ],
  }).lots[0]!;
}

const plan = (lots: LotInput[], existingKeys: string[] = []) =>
  buildLotPlan({ lots, topCourses: TOP, courseIdByOsmRef: COURSES, now: NOW, existingKeys, takenSlugs: new Set() });
const GROVE_URL = "https://www.32auctions.com/organizations/71786/auctions/206177/auction_items/7139828";

describe("buildLotPlan", () => {
  it("maps a lot to its course through the top-course list and stores money in cents", () => {
    const { rows, skipped } = plan([lot()]);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.course_id).toBe("crs_grove");
    expect(r.price_kind).toBe("sold");
    expect(r.price_cents).toBe(1_400_000);
    expect(r.status).toBe("sold");
    expect(r.closes_at).toBe("2026-09-28");
    expect(r.includes).toBe('["lunch","caddies"]');
    expect(r.slug).toBe("2026/foursome-with-lunch-drinks-and-caddies-the-grove-xxiii");
    expect(r.id).toMatch(/^lot_[0-9A-Z]{26}$/);
    // Every lot waits for the owner's review before it shows (plan: review gate).
    expect([r.published, r.hold_reason]).toEqual([0, "needs_review"]);
  });

  it("matches a club name without the course suffix, and the state", () => {
    expect(plan([lot({ club: "Winged Foot Golf Club", state: "NY" })]).rows[0]?.course_id).toBe("crs_wf");
    expect(plan([lot({ club: "Winged Foot Golf Club", state: "CT" })]).skipped[0]?.reason).toMatch(/no course/);
  });

  it("skips a club with no courses row, an unknown club and a lot already stored", () => {
    const { rows, skipped } = plan(
      [
        lot({ club: "Pine Valley Golf Club", state: "NJ", url: "https://example.org/pv" }),
        lot({ club: "Nowhere Club", url: "https://example.org/nowhere" }),
        lot(),
      ],
      [lotKey(GROVE_URL, "crs_grove", "Foursome with lunch, drinks and caddies")],
    );
    expect(rows).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["no course row for Pine Valley Golf Club, NJ", "no course for Nowhere Club, FL", "already stored"]);
  });

  it("an open lot whose close date has passed is closed; no date keeps the reported status", () => {
    expect(plan([lot({ status: "open", price_kind: "current_bid", close_date: "2026-11-01" })]).rows[0]?.status).toBe("closed");
    expect(plan([lot({ status: "open", price_kind: "current_bid", close_date: "2026-12-05" })]).rows[0]?.status).toBe("open");
    expect(plan([lot({ status: "unknown", price_kind: null, price_usd: null, close_date: null })]).rows[0]).toMatchObject({
      status: "unknown",
      closes_at: null,
      price_cents: null,
    });
  });

  it("drops a repeated lot within one load, keeps catalog-sharing lots apart and slugs unique", () => {
    const a = lot();
    const b = lot({ url: "https://www.32auctions.com/organizations/71786/auctions/206177/auction_items/1" });
    const { rows, skipped } = plan([a, a, b]);
    expect(rows.map((r) => r.slug)).toEqual([
      "2026/foursome-with-lunch-drinks-and-caddies-the-grove-xxiii",
      "2026/foursome-with-lunch-drinks-and-caddies-the-grove-xxiii-2",
    ]);
    expect(skipped.map((s) => s.reason)).toEqual(["repeated in this load"]);
    // Two lots in one catalog with no page each: same link, different titles.
    const catalog = "https://e.givesmart.com/events/Nkt/i/_All/";
    const two = plan([lot({ url: catalog }), lot({ url: catalog, title: "Golf and lunch for 3" })]);
    expect(two.rows).toHaveLength(2);
  });

  it("refuses non-http links and over-long titles at parse time", () => {
    expect(() => lot({ url: "javascript:alert(1)" })).toThrow();
    expect(() => lot({ title: "x".repeat(200) })).toThrow();
  });
});
