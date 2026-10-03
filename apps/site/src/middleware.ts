import { defineMiddleware } from "astro:middleware";
import { siteEnv } from "./lib/env.ts";
import { SECURITY_HEADERS } from "./lib/security.ts";

/** Paths that keep their exact spelling (files with their own names). */
const KEEP_PATH = /^\/(_astro|_image)\//;

function withHeaders(res: Response): Response {
  let out = res;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  } catch {
    // Immutable headers (a fetched or cached response): copy it.
    out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  }
  return out;
}

/**
 * The Workers Cache API, when it does something: it is a no-op on workers.dev and
 * only works on a custom domain (SPEC.md 3). It is also skipped outside production
 * so local runs and e2e tests always render fresh with their pinned clock.
 */
function edgeCache(): Cache | null {
  try {
    if (siteEnv().NODE_ENV !== "production") return null;
    const c = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;

  // One URL policy: lowercase, no trailing slash (except "/"). 301 to it.
  if (!KEEP_PATH.test(url.pathname)) {
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
    if (/[A-Z]/.test(path)) path = path.toLowerCase();
    if (path !== url.pathname) {
      return withHeaders(
        new Response(null, { status: 301, headers: { Location: `${path}${url.search}`, "Cache-Control": "public, max-age=3600" } }),
      );
    }
  }

  const cache = request.method === "GET" ? edgeCache() : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return withHeaders(hit);
  }

  const res = withHeaders(await next());

  const cc = res.headers.get("Cache-Control") ?? "";
  if (cache && res.status === 200 && /s-maxage=\d+/.test(cc) && !res.headers.has("Set-Cookie")) {
    const copy = res.clone();
    const put = cache.put(request, copy).catch(() => undefined);
    context.locals.cfContext?.waitUntil(put);
  }
  return res;
});
