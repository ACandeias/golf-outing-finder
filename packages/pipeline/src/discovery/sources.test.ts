import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetGuard } from "../budget.ts";
import { createPageFetcher, userAgentFor } from "../fetch/fetcher.ts";
import { fixtureFetch, fixtureResolver, loadFixtureDocs } from "../fetch/fixture-fetch.ts";
import { pdfText } from "../fetch/pdf.ts";
import { PATHS, REPO_ROOT } from "../lib/paths.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { extractLinks, parseSitemap } from "./links.ts";
import {
  createListingSource,
  expandUrls,
  loadPlatforms,
  parsePlatformsYaml,
  sourceDueTonight,
  type ListingConfig,
} from "./sources.ts";

const fx = (f: string) => readFileSync(join(REPO_ROOT, "tests/fixtures/discovery", f), "utf8");
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-09-28T07:15:00Z");

describe("extractLinks", () => {
  it("resolves against <base>, normalizes, dedupes and keeps anchor text", () => {
    const links = extractLinks(fx("series-index.html"), "https://www.series.example/golf/events");
    expect(links.map((l) => l.url)).toContain(
      "https://www.series.example/golf/events/phoenix-golf-classic-2026",
    );
    expect(links.find((l) => l.url.endsWith("denver-golf-classic-2026"))?.text).toBe("Denver Golf Classic");
    expect(links.some((l) => l.url.startsWith("mailto:"))).toBe(false);
  });

  it("fills empty anchor text from a later duplicate", () => {
    const links = extractLinks('<a href="/e"></a><a href="/e">Golf Classic</a>', "https://x.example/");
    expect(links).toEqual([{ url: "https://x.example/e", text: "Golf Classic" }]);
  });
});

describe("parseSitemap", () => {
  it("reads a sitemap index and a urlset, decoding entities", () => {
    expect(parseSitemap(fx("sitemap-index.xml"))).toEqual({
      urls: [],
      sitemaps: ["https://platform.example/sitemap-events-1.xml"],
    });
    const sm = parseSitemap(fx("sitemap-events-1.xml"));
    expect(sm.urls).toContain("https://platform.example/events/youth-golf-scramble?id=7");
    expect(sm.urls).toHaveLength(4);
  });
});

describe("platforms.yaml", () => {
  it("parses the committed file, with every platform and directory off until the owner checks its terms", async () => {
    const cfg = await loadPlatforms(PATHS.overrides);
    expect(cfg.platforms.map((p) => p.name)).toEqual([
      "golfstatus",
      "tourneylinks",
      "golfgenius",
      "birdease",
      "givesmart",
      "onecause",
      "gofundme-pro",
      "networkforgood",
      "eventbrite",
    ]);
    expect(cfg.platforms.every((p) => !p.allowed)).toBe(true);
    expect(cfg.directories.every((p) => !p.allowed)).toBe(true);
    expect(cfg.associations.map((a) => a.name)).toEqual([
      "Arizona Golf Association",
      "Southern California Golf Association",
      "Colorado Golf Association",
    ]);
  });

  it("defaults allowed to false and rejects a link adapter without a pattern", () => {
    const cfg = parsePlatformsYaml("platforms:\n  - name: x\n    adapter: page\n    urls: [https://x.example/]\n");
    expect(cfg.platforms[0]?.allowed).toBe(false);
    expect(() => parsePlatformsYaml("platforms:\n  - name: x\n    adapter: links\n")).toThrow(/event_url_pattern/);
    expect(() => parsePlatformsYaml("bogus: []\n")).toThrow(/platforms.yaml/);
  });
});

describe("scheduling", () => {
  it("runs a weekly source on exactly one night a week", () => {
    const nights = Array.from({ length: 14 }, (_, d) =>
      sourceDueTonight({ name: "Colorado Golf Association", cadence: "weekly" }, new Date(NOW.getTime() + d * 86_400_000)),
    );
    expect(nights.filter(Boolean)).toHaveLength(2);
    expect(sourceDueTonight({ name: "x", cadence: "daily" }, NOW)).toBe(true);
  });

  it("expands {yyyy-mm} across months", () => {
    expect(expandUrls(["https://a.example/cal/{yyyy-mm}", "https://b.example/"], 3, new Date("2026-11-15T00:00:00Z"))).toEqual([
      "https://a.example/cal/2026-11",
      "https://a.example/cal/2026-12",
      "https://a.example/cal/2027-01",
      "https://b.example/",
    ]);
  });
});

describe("createListingSource", () => {
  function source(config: ListingConfig, series = emptyOverrides().series) {
    const { fetchFn, requested } = fixtureFetch(loadFixtureDocs());
    const fetcher = createPageFetcher({
      fetchFn,
      guard: { resolver: fixtureResolver, exclusions: emptyOverrides().exclusions },
      userAgent: userAgentFor("http://localhost:8787"),
      clock: { nowMs: () => 0 },
      nowIso: () => NOW.toISOString(),
      pdfText,
      hostSpacingMs: 0,
      sleep: async () => {},
    });
    const src = createListingSource({
      fetcher,
      config,
      series,
      registrationHosts: ["golfstatus.com"],
      now: NOW,
      log,
    });
    return { src, requested };
  }
  const guard = () => new BudgetGuard({ profile: "nightly", now: NOW, clock: { nowMs: () => 0 } });
  const daily = { allowed: true, cadence: "daily" as const, months_ahead: 1 };

  it("reads series index pages and keeps on-site and registration-host event links", async () => {
    const { src } = source({ platforms: [], associations: [], directories: [] }, [
      { id: "golf-classic", name: "Golf Classic", index_url: "https://www.series.example/golf/events" },
    ]);
    const links = await src.links(guard());
    expect(links.map((l) => l.url)).toEqual([
      "https://www.series.example/golf/events/phoenix-golf-classic-2026",
      "https://www.series.example/golf/events/denver-golf-classic-2026",
      "https://support.series.example/event/2026-golf-classic-boston/e9001",
      "https://www.golfstatus.com/tournaments/series-austin-2026",
    ]);
    expect(links.every((l) => l.found_via === "series" && l.origin === "golf-classic")).toBe(true);
  });

  it("follows a sitemap index for an allowed platform and filters by the event pattern", async () => {
    const { src } = source({
      platforms: [
        {
          ...daily,
          name: "platform",
          adapter: "sitemap",
          urls: ["https://platform.example/sitemap.xml"],
          event_url_pattern: "^https://platform\\.example/events/",
        },
      ],
      associations: [],
      directories: [],
    });
    const links = await src.links(guard());
    expect(links.map((l) => l.url)).toEqual([
      "https://platform.example/events/rotary-charity-golf-classic-2026",
      "https://platform.example/events/spring-gala-dinner-2026",
      "https://platform.example/events/youth-golf-scramble?id=7",
    ]);
    expect(links[0]?.found_via).toBe("platform");
  });

  it("queues association calendar pages themselves without fetching them", async () => {
    const { src, requested } = source({
      platforms: [],
      associations: [{ ...daily, name: "AGA", adapter: "page", urls: ["https://azgolf.org/charity-club-sanctioned-events"] }],
      directories: [],
    });
    expect((await src.links(guard())).map((l) => [l.url, l.found_via])).toEqual([
      ["https://azgolf.org/charity-club-sanctioned-events", "association"],
    ]);
    expect(requested).toEqual([]);
  });

  it("lists directory event pages, never the index, and skips sources not allowed", async () => {
    const { src, requested } = source({
      platforms: [
        { ...daily, allowed: false, name: "off", adapter: "links", urls: ["https://off.example/"], event_url_pattern: "." },
      ],
      associations: [],
      directories: [
        {
          ...daily,
          name: "Scramble Hunter",
          adapter: "links",
          urls: ["https://scramblehunter.com/"],
          event_url_pattern: "^https://(www\\.)?scramblehunter\\.com/event/[^/]+/?$",
        },
      ],
    });
    const links = await src.links(guard());
    expect(links.map((l) => [l.url, l.title])).toEqual([
      ["https://scramblehunter.com/event/grady-charity-golf-scramble-2026/", "Grady Charity Golf Scramble 2026"],
      [
        "https://scramblehunter.com/event/12th-annual-memorial-charity-golf-tournament/",
        "12th Annual Memorial Charity Golf Tournament",
      ],
    ]);
    expect(requested.some((u) => u.includes("off.example"))).toBe(false);
  });

  it("counts listing fetches against MAX_FETCHES_PER_RUN and stops when it runs out", async () => {
    const { src } = source({
      platforms: [
        {
          ...daily,
          name: "platform",
          adapter: "sitemap",
          urls: ["https://platform.example/sitemap.xml"],
          event_url_pattern: "^https://platform\\.example/events/",
        },
      ],
      associations: [],
      directories: [],
    });
    const g = new BudgetGuard({ profile: "nightly", env: { MAX_FETCHES_PER_RUN: "1" }, now: NOW, clock: { nowMs: () => 0 } });
    expect(await src.links(g)).toEqual([]);
    expect(g.spent("MAX_FETCHES_PER_RUN")).toBe(1);
  });
});
