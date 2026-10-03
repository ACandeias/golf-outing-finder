import { resolveBudget } from "@gof/shared/budget";
import { describe, expect, it } from "vitest";
import { emptyOverrides } from "../overrides/load.ts";
import { MAX_QUEUE_ATTEMPTS, planFetch, queueBookkeeping } from "./fetch-plan.ts";
import { parseUpsertPlan, type Context, type FetchedPage, type QueueEntry } from "./types.ts";

const ctx: Context = {
  now: new Date("2026-09-28T07:20:00Z"),
  caps: { ...resolveBudget("nightly"), MAX_FETCHES_PER_RUN: 10 },
  overrides: emptyOverrides({ jsPlatforms: ["classy.org", "support.kidney.org"] }),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  clock: { nowMs: () => 0 },
};

function q(url: string, patch: Partial<QueueEntry> = {}): QueueEntry {
  return {
    url,
    found_via: "search_place",
    kind: "search",
    priority: 8,
    bypass_dedupe: false,
    recheck_outing_id: null,
    directory_host: null,
    ...patch,
  };
}

describe("planFetch", () => {
  it("orders by priority, sets host and marks js-platform hosts for a render", () => {
    const out = planFetch(ctx, {
      queue: [
        q("https://a.example/1"),
        q("https://support.kidney.org/event/e1", { found_via: "series", kind: "series", priority: 3 }),
        q("https://www.classy.org/event/x", { priority: 5 }),
      ],
      allowance: { MAX_FETCHES_PER_RUN: 10, MAX_RENDERS_PER_RUN: 400, MAX_FETCHES_PER_HOST_PER_RUN: 150 },
    });
    expect(out.output.items.map((i) => [i.host, i.render])).toEqual([
      ["support.kidney.org", true],
      ["www.classy.org", true],
      ["a.example", false],
    ]);
    expect(out.output.deferred).toEqual([]);
    expect(out.result.budgetHits).toEqual([]);
  });

  it("defers past MAX_FETCHES_PER_RUN with one budget hit", () => {
    const queue = Array.from({ length: 12 }, (_, i) => q(`https://h${i}.example/`));
    const out = planFetch(ctx, { queue, allowance: { MAX_FETCHES_PER_RUN: 10 } });
    expect(out.output.items).toHaveLength(10);
    expect(out.output.deferred.map((d) => d.url)).toEqual(["https://h10.example/", "https://h11.example/"]);
    expect(out.result.budgetHits).toHaveLength(1);
    expect(out.result.budgetHits[0]).toMatchObject({ cap: "MAX_FETCHES_PER_RUN", stage: "fetch" });
  });

  it("caps rechecks at 40% of MAX_FETCHES_PER_RUN", () => {
    const queue = Array.from({ length: 6 }, (_, i) =>
      q(`https://r${i}.example/`, { found_via: "recheck", kind: "organizer", priority: 1, bypass_dedupe: true, recheck_outing_id: `o${i}` }),
    );
    const out = planFetch(ctx, { queue: [...queue, q("https://new.example/")], allowance: {} });
    expect(out.output.items.filter((i) => i.found_via === "recheck")).toHaveLength(4);
    expect(out.output.items.map((i) => i.url)).toContain("https://new.example/");
    expect(out.output.deferred).toHaveLength(2);
  });

  it("caps fetches per host", () => {
    const queue = Array.from({ length: 4 }, (_, i) => q(`https://same.example/${i}`));
    const out = planFetch(ctx, { queue, allowance: { MAX_FETCHES_PER_HOST_PER_RUN: 3 } });
    expect(out.output.items).toHaveLength(3);
    expect(out.result.budgetHits[0]).toMatchObject({ cap: "MAX_FETCHES_PER_HOST_PER_RUN", detail: "same.example" });
  });

  it("defers js-platform pages when no renders are left", () => {
    const out = planFetch(ctx, {
      queue: [q("https://www.classy.org/e/1"), q("https://plain.example/")],
      allowance: { MAX_RENDERS_PER_RUN: 0 },
    });
    expect(out.output.items.map((i) => i.url)).toEqual(["https://plain.example/"]);
    expect(out.output.deferred.map((i) => i.url)).toEqual(["https://www.classy.org/e/1"]);
    expect(out.result.budgetHits[0]?.cap).toBe("MAX_RENDERS_PER_RUN");
  });
});

describe("queueBookkeeping", () => {
  const now = new Date("2026-09-28T07:20:00Z");
  const page = (url: string, outcome: FetchedPage["outcome"]): FetchedPage => ({
    requested_url: url,
    url,
    kind: "search",
    found_via: "search_place",
    fetched_at: "2026-09-28T07:21:00.000Z",
    http_status: null,
    outcome,
    content_type: null,
    html: null,
    pdf_text: null,
    rendered: false,
    error: null,
    recheck_outing_id: null,
    directory_host: null,
  });

  it("stores deferred entries, drops fetched rows and retries transient failures", () => {
    const plan = queueBookkeeping(now, {
      deferred: [q("https://later.example/")],
      fetched: [
        page("https://done.example/", "ok"),
        page("https://flaky.example/", "timeout"),
        page("https://dead.example/", "server_error"),
        page("https://fresh.example/", "ok"),
      ],
      pending: [
        { url: "https://done.example/", found_via: "platform", found_at: "2026-09-27T07:00:00.000Z", priority: 5, next_attempt_at: null, attempts: 0 },
        { url: "https://dead.example/", found_via: "platform", found_at: "2026-09-25T07:00:00.000Z", priority: 5, next_attempt_at: null, attempts: MAX_QUEUE_ATTEMPTS - 1 },
      ],
    });
    expect(() => parseUpsertPlan(plan)).not.toThrow();
    expect(plan.ops).toEqual([
      {
        op: "upsert",
        table: "discovery_queue",
        rows: [{ url: "https://later.example/", found_via: "search_place", found_at: "2026-09-28T07:20:00.000Z", priority: 8, next_attempt_at: null, attempts: 0 }],
        update: ["priority"],
      },
      { op: "delete", table: "discovery_queue", where: { url: "https://done.example/" } },
      { op: "delete", table: "discovery_queue", where: { url: "https://dead.example/" } },
      {
        op: "upsert",
        table: "discovery_queue",
        rows: [{ url: "https://flaky.example/", found_via: "search_place", found_at: "2026-09-28T07:20:00.000Z", priority: 5, next_attempt_at: "2026-09-29T07:20:00.000Z", attempts: 1 }],
        update: ["next_attempt_at", "attempts"],
      },
    ]);
  });
});
