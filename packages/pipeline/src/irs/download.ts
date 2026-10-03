import { createReadStream } from "node:fs";

/**
 * Sources for the IRS Exempt Organizations Business Master File extract
 * (https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf,
 * checked 2026-10-03: updated monthly, 1,964,958 records on 2026-09-08). The four
 * regional files cover every US state and DC; the international (eo_xx) and
 * Puerto Rico (eo_pr) files are left out because outings are US-only.
 */
export const IRS_BMF_URLS = [
  "https://www.irs.gov/pub/irs-soi/eo1.csv",
  "https://www.irs.gov/pub/irs-soi/eo2.csv",
  "https://www.irs.gov/pub/irs-soi/eo3.csv",
  "https://www.irs.gov/pub/irs-soi/eo4.csv",
] as const;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpTextOptions {
  userAgent: string;
  fetch?: FetchFn;
  /** Largest body accepted; the regional files are each well under this. */
  maxBytes?: number;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Streams a public https file as text chunks with our user agent, a timeout and
 * a size cap. Retries the request (not a half-read body) on network errors, 429
 * and 5xx.
 */
export async function* httpTextChunks(url: string, opts: HttpTextOptions): AsyncGenerator<string> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`refusing non-https download: ${url}`);
  const doFetch: FetchFn = opts.fetch ?? ((x, init) => fetch(x, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let a = 0; a < attempts && !res; a++) {
    if (a > 0) await sleep(30_000 * a);
    try {
      const r = await doFetch(u.toString(), {
        headers: { "user-agent": opts.userAgent, accept: "text/csv,text/plain,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20 * 60_000),
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`GET ${url}: HTTP ${r.status}`);
        continue;
      }
      if (!r.ok || !r.body) throw new Error(`GET ${url}: HTTP ${r.status}`);
      res = r;
    } catch (err) {
      if (err instanceof Error && /HTTP \d+/.test(err.message)) throw err;
      lastErr = err;
    }
  }
  if (!res?.body) throw lastErr instanceof Error ? lastErr : new Error(`GET ${url} failed`);
  const max = opts.maxBytes ?? 1024 * 1024 * 1024;
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw new Error(`GET ${url}: over ${max} bytes`);
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** A local CSV file as text chunks (the test fixture and dry runs). */
export async function* fileTextChunks(path: string): AsyncGenerator<string> {
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    yield String(chunk);
  }
}
