import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../stages/types.ts";
import {
  buildIrsDb,
  irsDbFileName,
  openIrsLookup,
  type IrsSource,
  type SqliteIrsLookup,
} from "./db.ts";
import { fileTextChunks, httpTextChunks, IRS_BMF_URLS, type HttpTextOptions } from "./download.ts";

export const IRS_FIXTURE_DB = "irs-fixture.sqlite";

export interface EnsureIrsOptions {
  ctx: Context;
  /** `.cache/irs` (the directory monthly.yml and nightly.yml cache as `irs-YYYY-MM`). */
  dir: string;
  mode: "dry-run" | "live";
  /** tests/fixtures/irs-subset.csv: the only source in a dry run. */
  fixturePath: string;
  /** Live download options (user agent, injected fetch for tests). */
  http?: HttpTextOptions;
  /** Called once per live download; return false to stop (MAX_FETCHES_PER_RUN). */
  allowFetch?: (url: string) => boolean;
}

export interface EnsureIrsResult {
  path: string;
  /** True when this call built the file; false when the cached month file was reused. */
  built: boolean;
  records: number;
  /** A previous month's file used because the download failed. */
  fallback: boolean;
  error: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function recordsIn(path: string): number {
  const l: SqliteIrsLookup = openIrsLookup(path);
  try {
    return Number(l.meta().records ?? 0);
  } finally {
    l.close();
  }
}

/** The newest `irs-YYYY-MM.sqlite` in `dir`, or null. */
export async function newestIrsDb(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const months = names.filter((n) => /^irs-\d{4}-\d{2}\.sqlite$/.test(n)).sort();
  const last = months.at(-1);
  return last ? join(dir, last) : null;
}

/**
 * Returns the IRS lookup database for this run, building it when missing
 * (SPEC.md 8.1 step 6, 12). A dry run always builds `irs-fixture.sqlite` from the
 * fixture CSV with no network. A live run reuses `irs-YYYY-MM.sqlite` for the
 * current month when the Actions cache restored it, otherwise downloads the four
 * regional BMF files and builds it; when that fails it falls back to the newest
 * earlier month and reports the error.
 */
export async function ensureIrsDb(o: EnsureIrsOptions): Promise<EnsureIrsResult> {
  if (o.mode === "dry-run") {
    const path = join(o.dir, IRS_FIXTURE_DB);
    const rep = await buildIrsDb(o.ctx, path, [
      { name: o.fixturePath, chunks: fileTextChunks(o.fixturePath) },
    ]);
    return { path, built: true, records: rep.records, fallback: false, error: null };
  }
  const path = join(o.dir, irsDbFileName(o.ctx.now));
  if (await exists(path)) {
    try {
      const records = recordsIn(path);
      if (records > 0) return { path, built: false, records, fallback: false, error: null };
    } catch (err) {
      o.ctx.log.warn("cached IRS database unreadable; rebuilding", { error: String(err) });
    }
  }
  if (!o.http) throw new Error("live IRS build needs http options (user agent)");
  const http = o.http;
  try {
    const sources: IrsSource[] = IRS_BMF_URLS.map((url) => {
      if (o.allowFetch && !o.allowFetch(url)) throw new Error(`fetch cap reached before ${url}`);
      return { name: url, chunks: httpTextChunks(url, http) };
    });
    const rep = await buildIrsDb(o.ctx, path, sources);
    return { path, built: true, records: rep.records, fallback: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const prev = await newestIrsDb(o.dir);
    if (prev && prev !== path) {
      o.ctx.log.warn("IRS download failed; using the previous month's database", {
        error: msg,
        prev,
      });
      return { path: prev, built: false, records: recordsIn(prev), fallback: true, error: msg };
    }
    throw err;
  }
}
