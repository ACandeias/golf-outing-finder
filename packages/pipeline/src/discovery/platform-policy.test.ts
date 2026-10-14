import { describe, expect, it } from "vitest";
import { PATHS } from "../lib/paths.ts";
import { loadPlatforms, parsePlatformsYaml } from "./sources.ts";
import { blockedAsSource, platformRulesFrom, platformVerdict } from "./platform-policy.ts";

const YAML = `
platforms:
  - name: eventbrite
    allowed: false
    adapter: links
    urls: [https://www.eventbrite.com/d/united-states/golf-tournament/]
    domains: ["eventbrite.*"]
    listing_url_pattern: "^/(d|b|o|cc)/"
    event_url_pattern: "^https://(www\\\\.)?eventbrite\\\\.com/e/"
  - name: networkforgood
    allowed: false
    adapter: sitemap
    urls: [https://www.networkforgood.com/sitemap.xml]
    listing_url_pattern: "^/events/?$"
    event_url_pattern: "^https://[a-z0-9-]+\\\\.networkforgood\\\\.com/events/"
  - name: golfgenius
    allowed: true
    adapter: sitemap
    urls: [https://www.golfgenius.com/sitemap.xml]
    listing_url_pattern: "^/(pages)?/?$"
    event_url_pattern: "^https://(www\\\\.)?golfgenius\\\\.com/pages/"
associations: []
directories:
  - name: Scramble Hunter
    allowed: false
    adapter: links
    urls: [https://scramblehunter.com/]
    event_url_pattern: "^https://(www\\\\.)?scramblehunter\\\\.com/event/[^/]+/?$"
  - name: Play Private Golf
    allowed: true
    adapter: sitemap
    urls: [https://www.playprivategolf.com/sitemap.xml]
    event_url_pattern: "^https://(www\\\\.)?playprivategolf\\\\.com/events/[a-z0-9-]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/?$"
`;

const PPG_EVENT =
  "https://www.playprivategolf.com/events/2026-missoula-young-life-fall-golf-tournament-the-ranch-club-10e0f29b-f60a-47f7-8ee8-16ce0cdbdfba";

const rules = platformRulesFrom(parsePlatformsYaml(YAML));

describe("platform policy (platforms.yaml applied to any URL)", () => {
  it("blocks every domain of a platform or directory with allowed: false, any country code", () => {
    // The listing pages the first local nightly fetched from search results.
    expect(platformVerdict("https://www.eventbrite.ca/d/ct--darien/golf-tournament/", rules)).toEqual({
      platform: "eventbrite",
      allowed: false,
      listing: true,
      directory: false,
    });
    expect(platformVerdict("https://www.eventbrite.com.au/d/nj--northfield/pine-beach-golf-outing/", rules)).toMatchObject({
      platform: "eventbrite",
      allowed: false,
    });
    expect(platformVerdict("https://www.eventbrite.com/e/9th-annual-1-club-golf-outing-tickets-1999044102724", rules)).toEqual({
      platform: "eventbrite",
      allowed: false,
      listing: false,
      directory: false,
    });
    expect(platformVerdict("https://stgeorgetheatre.networkforgood.com/events/102872-laughs", rules)).toMatchObject({
      platform: "networkforgood",
      allowed: false,
      listing: false,
    });
    expect(platformVerdict("https://bgcnr.networkforgood.com/events", rules)).toMatchObject({ listing: true });
    expect(platformVerdict("https://scramblehunter.com/event/x/", rules)).toMatchObject({
      platform: "Scramble Hunter",
      allowed: false,
    });
  });

  it("an allowed platform's event page passes; its listing page is still a listing", () => {
    expect(platformVerdict("https://www.golfgenius.com/pages/123-charity-classic", rules)).toEqual({
      platform: "golfgenius",
      allowed: true,
      listing: false,
      directory: false,
    });
    expect(platformVerdict("https://www.golfgenius.com/", rules)).toMatchObject({ allowed: true, listing: true });
  });

  it("on a directory, an event page is a directory page and every other page is an index (listing)", () => {
    expect(platformVerdict(PPG_EVENT, rules)).toEqual({
      platform: "Play Private Golf",
      allowed: true,
      listing: false,
      directory: true,
    });
    expect(blockedAsSource(PPG_EVENT, rules)).toBeNull();
    for (const index of [
      "https://www.playprivategolf.com/",
      "https://playprivategolf.com/states/arizona",
      "https://www.playprivategolf.com/courses/cobblestone-creek-country-club",
      "https://www.playprivategolf.com/events",
      "https://www.playprivategolf.com/guides/golf-tournament-formats-explained",
    ]) {
      expect(platformVerdict(index, rules), index).toMatchObject({ allowed: true, listing: true, directory: true });
      expect(blockedAsSource(index, rules), index).not.toBeNull();
    }
    // A disallowed directory's event page is blocked whatever its shape.
    expect(platformVerdict("https://scramblehunter.com/event/x/", rules)).toMatchObject({
      listing: false,
      directory: true,
      allowed: false,
    });
  });

  it("other sites are not platforms (a brand only matches as the registrable domain's own label)", () => {
    expect(platformVerdict("https://www.fordham.edu/golf", rules)).toBeNull();
    expect(platformVerdict("https://eventbriteguide.com/x", rules)).toBeNull();
    expect(platformVerdict("not a url", rules)).toBeNull();
  });
});

describe("the committed platforms.yaml", () => {
  it("blocks every page the first local nightly fetched from Eventbrite and Network for Good search results", async () => {
    const committed = platformRulesFrom(await loadPlatforms(PATHS.overrides));
    for (const url of [
      "https://www.eventbrite.ca/d/ct--darien/golf-tournament/",
      "https://www.eventbrite.com.au/d/nj--northfield/pine-beach-golf-outing/",
      "https://www.eventbrite.com/e/9th-annual-1-club-golf-outing-tickets-1999044102724",
      "https://www.eventbrite.co.uk/o/some-organizer-123",
      "https://stgeorgetheatre.networkforgood.com/events/102872-laughs",
      "https://bgcnr.networkforgood.com/events",
      "https://scramblehunter.com/event/x/",
    ]) {
      expect(blockedAsSource(url, committed), url).not.toBeNull();
    }
    expect(platformVerdict("https://www.eventbrite.ca/d/ct--darien/golf-tournament/", committed)).toMatchObject({
      listing: true,
    });
    expect(platformVerdict("https://bgcnr.networkforgood.com/events", committed)).toMatchObject({ listing: true });
    expect(platformVerdict("https://www.eventbrite.com/e/x-tickets-1", committed)).toMatchObject({ listing: false });
  });

  it("leaves organizer sites and association calendars alone", async () => {
    const committed = platformRulesFrom(await loadPlatforms(PATHS.overrides));
    expect(blockedAsSource("https://www.fordham.edu/golf", committed)).toBeNull();
    expect(blockedAsSource("https://azgolf.org/charity-club-sanctioned-events", committed)).toBeNull();
  });
});
