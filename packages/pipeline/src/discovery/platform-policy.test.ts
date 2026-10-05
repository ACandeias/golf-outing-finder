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
`;

const rules = platformRulesFrom(parsePlatformsYaml(YAML));

describe("platform policy (platforms.yaml applied to any URL)", () => {
  it("blocks every domain of a platform or directory with allowed: false, any country code", () => {
    // The listing pages the first local nightly fetched from search results.
    expect(platformVerdict("https://www.eventbrite.ca/d/ct--darien/golf-tournament/", rules)).toEqual({
      platform: "eventbrite",
      allowed: false,
      listing: true,
    });
    expect(platformVerdict("https://www.eventbrite.com.au/d/nj--northfield/pine-beach-golf-outing/", rules)).toMatchObject({
      platform: "eventbrite",
      allowed: false,
    });
    expect(platformVerdict("https://www.eventbrite.com/e/9th-annual-1-club-golf-outing-tickets-1999044102724", rules)).toEqual({
      platform: "eventbrite",
      allowed: false,
      listing: false,
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
    });
    expect(platformVerdict("https://www.golfgenius.com/", rules)).toMatchObject({ allowed: true, listing: true });
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
