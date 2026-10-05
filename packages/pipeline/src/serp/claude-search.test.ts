import { describe, expect, it } from "vitest";
import type { ClaudeSpawner, SpawnResult } from "../llm/claude-cli.ts";
import type { BudgetCheck, SerpQuery } from "../stages/types.ts";
import { CLAUDE_SEARCH_SYSTEM_PROMPT, createClaudeSearchAdapter, serpAnswerJsonSchema } from "./claude-search.ts";
import { runSerpQueries } from "./fixture.ts";

function answer(results: { url: string; title?: string; snippet?: string }[], over: Record<string, unknown> = {}): SpawnResult {
  const structured = { results: results.map((r) => ({ title: "t", snippet: "s", ...r })) };
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(structured),
      structured_output: structured,
      usage: { input_tokens: 4000, output_tokens: 600, server_tool_use: { web_search_requests: 1 } },
      total_cost_usd: 0.03,
      ...over,
    }),
    stderr: "",
    timedOut: false,
  };
}

function fake(fn: (input: string, args: readonly string[]) => SpawnResult): ClaudeSpawner & { calls: { input: string; args: readonly string[] }[] } {
  const calls: { input: string; args: readonly string[] }[] = [];
  const run: ClaudeSpawner = async (args, input) => {
    calls.push({ input, args });
    return fn(input, args);
  };
  return Object.assign(run, { calls });
}

const q = (text: string): SerpQuery => ({ kind: "place", q: text, subject: "White Plains, NY" });
const noSleep = async (): Promise<void> => {};

function meteredBudget(limit: number): BudgetCheck & { used: number } {
  const b = {
    used: 0,
    check(cap: string, n = 1) {
      if (cap !== "MAX_SERP_QUERIES_PER_RUN") return true;
      if (b.used + n > limit) return false;
      b.used += n;
      return true;
    },
    monthlySpendOk: () => true,
  };
  return b;
}

describe("claude-search SERP adapter", () => {
  it("runs claude -p with WebSearch only, the exact query on stdin, and the results schema", async () => {
    const spawn = fake(() => answer([{ url: "https://example.org/golf-outing?utm_source=x#top" }]));
    const adapter = createClaudeSearchAdapter({ spawner: spawn, sleep: noSleep });
    const out = await adapter.search(q("golf outing White Plains NY 2026"), meteredBudget(10));
    expect(out).toEqual([
      {
        query: q("golf outing White Plains NY 2026"),
        rank: 1,
        url: "https://example.org/golf-outing",
        title: "t",
        snippet: "s",
      },
    ]);
    const call = spawn.calls[0];
    expect(call?.input).toBe("golf outing White Plains NY 2026");
    const flag = (name: string): string | undefined => call?.args[call.args.indexOf(name) + 1];
    expect(flag("--allowedTools")).toBe("WebSearch");
    expect(flag("--tools")).toBe("WebSearch");
    expect(flag("--system-prompt")).toBe(CLAUDE_SEARCH_SYSTEM_PROMPT);
    expect(JSON.parse(flag("--json-schema") ?? "{}")).toEqual(serpAnswerJsonSchema);
    expect(flag("--model")).toBe("claude-haiku-4-5");
  });

  it("keeps at most 10 results, drops non-http and duplicate URLs, ranks in order", async () => {
    const urls = [
      "https://a.example/1",
      "javascript:alert(1)",
      "https://a.example/1",
      ...Array.from({ length: 12 }, (_, i) => `https://b.example/${i}`),
    ];
    const adapter = createClaudeSearchAdapter({
      spawner: fake(() => answer(urls.map((url) => ({ url })))),
      sleep: noSleep,
    });
    const out = await adapter.search(q("x"), meteredBudget(10));
    expect(out).toHaveLength(10);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out[0]?.url).toBe("https://a.example/1");
    expect(out.every((r) => r.url.startsWith("https://"))).toBe(true);
  });

  it("each query counts against MAX_SERP_QUERIES_PER_RUN; nothing is spawned past the cap", async () => {
    const spawn = fake((input) => answer([{ url: `https://example.org/${encodeURIComponent(input)}` }]));
    const adapter = createClaudeSearchAdapter({ spawner: spawn, sleep: noSleep, concurrency: 2 });
    const budget = meteredBudget(3);
    const out = await runSerpQueries(adapter, [q("a"), q("b"), q("c"), q("d"), q("e")], budget);
    expect(spawn.calls).toHaveLength(3);
    expect(budget.used).toBe(3);
    expect(out.map((r) => r.query.q)).toEqual(["a", "b", "c"]);
  });

  it("a query that keeps failing yields no results but does not stop the others", async () => {
    const spawn = fake((input) =>
      input === "bad"
        ? { exitCode: 1, stdout: "", stderr: "boom", timedOut: false }
        : answer([{ url: `https://example.org/${input}` }]),
    );
    const warnings: string[] = [];
    const adapter = createClaudeSearchAdapter({
      spawner: spawn,
      sleep: noSleep,
      log: { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} },
    });
    const out = await adapter.searchMany([q("ok1"), q("bad"), q("ok2")], meteredBudget(10));
    expect(out.map((r) => r.query.q)).toEqual(["ok1", "ok2"]);
    expect(spawn.calls.filter((c) => c.input === "bad")).toHaveLength(3);
    expect(warnings.join(" ")).toMatch(/claude-search/);
  });

  it("stops every remaining query after a fatal answer (not logged in)", async () => {
    const spawn = fake(() => answer([], { is_error: true, result: "Not logged in · Please run /login" }));
    const adapter = createClaudeSearchAdapter({ spawner: spawn, sleep: noSleep, concurrency: 1 });
    const out = await adapter.searchMany([q("a"), q("b"), q("c")], meteredBudget(10));
    expect(out).toEqual([]);
    expect(spawn.calls).toHaveLength(1);
    expect(adapter.stats().fatal).toMatch(/Not logged in/);
  });

  it("tracks searches, tokens and the API-price cost proxy", async () => {
    const adapter = createClaudeSearchAdapter({ spawner: fake(() => answer([{ url: "https://x.example/" }])), sleep: noSleep });
    await adapter.searchMany([q("a"), q("b")], meteredBudget(10));
    expect(adapter.stats()).toMatchObject({ queries: 2, succeeded: 2, failed: 0, web_search_requests: 2, results: 2 });
    expect(adapter.stats().cost_usd).toBeCloseTo(0.06);
  });
});
