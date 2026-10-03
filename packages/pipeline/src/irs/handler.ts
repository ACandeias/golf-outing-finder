import { join } from "node:path";
import { PATHS, REPO_ROOT } from "../lib/paths.ts";
import type { HandlerOutcome, StageHandler } from "../run/handlers.ts";
import { emptyResult } from "../stages/types.ts";
import type { FetchFn } from "./download.ts";
import { ensureIrsDb } from "./ensure.ts";

/** `.cache/irs`, the path monthly.yml and nightly.yml cache under `irs-YYYY-MM`. */
export const IRS_CACHE_DIR = join(PATHS.cache, "irs");
export const IRS_FIXTURE_CSV = join(REPO_ROOT, "tests/fixtures/irs-subset.csv");

export interface IrsHandlerDeps {
  dir?: string;
  fixturePath?: string;
  userAgent?: string;
  fetch?: FetchFn;
}

function botUserAgent(): string {
  const site = process.env.PUBLIC_SITE_URL ?? "http://localhost:8787";
  return `GolfOutingFinderBot/1.0 (+${site.replace(/\/$/, "")}/bot)`;
}

/**
 * The monthly `irs` stage edge (SPEC.md 8.1 step 6): makes sure this month's
 * IRS lookup database exists, downloading and rebuilding it when the Actions
 * cache had none. Each regional file counts as one fetch against
 * MAX_FETCHES_PER_RUN. A dry run builds the fixture database offline.
 */
export function irsHandler(deps: IrsHandlerDeps = {}): StageHandler {
  return async ({ ctx, guard, mode }): Promise<HandlerOutcome> => {
    const result = emptyResult();
    const res = await ensureIrsDb({
      ctx,
      dir: deps.dir ?? IRS_CACHE_DIR,
      mode,
      fixturePath: deps.fixturePath ?? IRS_FIXTURE_CSV,
      http: {
        userAgent: deps.userAgent ?? botUserAgent(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      },
      allowFetch: () => guard.check("MAX_FETCHES_PER_RUN", 1, "irs"),
    });
    result.counters.irs_records = res.records;
    if (res.error) result.errors.push({ stage: "irs", kind: "network", message: res.error });
    ctx.log.info(res.built ? "IRS lookup database built" : "IRS lookup database reused", {
      path: res.path,
      records: res.records,
      fallback: res.fallback,
    });
    return { result };
  };
}
