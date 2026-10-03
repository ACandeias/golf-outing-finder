import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import type { BudgetCheck, SerpAdapter, SerpQuery, SerpResult } from "../stages/types.ts";
import {
  organicResults,
  SerpBudgetExhausted,
  taskGetResponseSchema,
  type BatchSerpAdapter,
  type TaskGetResponse,
} from "./dataforseo.ts";

/**
 * The SERP adapter for tests and dry runs: answers from
 * tests/fixtures/serp/*.json, each `{ "q": "<query text>", "response": <a
 * DataForSEO task_get/regular response> }`. Unknown queries return no results.
 * Every query still goes through the budget guard, so the
 * MAX_SERP_QUERIES_PER_RUN behavior is the same as a live run.
 */

const fixtureSchema = z.object({ q: z.string().min(1), response: taskGetResponseSchema });

export function loadSerpFixtures(dir = join(REPO_ROOT, "tests/fixtures/serp")): Map<string, TaskGetResponse> {
  const out = new Map<string, TaskGetResponse>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const fx = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    out.set(fx.q.toLowerCase(), fx.response);
  }
  return out;
}

export function createFixtureSerpAdapter(fixtures: ReadonlyMap<string, TaskGetResponse> = loadSerpFixtures()): BatchSerpAdapter {
  const one = (query: SerpQuery, budget: BudgetCheck): SerpResult[] => {
    if (!budget.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover")) throw new SerpBudgetExhausted();
    const response = fixtures.get(query.q.toLowerCase());
    return response ? organicResults(query, response) : [];
  };
  return {
    async search(query, budget) {
      return one(query, budget);
    },
    async searchMany(queries, budget) {
      const out: SerpResult[] = [];
      for (const q of queries) {
        try {
          out.push(...one(q, budget));
        } catch (err) {
          if (err instanceof SerpBudgetExhausted) break;
          throw err;
        }
      }
      return out;
    },
  };
}

/** Runs queries through any adapter, stopping at the first one the budget refuses. */
export async function runSerpQueries(
  adapter: SerpAdapter | BatchSerpAdapter,
  queries: readonly SerpQuery[],
  budget: BudgetCheck,
): Promise<SerpResult[]> {
  if ("searchMany" in adapter) return adapter.searchMany(queries, budget);
  const out: SerpResult[] = [];
  for (const q of queries) {
    try {
      out.push(...(await adapter.search(q, budget)));
    } catch (err) {
      if (err instanceof SerpBudgetExhausted) break;
      throw err;
    }
  }
  return out;
}
