import { resolveBudget } from "@gof/shared/budget";
import { describe, expect, it } from "vitest";
import { platformRulesFrom } from "../discovery/platform-policy.ts";
import { loadPlatforms, MAX_LINKS_PER_SOURCE, sourceDueTonight } from "../discovery/sources.ts";
import { PATHS } from "../lib/paths.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { discover } from "./discover.ts";
import { planFetch, queueBookkeeping } from "./fetch-plan.ts";
import type { DiscoveryQueueRow } from "./rows.ts";
import type { Context, FetchedPage, ListingLink } from "./types.ts";

/**
 * Play Private Golf's sitemap listed 474 event pages on 2026-10-14, more than
 * MAX_FETCHES_PER_HOST_PER_RUN (150). The weekly read enqueues them all;
 * planFetch takes 150 a night for that host and defers the rest to
 * discovery_queue, which the next nights drain; the 7-day dedupe keeps the
 * next weekly read from fetching them again too soon. This walks the pure
 * stages through three weeks of nights: never more than 150 a night for the
 * host, and every page is fetched again within 14 days.
 */

const DAY = 86_400_000;
const EVENTS = 474;
const uuid = (i: number) => `${i.toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${"d".repeat(12)}`;
const eventUrl = (i: number) => `https://www.playprivategolf.com/events/charity-golf-classic-${i}-${uuid(i)}`;

function ctxAt(ms: number): Context {
  return {
    now: new Date(ms),
    caps: resolveBudget("nightly"),
    overrides: emptyOverrides(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { nowMs: () => 0 },
  };
}

describe("a directory sitemap larger than the per-host cap", () => {
  it("is spread across nights at 150 fetches for the host, and the 7-day dedupe holds the next weekly read back", async () => {
    const config = await loadPlatforms(PATHS.overrides);
    const rules = platformRulesFrom(config);
    const ppg = config.directories.find((d) => d.name === "Play Private Golf");
    if (!ppg) throw new Error("Play Private Golf missing from platforms.yaml");
    expect(EVENTS).toBeLessThanOrEqual(MAX_LINKS_PER_SOURCE);

    // Start on Play Private Golf's weekly night.
    let start = Date.parse("2026-10-12T07:15:00Z");
    while (!sourceDueTonight(ppg, new Date(start))) start += DAY;

    const listing: ListingLink[] = Array.from({ length: EVENTS }, (_, i) => ({
      found_via: "directory",
      origin: "Play Private Golf",
      url: eventUrl(i),
      title: null,
      text: null,
      registration_url: null,
    }));
    const pending = new Map<string, DiscoveryQueueRow>();
    const fetchedAt = new Map<string, string>();
    const perNight: number[] = [];

    for (let night = 0; night < 21; night++) {
      const ms = start + night * DAY;
      const ctx = ctxAt(ms);
      const allowance = { MAX_FETCHES_PER_RUN: 2500, MAX_RENDERS_PER_RUN: 400, MAX_FETCHES_PER_HOST_PER_RUN: 150 };
      const d = discover(ctx, {
        recheck: [],
        submissions: [],
        listings: sourceDueTonight(ppg, ctx.now) ? listing : [],
        serpResults: [],
        recentlyFetched: [...fetchedAt].map(([url, fetched_at]) => ({ url, fetched_at })),
        heldSources: [],
        pending: [...pending.values()],
        allowance,
        platform_rules: rules,
      });
      // Every queued Play Private Golf page keeps its directory host, deferred or not.
      expect(d.output.queue.every((q) => q.kind === "directory" && q.directory_host === "www.playprivategolf.com")).toBe(true);

      const plan = planFetch(ctx, { queue: d.output.queue, allowance });
      expect(plan.output.items.length).toBeLessThanOrEqual(150);
      perNight.push(plan.output.items.length);

      const fetched: FetchedPage[] = plan.output.items.map((it) => ({
        requested_url: it.url,
        url: it.url,
        kind: it.kind,
        found_via: it.found_via,
        fetched_at: ctx.now.toISOString(),
        http_status: 200,
        outcome: "ok",
        content_type: "text/html",
        html: "<p>golf</p>",
        pdf_text: null,
        rendered: false,
        error: null,
        recheck_outing_id: null,
        directory_host: it.directory_host,
      }));
      for (const f of fetched) fetchedAt.set(f.requested_url, f.fetched_at);
      const ops = queueBookkeeping(ctx.now, { deferred: plan.output.deferred, fetched, pending: [...pending.values()] }).ops;
      for (const op of ops) {
        if (op.table !== "discovery_queue") continue;
        if (op.op === "delete") pending.delete(String(op.where.url));
        if (op.op === "upsert") for (const r of op.rows as DiscoveryQueueRow[]) pending.set(r.url, r);
      }
    }

    // Week one: 150, 150, 150, 24 (474 in all), then nothing until the next weekly read.
    expect(perNight.slice(0, 7)).toEqual([150, 150, 150, 24, 0, 0, 0]);
    // Week two: only the pages fetched 7 days ago are due again; the rest are recent.
    expect(perNight.slice(7, 14)).toEqual([150, 0, 0, 0, 0, 0, 0]);
    // Week three: all 474 are due again (the oldest 7 days or more), and drain at 150 a night.
    expect(perNight.slice(14, 21)).toEqual([150, 150, 150, 24, 0, 0, 0]);
    expect(new Set(fetchedAt.keys()).size).toBe(EVENTS);
    expect(pending.size).toBe(0);
  });
});
