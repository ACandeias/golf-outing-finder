import type { GuardReason } from "../net/ssrf.ts";

/**
 * One guarded GET (SPEC.md 8.3): manual redirects (at most 5, each vetted
 * again), a 20 s overall timeout, a 5 MB body cap, no cookies (we never send or
 * store one), and conditional headers when validators are known. The `fetch`
 * implementation is injected: undici's fetch with a guarded dispatcher in live
 * runs, a fixture server in tests and dry runs.
 */

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface FetchInit {
  method: "GET";
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
}
/** The subset of WHATWG fetch we use. */
export type FetchFn = (url: string, init: FetchInit) => Promise<Response>;

/** Vets a URL before each hop (SSRF guard, then robots.txt). Null means go ahead. */
export type Vet = (
  url: string,
) => Promise<null | { kind: "ssrf"; reason: GuardReason } | { kind: "robots" }>;

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface HttpOptions {
  fetchFn: FetchFn;
  vet: Vet;
  userAgent: string;
  accept?: string;
  validators?: Validators;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export type HttpResult =
  | {
      kind: "response";
      status: number;
      url: string;
      contentType: string | null;
      etag: string | null;
      lastModified: string | null;
      body: Uint8Array;
    }
  | { kind: "ssrf_blocked"; url: string; reason: GuardReason }
  | { kind: "robots_blocked"; url: string }
  | { kind: "too_large"; url: string; status: number }
  | { kind: "timeout"; url: string }
  | { kind: "network_error"; url: string; message: string }
  | { kind: "redirect_error"; url: string; message: string };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class TooLarge extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function httpGet(startUrl: string, o: HttpOptions): Promise<HttpResult> {
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_BODY_BYTES;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let url = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      const v = await o.vet(url);
      if (v?.kind === "ssrf") return { kind: "ssrf_blocked", url, reason: v.reason };
      if (v?.kind === "robots") return { kind: "robots_blocked", url };
      const headers: Record<string, string> = {
        "user-agent": o.userAgent,
        accept: o.accept ?? "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.8",
      };
      if (hop === 0 && o.validators?.etag) headers["if-none-match"] = o.validators.etag;
      if (hop === 0 && o.validators?.lastModified) {
        headers["if-modified-since"] = o.validators.lastModified;
      }
      let res: Response;
      try {
        res = await o.fetchFn(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (timedOut) return { kind: "timeout", url };
        const message = err instanceof Error ? err.message : String(err);
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
        if (cause?.name === "SsrfBlockedError" || /SSRF guard/.test(message)) {
          return { kind: "ssrf_blocked", url, reason: "private_address" };
        }
        return { kind: "network_error", url, message: cause ? `${message}: ${cause.message}` : message };
      }
      if (REDIRECTS.has(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return { kind: "redirect_error", url, message: `HTTP ${res.status} without Location` };
        if (hop >= maxRedirects) {
          return { kind: "redirect_error", url, message: `more than ${maxRedirects} redirects` };
        }
        try {
          const next = new URL(loc, url);
          next.hash = "";
          url = next.toString();
        } catch {
          return { kind: "redirect_error", url, message: "unparseable Location" };
        }
        continue;
      }
      let body: Uint8Array;
      try {
        body = await readCapped(res, maxBytes);
      } catch (err) {
        if (err instanceof TooLarge) return { kind: "too_large", url, status: res.status };
        if (timedOut) return { kind: "timeout", url };
        return { kind: "network_error", url, message: err instanceof Error ? err.message : String(err) };
      }
      return {
        kind: "response",
        status: res.status,
        url,
        contentType: res.headers.get("content-type"),
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        body,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Decodes an HTML body: charset from Content-Type, else a <meta> in the first 2 KB, else UTF-8. */
export function decodeBody(body: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  let label = fromHeader;
  if (!label) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
