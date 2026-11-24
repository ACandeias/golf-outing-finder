import { describe, expect, it } from "vitest";
import { accessView, ACCESS_KIND_LABELS } from "./access-view.ts";

const base = {
  kind: "auction" as const,
  status: "closed" as const,
  priceKind: "sold",
  priceMinCents: 1_400_000,
  priceMaxCents: null,
  dateStart: null,
  dateEnd: "2026-09-28",
  season: null,
  recurring: false,
  players: 4,
  memberHosted: null,
  organizerName: "First Tee Greater Washington DC",
  eventName: "First Tee DC 2026 auction",
  platform: "32auctions.com",
  confirmed: "fetched" as const,
  lastVerified: "2026-11-21T12:00:00.000Z",
};

describe("accessView", () => {
  it("a sold auction lot", () => {
    expect(accessView(base)).toEqual({
      kindLabel: "Auction lot",
      statusLabel: "Closed",
      price: "Sold for $14,000",
      when: "Bidding closed Sep 28, 2026",
      who: "First Tee DC 2026 auction, First Tee Greater Washington DC",
      party: "4 players",
      source: "On 32auctions.com. Checked Nov 21, 2026",
    });
  });

  it("an open lot, a range, a recurring program and a snippet-only find", () => {
    expect(accessView({ ...base, status: "open", priceKind: "current_bid", dateEnd: "2026-12-05" })).toMatchObject({
      statusLabel: "Open",
      price: "Current bid $14,000",
      when: "Bidding closes Dec 5, 2026",
    });
    expect(accessView({ ...base, kind: "outing", status: "upcoming", priceKind: "entry_fee", priceMinCents: 50000, priceMaxCents: 200000, dateEnd: null, dateStart: "2027-05-10" })).toMatchObject({
      kindLabel: "Charity outing",
      price: "$500 to $2,000",
      when: "May 10, 2027",
    });
    expect(
      accessView({ ...base, kind: "member_for_a_day", status: "recurring", recurring: true, priceKind: null, priceMinCents: null, dateEnd: null, season: "annual, spring", memberHosted: true, confirmed: "snippet" }),
    ).toMatchObject({
      kindLabel: "Member for a day",
      statusLabel: "Recurring",
      price: "See site",
      when: "Annual, spring",
      party: "4 players with a member",
      source: "On 32auctions.com. Seen in search results Nov 21, 2026",
    });
  });

  it("has a label for every kind", () => {
    expect(Object.keys(ACCESS_KIND_LABELS)).toHaveLength(11);
  });

  it("a bid seen while a lot was open is not shown as its final price once the lot is over", () => {
    const lot = { ...base, priceKind: "current_bid", priceMinCents: 250_000, dateEnd: "2026-11-24" };
    expect(accessView({ ...lot, status: "open" }).price).toBe("Current bid $2,500");
    expect(accessView({ ...lot, status: "closed" }).price).toBe("Last bid seen $2,500");
    expect(accessView({ ...lot, status: "recurring" }).price).toBe("Last bid seen $2,500");
    expect(accessView({ ...lot, status: "closed", priceKind: "starting_bid" }).price).toBe("Bidding started at $2,500");
    expect(accessView({ ...lot, status: "upcoming", priceKind: "starting_bid" }).price).toBe("Starting bid $2,500");
    expect(accessView({ ...lot, status: "closed", priceKind: "buy_now" }).price).toBe("Buy now was $2,500");
    expect(accessView({ ...lot, status: "closed", priceKind: "sold" }).price).toBe("Sold for $2,500");
  });
});
