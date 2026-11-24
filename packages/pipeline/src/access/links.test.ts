import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { PLATFORMS_FILE, parsePlatformsYaml } from "../discovery/sources.ts";
import { platformRulesFrom } from "../discovery/platform-policy.ts";
import { PATHS } from "../lib/paths.ts";
import { curatedLinkProblems, homePageOnlyCheck } from "./links.ts";
import { accessItemSchema, itemsFromFile, type AccessItem } from "./load.ts";

function item(over: Partial<AccessItem> = {}): AccessItem {
  return accessItemSchema.parse({
    course_name: "Fox Chapel Golf Club",
    course_state: "PA",
    kind: "auction",
    title: "Round for 3 with a member",
    organizer: "First Tee Greater Detroit",
    event_name: null,
    platform: "memberforaday.com",
    link: "https://memberforaday.com/npo/first-tee-greater-detroit",
    date_start: null,
    date_end: "2026-11-24",
    season: null,
    recurring: false,
    price_kind: "current_bid",
    price_min_usd: 2200,
    price_max_usd: null,
    players: 3,
    member_hosted: true,
    status: "open",
    confirmed: "fetched",
    note: null,
    checked_on: "2026-11-23",
    ...over,
  });
}

describe("curatedLinkProblems", () => {
  it("accepts a dated, checked link", () => {
    expect(curatedLinkProblems([item()])).toEqual([]);
  });

  it("wants the day each link was checked", () => {
    expect(curatedLinkProblems([item({ checked_on: null })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: no checked_on date",
    ]);
  });

  it("wants a closing date on an open or upcoming auction lot, so the lot can leave the timeline by itself", () => {
    expect(curatedLinkProblems([item({ date_end: null })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: an open auction lot needs date_end (its closing day)",
    ]);
    expect(curatedLinkProblems([item({ date_end: null, status: "upcoming" })])).toHaveLength(1);
    // A closed or recurring lot, or a standing offer, can go without one.
    expect(curatedLinkProblems([item({ date_end: null, status: "closed" })])).toEqual([]);
    expect(curatedLinkProblems([item({ date_end: null, kind: "member_for_a_day" })])).toEqual([]);
  });

  it("refuses a deep link to a site whose terms allow links to its home page only", () => {
    const homeOnly = (link: string) => (new URL(link).hostname.endsWith("ajga.org") && new URL(link).pathname !== "/" ? "AJGA" : null);
    expect(curatedLinkProblems([item({ link: "https://www.ajga.org/foundation/auction", platform: "ajga.org" })], homeOnly)).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: AJGA allows links to its home page only",
    ]);
    expect(curatedLinkProblems([item({ link: "https://www.ajga.org/", platform: "ajga.org" })], homeOnly)).toEqual([]);
  });

  it("refuses the same item twice, comparing links the way the loader stores them", () => {
    expect(curatedLinkProblems([item(), item({ price_min_usd: 2500 })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: listed twice",
    ]);
    // A fragment or a tracking parameter doesn't make it a different link.
    expect(curatedLinkProblems([item(), item({ link: "https://memberforaday.com/npo/first-tee-greater-detroit?utm_source=mail#fox-chapel" })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: listed twice",
    ]);
    // The same charity page with a different club is a different lot.
    expect(curatedLinkProblems([item(), item({ course_name: "Kingsley Club", course_state: "MI" })])).toEqual([]);
  });

  it("wants the platform to be the site the link opens", () => {
    expect(curatedLinkProblems([item({ link: "https://www.32auctions.com/organizations/1/auctions/2" })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: the link opens 32auctions.com, not memberforaday.com",
    ]);
    // A subdomain of the platform is the platform.
    expect(curatedLinkProblems([item({ link: "https://ncga.winningbidder.com/event/4886", platform: "winningbidder.com" })])).toEqual([]);
  });
});

describe("homePageOnlyCheck with the committed platforms.yaml", () => {
  const rules = platformRulesFrom(parsePlatformsYaml(readFileSync(join(PATHS.overrides, PLATFORMS_FILE), "utf8")));
  const check = homePageOnlyCheck(rules);

  it("names the platform for a deep link where the terms ban them", () => {
    expect(check("https://pledgeit.org/some-auction/lots/12")).toBe("PledgeIt");
    expect(check("https://www.biddingowl.com/Auction/item-detail.cfm?id=1")).toBe("BiddingOwl");
    expect(check("https://app.givergy.us/auction/1")).toBe("Givergy (momoGood)");
    expect(check("https://momogood.com/a/b")).toBe("Givergy (momoGood)");
    expect(check("https://www.ajga.org/foundation/auction")).toBe("AJGA");
    expect(check("https://www.priceless.com/golf/product/123")).toBe("Mastercard Priceless");
  });

  it("treats an event or charity subdomain's root as a deep link: it is that event's page, not the site's home page", () => {
    expect(check("https://charity.pledgeit.org/")).toBe("PledgeIt");
    expect(check("https://gala2026.givergy.us/")).toBe("Givergy (momoGood)");
    expect(check("https://new.biddingowl.com")).toBe("BiddingOwl");
  });

  it("lets the home page through, and every page of a site with no such ban", () => {
    expect(check("https://pledgeit.org/")).toBeNull();
    expect(check("https://pledgeit.org")).toBeNull();
    expect(check("https://www.pledgeit.org/")).toBeNull();
    expect(check("https://WWW.PledgeIt.org/")).toBeNull();
    expect(check("https://pledgeit.org/?utm_source=mail")).toBe("PledgeIt");
    expect(check("https://memberforaday.com/npo/first-tee-greater-detroit")).toBeNull();
    expect(check("https://www.32auctions.com/organizations/1/auctions/2")).toBeNull();
    expect(check("not a url")).toBeNull();
  });
});

describe("data/access-links.json", () => {
  const json: unknown = JSON.parse(readFileSync(PATHS.accessLinks, "utf8"));
  const raw = (json as { opportunities: unknown[] }).opportunities;
  const items = itemsFromFile(json);

  it("has no entry the loader would drop", () => {
    expect(items).toHaveLength(raw.length);
    expect(items.length).toBeGreaterThan(0);
  });

  it("passes the curated-link rules, with the link bans in platforms.yaml", () => {
    const rules = platformRulesFrom(parsePlatformsYaml(readFileSync(join(PATHS.overrides, PLATFORMS_FILE), "utf8")));
    expect(curatedLinkProblems(items, homePageOnlyCheck(rules))).toEqual([]);
  });

  it("uses the site's own words: no title longer than 120 characters", () => {
    for (const it of items) expect(it.title.length).toBeLessThanOrEqual(120);
  });
});
