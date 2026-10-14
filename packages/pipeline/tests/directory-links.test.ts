import { describe, expect, it } from "vitest";
import { z } from "zod";
import { main } from "../src/cli.ts";
import { MemoryD1 } from "../src/d1/memory.ts";
import type { FetchSidePorts } from "../src/fetch/ports.ts";

/**
 * SPEC.md 8.2 item 6 on the wired dry run: on Play Private Golf's weekly night
 * the recorded sitemap queues its event pages; the first one is served here as
 * a page with the organizer's links. Those links land in discovery_queue, and
 * the next night they are fetched as organizer pages.
 */

const EVENT =
  "https://www.playprivategolf.com/events/2026-missoula-young-life-fall-golf-tournament-the-ranch-club-10e0f29b-f60a-47f7-8ee8-16ce0cdbdfba";
const ORGANIZER = "https://missoula.younglife.org/events/";
const REGISTRATION = "https://mt23.younglife.team/missoula-young-life-golf-tournament-2026";
const HTML = `<!doctype html><html><body><main><h1>Fall Golf Tournament</h1>
<a href="${ORGANIZER}">Official event page</a>
<a href="${REGISTRATION}">Official golfer registration</a>
<a href="https://www.golfgenius.com/pages/1-young-life">Register on Golf Genius</a>
<a href="/states/mt">Montana</a></main></body></html>`;

function servePpgEvent(ports: FetchSidePorts): FetchSidePorts {
  return {
    ...ports,
    fetcher: {
      ...ports.fetcher,
      fetchPage: async (item, budget) => {
        const page = await ports.fetcher.fetchPage(item, budget);
        if (item.url !== EVENT) return page;
        return { ...page, outcome: "ok", http_status: 200, content_type: "text/html", html: HTML, error: null };
      },
    },
  };
}

async function run(now: string, d1: MemoryD1) {
  const r = await main(["--dry-run", "--strict"], {
    env: { NODE_ENV: "test", PIPELINE_NOW: now },
    d1,
    stdout: () => {},
    stderr: () => {},
    edges: { decorateFetchSide: servePpgEvent },
  });
  expect(r.exitCode).toBe(0);
  expect(r.networkAttempts).toEqual([]);
  return r;
}

describe("organizer and registration links on a directory event page", () => {
  it("are queued from the fetched page and fetched as organizer pages the next night", async () => {
    const d1 = new MemoryD1();
    await run("2026-10-16", d1);
    const queued = z
      .array(z.object({ url: z.string(), found_via: z.string(), attempts: z.number() }))
      .parse(d1.db.prepare("SELECT url, found_via, attempts FROM discovery_queue ORDER BY url").all());
    expect(queued.filter((q) => q.url === ORGANIZER || q.url === REGISTRATION)).toEqual([
      { url: ORGANIZER, found_via: "directory", attempts: 0 },
      { url: REGISTRATION, found_via: "directory", attempts: 0 },
    ]);
    // A disallowed platform and the directory's own pages are never queued.
    expect(queued.some((q) => q.url.includes("golfgenius.com") || q.url.endsWith("/states/mt"))).toBe(false);

    await run("2026-10-17", d1);
    const sources = z
      .array(z.object({ url: z.string(), kind: z.string() }))
      .parse(d1.db.prepare("SELECT url, kind FROM sources WHERE fetched_at IS NOT NULL").all());
    expect(sources.filter((s) => s.url === ORGANIZER || s.url === REGISTRATION).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: ORGANIZER, kind: "organizer" },
      { url: REGISTRATION, kind: "organizer" },
    ]);
    expect(sources.find((s) => s.url === EVENT)?.kind).toBe("directory");
  }, 120_000);
});
