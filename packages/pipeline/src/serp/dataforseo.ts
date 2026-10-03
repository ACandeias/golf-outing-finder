import { z } from "zod";
import { normalizeUrl } from "../discovery/url.ts";
import type { BudgetCheck, SerpAdapter, SerpQuery, SerpResult } from "../stages/types.ts";

/**
 * DataForSEO Google organic SERP, standard queue (amendment A6, SPEC.md 8.2 and
 * 14). Checked against docs.dataforseo.com on 2026-10-03:
 *   POST https://api.dataforseo.com/v3/serp/google/organic/task_post
 *        body: array of up to 100 tasks { keyword, location_code, language_code, depth, tag }
 *   GET  https://api.dataforseo.com/v3/serp/google/organic/task_get/regular/{id}
 *   HTTP Basic auth with the API login and password (SERP_API_KEY = "login:password").
 *   Task status 20100 = created, 40601 = handed, 40602 = in queue, 20000 = ready.
 *   Standard queue price $0.0006 per SERP of 10 results, charged at task_post.
 * Every query passes the budget guard before it is posted. Never called in
 * tests or dry runs; the fixture adapter stands in.
 */

export const DATAFORSEO_BASE = "https://api.dataforseo.com/v3/serp/google/organic";
export const US_LOCATION_CODE = 2840;
export const TASKS_PER_POST = 100;

const STATUS_OK = 20000;
const STATUS_CREATED = 20100;
const STATUS_WAITING = new Set([40601, 40602]);

const taskBase = z
  .object({
    id: z.string().nullable().optional(),
    status_code: z.number().int(),
    status_message: z.string().optional(),
  })
  .passthrough();

const envelope = <T extends z.ZodTypeAny>(task: T) =>
  z
    .object({
      status_code: z.number().int(),
      status_message: z.string().optional(),
      tasks: z.array(task).nullable().default([]),
    })
    .passthrough();

export const taskPostResponseSchema = envelope(
  taskBase.extend({ data: z.object({ tag: z.string().optional() }).passthrough().nullable().optional() }),
);

const organicItem = z
  .object({
    type: z.string(),
    rank_group: z.number().int().optional(),
    rank_absolute: z.number().int().optional(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

export const taskGetResponseSchema = envelope(
  taskBase.extend({
    result: z
      .array(
        z
          .object({
            keyword: z.string().optional(),
            items: z.array(organicItem).nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  }),
);
export type TaskGetResponse = z.infer<typeof taskGetResponseSchema>;

/** Organic results of one task_get response, as SerpResults for `query`. */
export function organicResults(query: SerpQuery, response: TaskGetResponse): SerpResult[] {
  const out: SerpResult[] = [];
  for (const task of response.tasks ?? []) {
    if (task.status_code !== STATUS_OK) continue;
    for (const r of task.result ?? []) {
      for (const item of r.items ?? []) {
        if (item.type !== "organic" || !item.url) continue;
        const url = normalizeUrl(item.url);
        if (url === null) continue;
        out.push({
          query,
          rank: Math.max(1, item.rank_group ?? item.rank_absolute ?? out.length + 1),
          url,
          title: item.title ?? "",
          snippet: item.description ?? "",
        });
      }
    }
  }
  return out;
}

/** Thrown by an adapter when MAX_SERP_QUERIES_PER_RUN (or the monthly cap) refuses a query. */
export class SerpBudgetExhausted extends Error {
  constructor() {
    super("MAX_SERP_QUERIES_PER_RUN reached");
    this.name = "SerpBudgetExhausted";
  }
}

export type HttpJson = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; json: unknown }>;

export interface DataForSeoOptions {
  /** `login:password` from SERP_API_KEY. Never logged. */
  credentials: string;
  http: HttpJson;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  locationCode?: number;
  languageCode?: string;
  depth?: number;
}

export interface BatchSerpAdapter extends SerpAdapter {
  /** Posts every query the budget allows, then collects them all. */
  searchMany(queries: readonly SerpQuery[], budget: BudgetCheck): Promise<SerpResult[]>;
}

export function createDataForSeoAdapter(o: DataForSeoOptions): BatchSerpAdapter {
  if (!o.credentials.includes(":")) throw new Error("SERP_API_KEY must be login:password");
  const auth = `Basic ${Buffer.from(o.credentials, "utf8").toString("base64")}`;
  const headers = { authorization: auth, "content-type": "application/json" };
  const poll = o.pollIntervalMs ?? 30_000;
  const maxWait = o.maxWaitMs ?? 30 * 60_000;
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await o.http(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`DataForSEO auth failed (HTTP ${res.status})`);
    if (res.status >= 400) throw new Error(`DataForSEO HTTP ${res.status}`);
    return res.json;
  };

  async function postAndCollect(allowed: readonly SerpQuery[]): Promise<SerpResult[]> {
    const pending = new Map<string, SerpQuery>();
    for (let i = 0; i < allowed.length; i += TASKS_PER_POST) {
      const chunk = allowed.slice(i, i + TASKS_PER_POST);
      const body = chunk.map((q, j) => ({
        keyword: q.q,
        location_code: o.locationCode ?? US_LOCATION_CODE,
        language_code: o.languageCode ?? "en",
        depth: o.depth ?? 10,
        tag: String(i + j),
      }));
      const parsed = taskPostResponseSchema.parse(await call("POST", `${DATAFORSEO_BASE}/task_post`, body));
      for (const t of parsed.tasks ?? []) {
        const tag = Number(t.data?.tag);
        const q = Number.isInteger(tag) ? allowed[tag] : undefined;
        if (t.status_code === STATUS_CREATED && t.id && q) pending.set(t.id, q);
      }
    }
    const out: SerpResult[] = [];
    let waited = 0;
    while (pending.size > 0 && waited <= maxWait) {
      await o.sleep(poll);
      waited += poll;
      for (const [id, q] of [...pending]) {
        const parsed = taskGetResponseSchema.parse(
          await call("GET", `${DATAFORSEO_BASE}/task_get/regular/${encodeURIComponent(id)}`),
        );
        const status = parsed.tasks?.[0]?.status_code;
        if (status !== undefined && STATUS_WAITING.has(status)) continue;
        pending.delete(id);
        out.push(...organicResults(q, parsed));
      }
    }
    if (pending.size > 0) throw new Error(`DataForSEO: ${pending.size} tasks not ready after ${maxWait} ms`);
    return out;
  }

  return {
    async searchMany(queries, budget) {
      const allowed: SerpQuery[] = [];
      for (const q of queries) {
        if (!budget.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover")) break;
        allowed.push(q);
      }
      return postAndCollect(allowed);
    },
    async search(query, budget) {
      if (!budget.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover")) throw new SerpBudgetExhausted();
      return postAndCollect([query]);
    },
  };
}
