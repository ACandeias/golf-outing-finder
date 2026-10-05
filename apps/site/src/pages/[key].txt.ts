import type { APIRoute } from "astro";
import { siteEnv } from "../lib/env.ts";
import { cacheControl, TTL } from "../lib/cache.ts";

export const prerender = false;

/**
 * IndexNow key file (SPEC.md 9.1): `/{INDEXNOW_KEY}.txt` returns the key so search
 * engines can verify the pipeline's pings (packages/pipeline/src/indexnow). Any other
 * `/*.txt` is a 404. Static routes (robots.txt, ads.txt) outrank this dynamic one.
 */
export const GET: APIRoute = ({ params }) => {
  let key: string | undefined;
  try {
    key = siteEnv().INDEXNOW_KEY;
  } catch {
    key = undefined;
  }
  if (!key || params.key !== key) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(key, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cacheControl(TTL.keyFile), "x-robots-tag": "noindex" },
  });
};
