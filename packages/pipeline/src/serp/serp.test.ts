import { describe, expect, it } from "vitest";
import { BudgetGuard } from "../budget.ts";
import type { SerpQuery } from "../stages/types.ts";
import {
  createDataForSeoAdapter,
  DATAFORSEO_BASE,
  organicResults,
  SerpBudgetExhausted,
  taskGetResponseSchema,
  type HttpJson,
} from "./dataforseo.ts";
import { createFixtureSerpAdapter, loadSerpFixtures, runSerpQueries } from "./fixture.ts";

const NOW = new Date("2026-09-28T07:15:00Z");
const guard = (max = 450) =>
  new BudgetGuard({ profile: "nightly", env: { MAX_SERP_QUERIES_PER_RUN: String(max) }, now: NOW, clock: { nowMs: () => 0 } });
const q = (text: string): SerpQuery => ({ kind: "place", q: text, subject: "Queens, NY" });

describe("organicResults", () => {
  it("keeps organic items only, normalizes URLs and drops unusable ones", () => {
    const fx = loadSerpFixtures().get("golf outing queens ny 2026");
    expect(fx).toBeDefined();
    const out = organicResults(q("golf outing Queens NY 2026"), fx!);
    expect(out.map((r) => [r.rank, r.url])).toEqual([
      [1, "https://www.buildersinstitute.org/annual-golf-outing"],
      [2, "https://queens-charity.example/golf-outing-2026"],
    ]);
    expect(out[0]?.title).toBe("Annual Golf Outing - The Builders Institute");
  });

  it("ignores tasks that are not ready", () => {
    const res = taskGetResponseSchema.parse({ status_code: 20000, tasks: [{ id: "x", status_code: 40602, result: null }] });
    expect(organicResults(q("x"), res)).toEqual([]);
  });
});

describe("fixture adapter", () => {
  it("answers from tests/fixtures/serp and counts every query", async () => {
    const a = createFixtureSerpAdapter();
    const g = guard();
    const out = await runSerpQueries(a, [q("golf outing Queens NY 2026"), q("no fixture for this")], g);
    expect(out).toHaveLength(2);
    expect(g.spent("MAX_SERP_QUERIES_PER_RUN")).toBe(2);
  });

  it("stops at MAX_SERP_QUERIES_PER_RUN with a budget hit", async () => {
    const a = createFixtureSerpAdapter();
    const g = guard(5);
    await runSerpQueries(a, Array.from({ length: 9 }, (_, i) => q(`q${i}`)), g);
    expect(g.spent("MAX_SERP_QUERIES_PER_RUN")).toBe(5);
    expect(g.hits().map((h) => h.cap)).toEqual(["MAX_SERP_QUERIES_PER_RUN"]);
    await expect(a.search(q("one more"), g)).rejects.toBeInstanceOf(SerpBudgetExhausted);
  });
});

describe("DataForSEO adapter (recorded shapes, no network)", () => {
  function fakeApi(opts: { waitRounds?: number } = {}) {
    const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
    let rounds = 0;
    const http: HttpJson = async (url, init) => {
      calls.push({
        method: init.method,
        url,
        ...(init.body ? { body: JSON.parse(init.body) as unknown } : {}),
        auth: init.headers.authorization,
      });
      if (url.endsWith("/task_post")) {
        const tasks = (JSON.parse(init.body ?? "[]") as { tag: string; keyword: string }[]).map((t) => ({
          id: `id-${t.tag}`,
          status_code: 20100,
          status_message: "Task Created.",
          data: { tag: t.tag, keyword: t.keyword },
          result: null,
        }));
        return { status: 200, json: { status_code: 20000, tasks } };
      }
      const id = url.split("/").pop() ?? "";
      if (rounds++ < (opts.waitRounds ?? 0)) {
        return { status: 200, json: { status_code: 20000, tasks: [{ id, status_code: 40602, status_message: "Task In Queue." }] } };
      }
      return {
        status: 200,
        json: {
          status_code: 20000,
          tasks: [
            {
              id,
              status_code: 20000,
              result: [{ items: [{ type: "organic", rank_group: 1, url: `https://r.example/${id}`, title: "T", description: "D" }] }],
            },
          ],
        },
      };
    };
    return { http, calls };
  }

  it("posts allowed queries as standard-queue tasks with Basic auth and collects them", async () => {
    const { http, calls } = fakeApi({ waitRounds: 1 });
    const slept: number[] = [];
    const a = createDataForSeoAdapter({
      credentials: "login@example.com:secret",
      http,
      sleep: async (ms) => void slept.push(ms),
      pollIntervalMs: 1000,
    });
    const g = guard(2);
    const out = await a.searchMany([q("golf outing Queens NY 2026"), q("b"), q("c")], g);
    expect(g.spent("MAX_SERP_QUERIES_PER_RUN")).toBe(2);
    const post = calls[0]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`${DATAFORSEO_BASE}/task_post`);
    expect(post.auth).toBe(`Basic ${Buffer.from("login@example.com:secret").toString("base64")}`);
    expect(post.body).toEqual([
      { keyword: "golf outing Queens NY 2026", location_code: 2840, language_code: "en", depth: 10, tag: "0" },
      { keyword: "b", location_code: 2840, language_code: "en", depth: 10, tag: "1" },
    ]);
    expect(calls.slice(1).every((c) => c.method === "GET" && c.url.includes("/task_get/regular/"))).toBe(true);
    expect(out.map((r) => [r.query.q, r.url])).toEqual([
      ["b", "https://r.example/id-1"],
      ["golf outing Queens NY 2026", "https://r.example/id-0"],
    ]);
    expect(slept.length).toBeGreaterThanOrEqual(2);
  });

  it("posts nothing when the budget is used up", async () => {
    const { http, calls } = fakeApi();
    const a = createDataForSeoAdapter({ credentials: "a:b", http, sleep: async () => {} });
    expect(await a.searchMany([q("x")], guard(0))).toEqual([]);
    expect(calls).toEqual([]);
    await expect(a.search(q("x"), guard(0))).rejects.toBeInstanceOf(SerpBudgetExhausted);
  });

  it("refuses credentials that are not login:password", () => {
    expect(() => createDataForSeoAdapter({ credentials: "token", http: fakeApi().http, sleep: async () => {} })).toThrow(
      /login:password/,
    );
  });

  it("gives up after maxWaitMs", async () => {
    const { http } = fakeApi({ waitRounds: 1000 });
    const a = createDataForSeoAdapter({ credentials: "a:b", http, sleep: async () => {}, pollIntervalMs: 10, maxWaitMs: 30 });
    await expect(a.searchMany([q("x")], guard())).rejects.toThrow(/not ready/);
  });
});
