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

  it("treats 4xx as allow-all and 5xx or network failure as disallow-all", async () => {
    const { cache } = cacheWith({
      "https://gone.example/robots.txt": { status: 404, body: "" },
      "https://down.example/robots.txt": { status: 503, body: "" },
      "https://err.example/robots.txt": new Error("ECONNRESET"),
    });
    expect((await cache.check("https://gone.example/x")).allowed).toBe(true);
    expect((await cache.check("https://down.example/x")).allowed).toBe(false);
    expect((await cache.check("https://err.example/x")).allowed).toBe(false);
  });

  it("retries an unreachable robots.txt after an hour instead of a day", async () => {
    const { cache, calls, advance } = cacheWith({
      "https://down.example/robots.txt": { status: 503, body: "" },
    });
    await cache.check("https://down.example/a");
    advance(61 * 60_000);
    await cache.check("https://down.example/a");
    expect(calls).toHaveLength(2);
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
