import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SerpProvider } from "@gof/shared/env";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { createListingSource, loadPlatforms } from "../discovery/sources.ts";
import { PATHS } from "../lib/paths.ts";
import { guardedLookup, systemResolver, type GuardOptions } from "../net/ssrf.ts";
import { createRenderer, launchChromium, type Renderer } from "../render/renderer.ts";
import { createDataForSeoAdapter, type BatchSerpAdapter, type HttpJson } from "../serp/dataforseo.ts";
import { createFixtureSerpAdapter } from "../serp/fixture.ts";
import type { Context, ListingSource, SerpAdapter } from "../stages/types.ts";
import { createPageFetcher, userAgentFor, type GuardedPageFetcher, type ValidatorStore } from "./fetcher.ts";
import { fixtureFetch, fixtureResolver, loadFixtureDocs, type FixtureDoc } from "./fixture-fetch.ts";
import type { FetchFn } from "./http.ts";
import { pdfText } from "./pdf.ts";

/**
 * Builds the fetch-side edges once per run (workstream B): the guarded page
 * fetcher (with its robots cache and host gate), the renderer, the listing
 * source and the SERP adapter. A dry run gets fixture-backed versions that
 * never touch the network: recorded pages, a fixed public address for every
 * host, no host spacing, and the fixture SERP adapter.
 */

export interface FetchSidePorts {
  fetcher: GuardedPageFetcher;
  renderer: Renderer | null;
  listings: ListingSource;
  serp: SerpAdapter | BatchSerpAdapter;
  validators: ValidatorStore & { save(): void };
  close(): Promise<void>;
  /** `--prioritize-states`: searched tonight and first (see planSearch). */
  prioritizeStates?: readonly string[];
}

export interface FetchSideOptions {
  /** Live SERP provider (default dataforseo). A dry run always uses the fixture adapter. */
  serp?: SerpProvider;
  /** The adapter for `claude-search`, built by the caller (src/run/wire.ts) so it can report usage. */
  serpAdapter?: BatchSerpAdapter;
}

const VALIDATORS_FILE = join(PATHS.cache, "http-validators.json");
const validatorsSchema = z.record(
  z.object({ etag: z.string().nullable().optional(), lastModified: z.string().nullable().optional() }),
);

/** ETag/Last-Modified by URL, kept in .cache between runs (restored by the Actions cache when present). */
export function fileValidatorStore(path: string | null): ValidatorStore & { save(): void } {
  let data: z.infer<typeof validatorsSchema> = {};
  if (path && existsSync(path)) {
    const parsed = validatorsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) data = parsed.data;
  }
  return {
    get: (u) => data[u],
    set: (u, v) => {
      data[u] = v;
    },
    save: () => {
      if (!path) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data));
    },
  };
}

/** Serves fixture HTML as if Chromium had rendered it (the fetcher has already vetted the URL). */
function fixtureRenderer(docs: ReadonlyMap<string, FixtureDoc>): Renderer {
  return {
    async render(url) {
      const doc = docs.get(url);
      if (!doc) return { status: 404, finalUrl: url, html: "<html><body></body></html>" };
      return { status: doc.status, finalUrl: url, html: doc.body };
    },
    async close() {},
  };
}

function undiciGuardedFetch(): FetchFn {
  // Connect-time DNS check: the socket only ever opens to an address the guard accepts.
  const agent = new Agent({
    connect: { lookup: guardedLookup(systemResolver), timeout: 10_000 },
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  });
  return async (url, init) =>
    (await undiciFetch(url, { ...init, dispatcher: agent })) as unknown as Response;
}

const dataForSeoHttp: HttpJson = async (url, init) => {
  const res = await undiciFetch(url, init);
  return { status: res.status, json: (await res.json()) as unknown };
};

/** `pnpm run pipeline` sets PUBLIC_SITE_URL in CI; locally the dev URL stands in. */
function siteUrl(env: Readonly<Record<string, string | undefined>>): string {
  const v = env.PUBLIC_SITE_URL;
  if (v && /^https?:\/\//.test(v)) return v;
  if (env.NODE_ENV === "production") throw new Error("PUBLIC_SITE_URL is required for the crawler user agent");
  return "http://localhost:8787";
}

function missingAdapter(name: string): never {
  throw new Error(`--serp=${name} needs its adapter (built in src/run/wire.ts)`);
}

export async function createFetchSidePorts(
  ctx: Context,
  mode: "dry-run" | "live",
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: FetchSideOptions = {},
): Promise<FetchSidePorts> {
  const startMs = ctx.clock.nowMs();
  const nowIso = (): string =>
    new Date(ctx.now.getTime() + Math.max(0, Math.round(ctx.clock.nowMs() - startMs))).toISOString();
  const userAgent = userAgentFor(siteUrl(env));
  const config = await loadPlatforms(PATHS.overrides);

  if (mode === "dry-run") {
    const docs = loadFixtureDocs();
    const guard: GuardOptions = { resolver: fixtureResolver, exclusions: ctx.overrides.exclusions };
    const renderer = fixtureRenderer(docs);
    const validators = fileValidatorStore(null);
    const fetcher = createPageFetcher({
      fetchFn: fixtureFetch(docs).fetchFn,
      guard,
      userAgent,
      clock: ctx.clock,
      nowIso,
      pdfText,
      renderer,
      validators,
      hostSpacingMs: 0,
      sleep: async () => {},
    });
    return {
      fetcher,
      renderer,
      validators,
      listings: createListingSource({
        fetcher,
        config,
        series: ctx.overrides.series,
        registrationHosts: ctx.overrides.registrationHosts,
        now: ctx.now,
        log: ctx.log,
      }),
      serp: createFixtureSerpAdapter(),
      close: async () => {},
    };
  }

  const guard: GuardOptions = { resolver: systemResolver, exclusions: ctx.overrides.exclusions };
  const renderer = createRenderer({ launch: launchChromium, guard, userAgent });
  const validators = fileValidatorStore(VALIDATORS_FILE);
  const fetcher = createPageFetcher({
    fetchFn: undiciGuardedFetch(),
    guard,
    userAgent,
    clock: ctx.clock,
    nowIso,
    pdfText,
    renderer,
    validators,
  });
  const credentials = env.SERP_API_KEY;
  const provider = opts.serp ?? "dataforseo";
  const serp: BatchSerpAdapter = provider === "claude-search"
    ? (opts.serpAdapter ?? missingAdapter("claude-search"))
    : provider === "fixture"
      ? createFixtureSerpAdapter()
      : credentials
    ? createDataForSeoAdapter({
        credentials,
        http: dataForSeoHttp,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      })
    : {
        async search() {
          return [];
        },
        async searchMany(queries) {
          if (queries.length > 0) ctx.log.warn("SERP_API_KEY is not set; search discovery skipped");
          return [];
        },
      };
  return {
    fetcher,
    renderer,
    validators,
    listings: createListingSource({
      fetcher,
      config,
      series: ctx.overrides.series,
      registrationHosts: ctx.overrides.registrationHosts,
      now: ctx.now,
      log: ctx.log,
    }),
    serp,
    close: async () => {
      validators.save();
      await renderer.close();
    },
  };
}
