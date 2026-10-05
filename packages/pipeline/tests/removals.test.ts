import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { outingBySlug, sitemapOutings } from "@gof/db/queries";
import { drizzleOver } from "@gof/db/testing";
import { main, type MainResult } from "../src/cli.ts";
import { MemoryD1 } from "../src/d1/memory.ts";
import type { Overrides } from "../src/overrides/load.ts";

/**
 * SPEC.md 13 Phase 5: "An entry added to removals.yaml disappears from the site
 * after the next run." The fixture dry run publishes the golden outings; the
 * owner then lists one by URL (gc8, NKF at Winged Foot) and one by outing id
 * (gc2, Fordham at Winged Foot); the next run unpublishes both with
 * hold_reason 'removed', the site's outing-page query stops returning them, the
 * sitemap drops them, and the removed URL is neither queued nor fetched.
 */

const ENV = { NODE_ENV: "test", PIPELINE_NOW: "2026-09-28" };
const GC8_SLUG = "2026/nkf-golf-classic-winged-foot";

interface Run extends MainResult {
  err: string[];
}

async function dryRun(d1: MemoryD1, argv: string[], overrides?: Partial<Overrides>): Promise<Run> {
  const err: string[] = [];
  const r = await main(argv, {
    env: ENV,
    d1,
    stdout: () => {},
    stderr: (l) => err.push(l),
    ...(overrides ? { overrides } : {}),
  });
  return { ...r, err };
}

const row = z.object({
  id: z.string(),
  slug: z.string(),
  start_date: z.string().nullable(),
  outing_type: z.string(),
  published: z.number(),
  hold_reason: z.string().nullable(),
  canonical_source_url: z.string(),
});
type Row = z.infer<typeof row>;

function outings(d1: MemoryD1): Row[] {
  return z.array(row).parse(
    d1.db
      .prepare("SELECT id, slug, start_date, outing_type, published, hold_reason, canonical_source_url FROM outings")
      .all(),
  );
}

describe("removals.yaml takes an outing off the site on the next run", () => {
  const d1 = new MemoryD1();
  let gc8: Row;
  let gc2: Row;
  let second: Run;

  beforeAll(async () => {
    const first = await dryRun(d1, ["--dry-run", "--strict"]);
    expect(first.exitCode).toBe(0);
    const rows = outings(d1);
    gc8 = rows.find((r) => r.slug === GC8_SLUG)!;
    gc2 = rows.find((r) => r.start_date === "2026-10-13" && r.outing_type === "school_fundraiser")!;
    expect(gc8).toMatchObject({ published: 1 });
    expect(gc2).toMatchObject({ published: 1 });
    expect(await outingBySlug(drizzleOver(d1.db), gc8.slug)).not.toBeNull();
    expect(await outingBySlug(drizzleOver(d1.db), gc2.slug)).not.toBeNull();

    // A deferred copy of the removed URL waits in discovery_queue.
    d1.db
      .prepare(
        "INSERT INTO discovery_queue (url, found_via, found_at, priority, next_attempt_at, attempts) VALUES (?, 'search_place', '2026-09-28T12:00:00.000Z', 8, NULL, 0)",
      )
      .run(gc8.canonical_source_url);

    // Eight days later the 7-day dedupe no longer hides any page, so the removed
    // URL would be queued again (search, listings, recheck) if removals.yaml didn't stop it.
    second = await dryRun(d1, ["--dry-run", "--strict", "--now=2026-10-06T12:00:00Z"], {
      removals: {
        outing_ids: [gc2.id],
        // Pasted from a browser: tracking parameters and a fragment still match.
        urls: [`${gc8.canonical_source_url}?utm_source=email#register`],
      },
    });
  }, 120_000);

  it("the next run completes", () => {
    expect(second.networkAttempts).toEqual([]);
    expect(second.exitCode).toBe(0);
  });

  it("unpublishes both with hold_reason 'removed' and leaves the others published", () => {
    const rows = outings(d1);
    expect(rows.find((r) => r.id === gc8.id)).toMatchObject({ published: 0, hold_reason: "removed" });
    expect(rows.find((r) => r.id === gc2.id)).toMatchObject({ published: 0, hold_reason: "removed" });
    expect(rows.filter((r) => r.published === 1).length).toBeGreaterThan(0);
  });

  it("the site's outing page query and the sitemap no longer return them", async () => {
    const db = drizzleOver(d1.db);
    expect(await outingBySlug(db, gc8.slug)).toBeNull();
    expect(await outingBySlug(db, gc2.slug)).toBeNull();
    const sitemap = (await sitemapOutings(db)).map((e) => e.path);
    expect(sitemap.some((p) => p.includes(gc8.slug))).toBe(false);
    expect(sitemap.some((p) => p.includes(gc2.slug))).toBe(false);
    expect(sitemap.length).toBeGreaterThan(0);
  });

  it("the removed URL costs no fetch: never queued, never fetched, gone from discovery_queue", () => {
    const state = second.outcome!.state;
    const url = gc8.canonical_source_url;
    expect(state.queue.map((q) => q.url)).not.toContain(url);
    expect(state.fetchPlan.map((q) => q.url)).not.toContain(url);
    expect(state.fetched.map((f) => f.requested_url)).not.toContain(url);
    // The outing removed by id is not rechecked.
    expect(state.queue.filter((q) => q.recheck_outing_id === gc2.id)).toEqual([]);
    const waiting = d1.db.prepare("SELECT count(*) AS n FROM discovery_queue WHERE url = ?").get(url) as { n: number };
    expect(waiting.n).toBe(0);
  });
});
