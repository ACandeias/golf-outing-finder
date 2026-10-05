import type { APIRoute } from "astro";
import { adsConfig } from "../lib/ads.ts";
import { siteEnv } from "../lib/env.ts";

export const prerender = false;

/** Crawlers re-read ads.txt about daily; a change of publisher id shows within a day. */
const CACHE_CONTROL = "public, max-age=86400";

/**
 * Generated from env (SPEC.md 9.1, 9.5). AdSense: the publisher line. Journey and
 * Raptive host the site's ads.txt and keep it current, so with
 * ADS_TXT_REDIRECT_URL set this route redirects there once (the IAB ads.txt spec
 * allows a single redirect to another domain). Nothing configured: an empty file.
 */
export const GET: APIRoute = () => {
  const txt = adsConfig(siteEnv()).adsTxt;
  if (txt.kind === "redirect") {
    return new Response(null, { status: 301, headers: { Location: txt.url, "Cache-Control": CACHE_CONTROL } });
  }
  return new Response(txt.lines.map((l) => `${l}\n`).join(""), {
    headers: { "content-type": "text/plain; charset=utf-8", "Cache-Control": CACHE_CONTROL },
  });
};
