import { checkUrl, type GuardOptions } from "../net/ssrf.ts";
import { RenderBlockedError, type Renderer } from "../render/renderer.ts";
import { RobotsCache } from "../robots/robots.ts";
import type {
  BudgetCheck,
  Clock,
  FetchedPage,
  FetchOutcome,
  FetchPlanItem,
  PageFetcher,
} from "../stages/types.ts";
import { HostGate, type Sleep } from "./gate.ts";
import { decodeBody, httpGet, type FetchFn, type HttpResult, type Validators } from "./http.ts";
import { MAX_PDF_BYTES, type PdfTextFn } from "./pdf.ts";

/**
 * The PageFetcher edge (SPEC.md 8.3): SSRF guard, robots.txt, per-host
 * spacing, budget meters, conditional GET, HTML/PDF handling and the optional
 * headless render. Every dependency that touches the network is injected.
 */

export function userAgentFor(siteUrl: string): string {
  return `GolfOutingFinderBot/1.0 (+${siteUrl.replace(/\/+$/, "")}/bot)`;
}

/** Validators from earlier fetches, for If-None-Match / If-Modified-Since. */
export interface ValidatorStore {
  get(url: string): Validators | undefined;
  set(url: string, v: Validators): void;
}

export function memoryValidatorStore(init: Record<string, Validators> = {}): ValidatorStore {
  const m = new Map(Object.entries(init));
  return { get: (u) => m.get(u), set: (u, v) => void m.set(u, v) };
}

/** Thrown when MAX_FETCHES_PER_RUN is used up; `fetchAll` stops and defers the rest. */
export class FetchBudgetExhausted extends Error {
  constructor() {
    super("MAX_FETCHES_PER_RUN reached");
    this.name = "FetchBudgetExhausted";
  }
}

export interface PageFetcherDeps {
  fetchFn: FetchFn;
  guard: GuardOptions;
  userAgent: string;
  clock: Clock;
  /** ISO timestamp for `fetched_at` (the run's logical now plus elapsed time). */
  nowIso: () => string;
  pdfText: PdfTextFn;
  renderer?: Renderer | null;
  validators?: ValidatorStore;
  sleep?: Sleep;
  /** Minimum spacing per host; 5 s by default (SPEC.md 8.3). */
  hostSpacingMs?: number;
  timeoutMs?: number;
}

export interface GuardedPageFetcher extends PageFetcher {
  readonly robots: RobotsCache;
  /** Fetches robots.txt-respecting raw bytes (listing pages, sitemaps) with the same guard. */
  fetchRaw(url: string, budget: BudgetCheck): Promise<HttpResult>;
}

function outcomeForStatus(status: number): FetchOutcome {
  if (status === 304) return "not_modified";
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (status >= 200 && status < 300) return "ok";
  return "client_error";
}

function isPdf(contentType: string | null, body: Uint8Array): boolean {
  if (/application\/(x-)?pdf/i.test(contentType ?? "")) return true;
  return body.byteLength >= 5 && new TextDecoder().decode(body.subarray(0, 5)) === "%PDF-";
}

function isHtmlLike(contentType: string | null, body: Uint8Array): boolean {
  if (contentType === null || contentType.trim() === "") {
    const head = new TextDecoder().decode(body.subarray(0, 512)).trimStart().toLowerCase();
    return head.startsWith("<");
  }
  return /text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml/i.test(
    contentType,
  );
}

export function createPageFetcher(deps: PageFetcherDeps): GuardedPageFetcher {
  const gate = new HostGate({
    clock: deps.clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.hostSpacingMs !== undefined ? { floorMs: deps.hostSpacingMs } : {}),
  });

  /** One GET through the gate for `url`'s host, robots.txt fetches included. */
  const gatedGet = async (
    url: string,
    spacingMs: number,
    vetRobots: boolean,
    validators?: Validators,
  ): Promise<HttpResult> => {
    const host = new URL(url).hostname;
    return gate.run(host, spacingMs, () =>
      httpGet(url, {
        fetchFn: deps.fetchFn,
        userAgent: deps.userAgent,
        ...(validators ? { validators } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        vet: async (u) => {
          const g = await checkUrl(u, deps.guard);
          if (!g.ok) return { kind: "ssrf", reason: g.reason };
          if (vetRobots) {
            const d = await robots.check(u);
            if (!d.allowed) return { kind: "robots" };
          }
          return null;
        },
      }),
    );
  };

  const robots: RobotsCache = new RobotsCache({
    clock: deps.clock,
    fetchRobots: async (url) => {
      const r = await gatedGet(url, 0, false);
      if (r.kind === "response") return { status: r.status, body: decodeBody(r.body, r.contentType) };
      if (r.kind === "too_large") return { status: 200, body: "" };
      if (r.kind === "ssrf_blocked") return { status: 403, body: "User-agent: *\nDisallow: /\n" };
      throw new Error(`robots.txt unavailable: ${r.kind}`);
    },
  });

  const page = (item: FetchPlanItem, patch: Partial<FetchedPage>): FetchedPage => ({
    requested_url: item.url,
    url: item.url,
    kind: item.kind,
    found_via: item.found_via,
    fetched_at: deps.nowIso(),
    http_status: null,
    outcome: "ok",
    content_type: null,
    html: null,
    pdf_text: null,
    rendered: false,
    error: null,
    recheck_outing_id: item.recheck_outing_id,
    directory_host: item.directory_host,
    ...patch,
  });

  const fetchRaw = async (url: string, budget: BudgetCheck): Promise<HttpResult> => {
    const g = await checkUrl(url, deps.guard);
    if (!g.ok) return { kind: "ssrf_blocked", url, reason: g.reason };
    const decision = await robots.check(url);
    if (!decision.allowed) return { kind: "robots_blocked", url };
    if (!budget.check("MAX_FETCHES_PER_RUN", 1, "fetch")) throw new FetchBudgetExhausted();
    return gatedGet(url, decision.crawlDelayMs, true);
  };

  async function renderPage(item: FetchPlanItem, crawlDelayMs: number): Promise<FetchedPage> {
    const renderer = deps.renderer;
    if (!renderer) throw new Error("no renderer");
    const host = new URL(item.url).hostname;
    try {
      const r = await gate.run(host, crawlDelayMs, () => renderer.render(item.url));
      return page(item, {
        url: r.finalUrl,
        http_status: r.status || null,
        outcome: r.status === 0 ? "ok" : outcomeForStatus(r.status),
        content_type: "text/html",
        html: r.html,
        rendered: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RenderBlockedError) {
        return page(item, { outcome: "ssrf_blocked", error: message, rendered: true });
      }
      const timeout = /timeout/i.test(message);
      return page(item, {
        outcome: timeout ? "timeout" : "network_error",
        error: message.slice(0, 500),
        rendered: true,
      });
    }
  }

  async function fetchPage(item: FetchPlanItem, budget: BudgetCheck): Promise<FetchedPage> {
    const g = await checkUrl(item.url, deps.guard);
    if (!g.ok) return page(item, { outcome: "ssrf_blocked", error: g.reason });
    const decision = await robots.check(item.url);
    if (!decision.allowed) return page(item, { outcome: "robots_blocked" });
    if (!budget.check("MAX_FETCHES_PER_RUN", 1, "fetch")) throw new FetchBudgetExhausted();

    if (item.render && deps.renderer && budget.check("MAX_RENDERS_PER_RUN", 1, "fetch")) {
      return renderPage(item, decision.crawlDelayMs);
    }

    const validators = deps.validators?.get(item.url);
    const r = await gatedGet(item.url, decision.crawlDelayMs, true, validators);
    switch (r.kind) {
      case "ssrf_blocked":
        return page(item, { url: r.url, outcome: "ssrf_blocked", error: r.reason });
      case "robots_blocked":
        return page(item, { url: r.url, outcome: "robots_blocked" });
      case "too_large":
        return page(item, { url: r.url, http_status: r.status, outcome: "too_large" });
      case "timeout":
        return page(item, { url: r.url, outcome: "timeout", error: "timed out" });
      case "network_error":
        return page(item, { url: r.url, outcome: "network_error", error: r.message.slice(0, 500) });
      case "redirect_error":
        return page(item, { url: r.url, outcome: "client_error", error: r.message });
      case "response":
        break;
    }
    const base = {
      url: r.url,
      http_status: r.status,
      content_type: r.contentType,
      etag: r.etag,
      last_modified: r.lastModified,
    };
    const outcome = outcomeForStatus(r.status);
    if (outcome !== "ok") return page(item, { ...base, outcome });
    if (deps.validators && (r.etag || r.lastModified)) {
      deps.validators.set(item.url, { etag: r.etag, lastModified: r.lastModified });
    }
    if (isPdf(r.contentType, r.body)) {
      if (r.body.byteLength > MAX_PDF_BYTES) return page(item, { ...base, outcome: "too_large" });
      try {
        return page(item, { ...base, pdf_text: await deps.pdfText(r.body) });
      } catch (err) {
        return page(item, {
          ...base,
          outcome: "unsupported_type",
          error: `pdf: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        });
      }
    }
    if (!isHtmlLike(r.contentType, r.body)) {
      return page(item, { ...base, outcome: "unsupported_type" });
    }
    return page(item, { ...base, html: decodeBody(r.body, r.contentType) });
  }

  return { robots, fetchRaw, fetchPage };
}

// ---------------------------------------------------------------------------
// Running a plan: 8 hosts in parallel, one request at a time per host
// ---------------------------------------------------------------------------

export const PARALLEL_HOSTS = 8;

/** The guard's per-host meter, when the BudgetCheck is a BudgetGuard. */
interface HostMeter {
  checkHost(host: string, stage?: string): boolean;
}
function hasHostMeter(b: BudgetCheck): b is BudgetCheck & HostMeter {
  return typeof (b as Partial<HostMeter>).checkHost === "function";
}

export interface FetchAllResult {
  pages: FetchedPage[];
  /** Not fetched: MAX_FETCH_MINUTES, MAX_FETCHES_PER_RUN or the per-host cap. */
  deferred: FetchPlanItem[];
}

/**
 * Fetches every item: hosts in parallel (at most 8), each host's items in
 * order. Before each item it checks MAX_FETCH_MINUTES and the per-host cap;
 * when the fetch or time budget runs out every remaining item is deferred.
 */
/**
 * The longest one page may take, all in: robots, redirects, body, PDF text and a
 * render. Every step has its own limit (20 s fetch, 25 s render); this watchdog
 * catches a promise that never settles at all, which would otherwise leave
 * Node with nothing to wait on and end the process mid-run with exit code 0
 * (seen on the first local nightly run, 2026-10-03).
 */
export const PAGE_WATCHDOG_MS = 120_000;

class PageStalled extends Error {}

export async function fetchAll(
  items: readonly FetchPlanItem[],
  fetcher: PageFetcher,
  budget: BudgetCheck,
  opts: {
    parallelHosts?: number;
    pageTimeoutMs?: number;
    /** Called with the URL of a page the watchdog gave up on. */
    onStall?: (url: string) => void;
    /** Called after every page with (done, total). */
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<FetchAllResult> {
  const watchdogMs = opts.pageTimeoutMs ?? PAGE_WATCHDOG_MS;
  let done = 0;
  const guarded = (item: FetchPlanItem): Promise<FetchedPage> => {
    let timer: NodeJS.Timeout | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageStalled(item.url)), watchdogMs);
    });
    return Promise.race([fetcher.fetchPage(item, budget), stall]).finally(() => clearTimeout(timer));
  };
  const byHost = new Map<string, FetchPlanItem[]>();
  for (const it of items) {
    const list = byHost.get(it.host) ?? [];
    list.push(it);
    byHost.set(it.host, list);
  }
  const queues = [...byHost.values()];
  const pages: (FetchedPage | null)[] = new Array<FetchedPage | null>(items.length).fill(null);
  const index = new Map(items.map((it, i) => [it, i] as const));
  const deferred: FetchPlanItem[] = [];
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const queue = queues.shift();
      if (!queue) return;
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i] as FetchPlanItem;
        if (stopped || !budget.check("MAX_FETCH_MINUTES", 1, "fetch")) {
          stopped = true;
          deferred.push(...queue.slice(i));
          break;
        }
        if (hasHostMeter(budget) && !budget.checkHost(item.host, "fetch")) {
          deferred.push(...queue.slice(i));
          break;
        }
        try {
          pages[index.get(item) ?? 0] = await guarded(item);
          opts.onProgress?.(++done, items.length);
        } catch (err) {
          if (err instanceof PageStalled) {
            // The host gate is still held by the stuck request: defer the host's remaining pages.
            opts.onStall?.(item.url);
            deferred.push(...queue.slice(i));
            break;
          }
          if (err instanceof FetchBudgetExhausted) {
            stopped = true;
            deferred.push(...queue.slice(i));
            break;
          }
          throw err;
        }
      }
    }
  };
  const n = Math.max(1, Math.min(opts.parallelHosts ?? PARALLEL_HOSTS, queues.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { pages: pages.filter((p): p is FetchedPage => p !== null), deferred };
}
