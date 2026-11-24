import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATHS } from "../lib/paths.ts";
import { curatedLinkProblems } from "./links.ts";
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
    expect(curatedLinkProblems([item({ link: "https://www.ajga.org/foundation/auction", platform: "ajga.org" })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: ajga.org allows links to its home page only",
    ]);
    expect(curatedLinkProblems([item({ link: "https://www.ajga.org/", platform: "ajga.org" })])).toEqual([]);
  });

  it("refuses the same item twice", () => {
    expect(curatedLinkProblems([item(), item({ price_min_usd: 2500 })])).toEqual([
      "Fox Chapel Golf Club, Round for 3 with a member: listed twice",
    ]);
    // The same charity page with a different club is a different lot.
    expect(curatedLinkProblems([item(), item({ course_name: "Kingsley Club", course_state: "MI" })])).toEqual([]);
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

  it("passes the curated-link rules", () => {
    expect(curatedLinkProblems(items)).toEqual([]);
  });

  it("uses the site's own words: no title longer than 120 characters", () => {
    for (const it of items) expect(it.title.length).toBeLessThanOrEqual(120);
  });
});
