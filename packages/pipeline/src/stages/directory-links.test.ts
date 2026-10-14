import { resolveBudget } from "@gof/shared/budget";
import { describe, expect, it } from "vitest";
import type { PlatformRule } from "../discovery/platform-policy.ts";
import { emptyOverrides, type Overrides } from "../overrides/load.ts";
import { directoryLinks, MAX_LINKS_PER_DIRECTORY_PAGE } from "./directory-links.ts";
import { PRIORITY } from "./discover.ts";
import type { Context, FetchedPage } from "./types.ts";

/**
 * SPEC.md 8.2 item 6: "Enqueue each listing's event page and the organizer and
 * registration links found on it." A fetched directory event page hands its
 * off-directory organizer and registration links to discovery_queue, through
 * the same gates as any other URL.
 */

const EVENT =
  "https://www.playprivategolf.com/events/2026-missoula-young-life-fall-golf-tournament-the-ranch-club-10e0f29b-f60a-47f7-8ee8-16ce0cdbdfba";

// Hand-written in the shape of a Play Private Golf event page (made-up text).
const HTML = `<!doctype html><html><body>
<nav><a href="/">Home</a><a href="/states/mt">Montana</a><a href="/submit">Submit</a><a href="/about">About</a></nav>
<main>
  <h1>Fall Golf Tournament</h1>
  <a href="https://missoula.younglife.org/events/" rel="nofollow">Official event page</a>
  <a href="https://mt23.younglife.team/missoula-young-life-golf-tournament-2026?utm_source=ppg">Official golfer registration</a>
  <a href="https://ranchclub.com/Contact/FAQ">The Ranch Club private-course verification</a>
  <a href="https://mt23.younglife.team/missoula-young-life-golf-tournament-2026">View the organizer's event page</a>
  <a href="https://www.golfgenius.com/pages/12345-young-life-fall">Register on Golf Genius</a>
  <a href="https://www.facebook.com/younglifemissoula">Facebook</a>
  <a href="https://banned.example/golf-tournament">Golf tournament flyer</a>
  <a href="https://removed.example/golf-outing">Golf outing (removed)</a>
  <a href="mailto:organizer@example.org">Email the organizer</a>
  <a href="${EVENT}">This page</a>
</main>
<footer><a href="https://x.com/privategolf_"></a><a href="/terms">Terms</a></footer>
</body></html>`;

const rules: PlatformRule[] = [
  {
    name: "Play Private Golf",
    allowed: true,
    domains: ["playprivategolf.com"],
    listing_url_pattern: null,
    directory: true,
    event_url_pattern: "^https://(www\\.)?playprivategolf\\.com/events/[a-z0-9-]+-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/?$",
  },
  {
    name: "Scramble Hunter",
    allowed: false,
    domains: ["scramblehunter.com"],
    listing_url_pattern: null,
    directory: true,
    event_url_pattern: "^https://(www\\.)?scramblehunter\\.com/event/[^/]+/?$",
  },
  { name: "golfgenius", allowed: false, domains: ["golfgenius.com"], listing_url_pattern: null },
];

function ctx(overrides: Partial<Overrides> = {}): Context {
  return {
    now: new Date("2026-10-16T07:30:00Z"),
    caps: resolveBudget("nightly"),
    overrides: emptyOverrides({
      exclusions: { domains: ["banned.example", "facebook.com"], url_patterns: [] },
      removals: { outing_ids: [], urls: ["https://removed.example/golf-outing"] },
      ...overrides,
    }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { nowMs: () => 0 },
  };
}

function page(patch: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requested_url: EVENT,
    url: EVENT,
    kind: "directory",
    found_via: "directory",
    fetched_at: "2026-10-16T07:31:00.000Z",
    http_status: 200,
    outcome: "ok",
    content_type: "text/html",
    html: HTML,
    pdf_text: null,
    rendered: false,
    error: null,
    recheck_outing_id: null,
    directory_host: "www.playprivategolf.com",
    ...patch,
  };
}

describe("directoryLinks", () => {
  it("queues a directory event page's off-directory organizer and registration links, as organizer pages", () => {
    const out = directoryLinks(ctx(), { pages: [page()], platform_rules: rules });
    expect(out.queue).toEqual([
      {
        url: "https://missoula.younglife.org/events/",
        found_via: "directory",
        kind: "organizer",
        priority: PRIORITY.directory,
        bypass_dedupe: false,
        recheck_outing_id: null,
        directory_host: null,
      },
      {
        // Normalized (tracking parameter dropped) and queued once.
        url: "https://mt23.younglife.team/missoula-young-life-golf-tournament-2026",
        found_via: "directory",
        kind: "organizer",
        priority: PRIORITY.directory,
        bypass_dedupe: false,
        recheck_outing_id: null,
        directory_host: null,
      },
    ]);
  });

  it("applies the normal gates: platforms.yaml, exclusions, removals, the directory's own pages and navigation", () => {
    const out = directoryLinks(ctx(), { pages: [page()], platform_rules: rules });
    expect(Object.fromEntries(out.skipped.map((s) => [s.url, s.reason]))).toEqual({
      "https://www.golfgenius.com/pages/12345-young-life-fall": "platform_not_allowed",
      "https://banned.example/golf-tournament": "excluded",
      "https://removed.example/golf-outing": "removed",
    });
    const queued = out.queue.map((q) => q.url);
    for (const never of [
      "https://ranchclub.com/Contact/FAQ", // a course contact page, not the organizer's
      "https://www.facebook.com/younglifemissoula",
      "https://x.com/privategolf_",
      "https://www.playprivategolf.com/states/mt",
      EVENT,
    ]) {
      expect(queued, never).not.toContain(never);
    }
  });

  it("skips links already fetched this run or already waiting in discovery_queue", () => {
    const out = directoryLinks(ctx(), {
      pages: [page(), page({ requested_url: "https://missoula.younglife.org/events/", url: "https://missoula.younglife.org/events/", kind: "organizer", directory_host: null, html: "<p>golf</p>" })],
      platform_rules: rules,
      known: ["https://mt23.younglife.team/missoula-young-life-golf-tournament-2026"],
    });
    expect(out.queue).toEqual([]);
  });

  it("reads only directory event pages that loaded, on a directory that is allowed", () => {
    const scramble = "https://scramblehunter.com/event/grady-charity-golf-scramble-2026/";
    for (const p of [
      page({ kind: "organizer", directory_host: null }),
      page({ outcome: "not_found", http_status: 404, html: null }),
      page({ requested_url: scramble, url: scramble, directory_host: "scramblehunter.com" }),
      page({ requested_url: "https://www.playprivategolf.com/states/mt", url: "https://www.playprivategolf.com/states/mt" }),
    ]) {
      expect(directoryLinks(ctx(), { pages: [p], platform_rules: rules }).queue, p.url).toEqual([]);
    }
  });

  it("takes at most a handful of links from one page", () => {
    const many = Array.from({ length: 12 }, (_, i) => `<a href="https://org${i}.example/golf-tournament">Golf tournament ${i}</a>`).join("");
    const out = directoryLinks(ctx(), { pages: [page({ html: `<main>${many}</main>` })], platform_rules: rules });
    expect(out.queue).toHaveLength(MAX_LINKS_PER_DIRECTORY_PAGE);
  });
});
