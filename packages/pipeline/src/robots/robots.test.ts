import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/paths.ts";
import { parseRobots, RobotsCache, robotsDecision, type RobotsFetch } from "./robots.ts";

const fx = (name: string) => readFileSync(join(REPO_ROOT, "tests/fixtures/robots", name), "utf8");

describe("parseRobots + robotsDecision", () => {
  it("uses our group over *, with longest match and allow on ties", () => {
    const r = parseRobots(fx("ours-and-star.txt"));
    expect(robotsDecision(r, "/").allowed).toBe(true);
    expect(robotsDecision(r, "/members/list").allowed).toBe(false);
    expect(robotsDecision(r, "/members/events/golf").allowed).toBe(true);
    expect(robotsDecision(r, "/flyer.pdf").allowed).toBe(false);
    expect(robotsDecision(r, "/flyer.pdf?x=1").allowed).toBe(true);
    expect(robotsDecision(r, "/").crawlDelayMs).toBe(12_000);
    expect(r.sitemaps).toEqual(["https://example.org/sitemap.xml"]);
  });

  it("falls back to * and caps crawl-delay at 30 s", () => {
    const r = parseRobots(fx("star-only.txt"));
    expect(robotsDecision(r, "/private/x").allowed).toBe(false);
    expect(robotsDecision(r, "/private/golf/2026").allowed).toBe(true);
    expect(robotsDecision(r, "/search?q=golf").allowed).toBe(false);
    expect(robotsDecision(r, "/search").allowed).toBe(true);
    expect(robotsDecision(r, "/events").allowed).toBe(true);
    expect(robotsDecision(r, "/").crawlDelayMs).toBe(30_000);
  });

  it("merges groups naming our product token, case-insensitively", () => {
    const r = parseRobots(fx("split-groups.txt"));
    expect(robotsDecision(r, "/a/1").allowed).toBe(false);
    expect(robotsDecision(r, "/b/1").allowed).toBe(false);
    expect(robotsDecision(r, "/c").allowed).toBe(true);
  });

  it("keeps a low crawl-delay as given (the fetcher's 5 s floor applies separately)", () => {
    expect(robotsDecision(parseRobots(fx("crawl-delay-low.txt")), "/").crawlDelayMs).toBe(2_000);
  });

  it("allows everything for an empty file", () => {
    expect(robotsDecision(parseRobots(""), "/anything")).toEqual({ allowed: true, crawlDelayMs: 0 });
  });

  it("matches percent-encoded and plain paths alike", () => {
    const r = parseRobots("User-agent: *\nDisallow: /caf%C3%A9\n");
    expect(robotsDecision(r, "/café").allowed).toBe(false);
  });
});

describe("RobotsCache", () => {
  function cacheWith(responses: Record<string, { status: number; body: string } | Error>) {
    const calls: string[] = [];
    let now = 0;
    const fetchRobots: RobotsFetch = async (url) => {
      calls.push(url);
      const r = responses[url];
      if (r instanceof Error) throw r;
      return r ?? { status: 404, body: "" };
    };
    const cache = new RobotsCache({ fetchRobots, clock: { nowMs: () => now } });
    return { cache, calls, advance: (ms: number) => (now += ms) };
  }

  it("fetches once per origin and caches for 24 hours", async () => {
    const { cache, calls, advance } = cacheWith({
      "https://example.org/robots.txt": { status: 200, body: fx("ours-and-star.txt") },
    });
    expect((await cache.check("https://example.org/members/x")).allowed).toBe(false);
    expect((await cache.check("https://example.org/events")).allowed).toBe(true);
    expect(calls).toHaveLength(1);
    advance(23 * 3600_000);
    await cache.check("https://example.org/");
    expect(calls).toHaveLength(1);
    advance(2 * 3600_000);
    await cache.check("https://example.org/");
    expect(calls).toHaveLength(2);
  });

  it("allows everything for 404 and 410 (RFC 9309: no robots.txt) and for other plain 4xx", async () => {
    const { cache } = cacheWith({
      "https://gone.example/robots.txt": { status: 404, body: "" },
      "https://gone2.example/robots.txt": { status: 410, body: "" },
      "https://odd.example/robots.txt": { status: 400, body: "" },
    });
    for (const host of ["gone", "gone2", "odd"]) {
      const d = await cache.check(`https://${host}.example/x`);
      expect(d, host).toEqual({ allowed: true, crawlDelayMs: 0 });
      expect(d.unavailable, host).toBeUndefined();
    }
  });

  it("disallows the host for 401, 403, 429, 5xx and network failures, and says why", async () => {
    const { cache } = cacheWith({
      "https://auth.example/robots.txt": { status: 401, body: "" },
      "https://forbidden.example/robots.txt": { status: 403, body: "<html>Forbidden</html>" },
      "https://slow.example/robots.txt": { status: 429, body: "" },
      "https://down.example/robots.txt": { status: 503, body: "" },
      "https://err.example/robots.txt": new Error("ECONNRESET"),
    });
    const reasons: Record<string, string | undefined> = {};
    for (const host of ["auth", "forbidden", "slow", "down", "err"]) {
      const d = await cache.check(`https://${host}.example/events/golf`);
      expect(d.allowed, host).toBe(false);
      reasons[host] = d.unavailable;
    }
    expect(reasons).toEqual({
      auth: "HTTP 401",
      forbidden: "HTTP 403",
      slow: "HTTP 429",
      down: "HTTP 503",
      err: "ECONNRESET",
    });
  });

  it("treats a bot-challenge page served as robots.txt as unavailable, not as an empty file", async () => {
    const { cache } = cacheWith({
      "https://cf.example/robots.txt": { status: 200, body: fx("challenge-cloudflare.html") },
      "https://plain.example/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /admin\n" },
    });
    expect(await cache.check("https://cf.example/events/golf")).toMatchObject({
      allowed: false,
      unavailable: "challenge page",
    });
    expect((await cache.check("https://plain.example/events/golf")).allowed).toBe(true);
  });

  it("keeps an unavailable robots.txt for the rest of the run instead of retrying it", async () => {
    const { cache, calls, advance } = cacheWith({
      "https://down.example/robots.txt": { status: 403, body: "" },
    });
    await cache.check("https://down.example/a");
    advance(25 * 3600_000);
    expect((await cache.check("https://down.example/b")).allowed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("reports each unavailable origin once, through onUnavailable", async () => {
    const seen: [string, string][] = [];
    const cache = new RobotsCache({
      fetchRobots: async (url) => (url.includes("down") ? { status: 429, body: "" } : { status: 404, body: "" }),
      clock: { nowMs: () => 0 },
      onUnavailable: (origin, reason) => seen.push([origin, reason]),
    });
    await cache.check("https://down.example/a");
    await cache.check("https://down.example/b");
    await cache.check("https://fine.example/a");
    expect(seen).toEqual([["https://down.example", "HTTP 429"]]);
  });

  it("keys the cache by origin (scheme, host and port)", async () => {
    const { cache, calls } = cacheWith({});
    await cache.check("https://example.org/a");
    await cache.check("http://example.org/a");
    await cache.check("https://www.example.org/a");
    expect(calls).toEqual([
      "https://example.org/robots.txt",
      "http://example.org/robots.txt",
      "https://www.example.org/robots.txt",
    ]);
  });

  it("shares one in-flight fetch between concurrent checks", async () => {
    const { cache, calls } = cacheWith({});
    await Promise.all([cache.check("https://a.example/1"), cache.check("https://a.example/2")]);
    expect(calls).toHaveLength(1);
  });
});
