import type { APIRoute } from "astro";
import { getDb } from "../lib/db.ts";
import { listToday } from "../lib/clock.ts";
import { cacheControl, TTL } from "../lib/cache.ts";
import { indexXml, latest, SITEMAP_KINDS, sitemapUrls, URLS_PER_SITEMAP, xmlResponse, type SitemapUrl } from "../lib/sitemap.ts";
import { absoluteUrl } from "../lib/urls.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  const db = getDb();
  const today = listToday();
  const entries: SitemapUrl[] = [];
  for (const kind of SITEMAP_KINDS) {
    const urls = await sitemapUrls(db, kind, today);
    if (urls.length === 0) continue;
    const files = Math.ceil(urls.length / URLS_PER_SITEMAP);
    for (let i = 0; i < files; i++) {
      const chunk = urls.slice(i * URLS_PER_SITEMAP, (i + 1) * URLS_PER_SITEMAP);
      const entry: SitemapUrl = { loc: absoluteUrl(`/sitemaps/${kind}-${i + 1}.xml`) };
      const lm = latest(chunk);
      if (lm) entry.lastmod = lm;
      entries.push(entry);
    }
  }
  return xmlResponse(indexXml(entries), cacheControl(TTL.sitemap));
};
