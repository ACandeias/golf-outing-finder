import type { APIRoute } from "astro";
import { z } from "zod";
import { getDb } from "../../lib/db.ts";
import { listToday } from "../../lib/clock.ts";
import { cacheControl, TTL } from "../../lib/cache.ts";
import { SITEMAP_KINDS, sitemapUrls, URLS_PER_SITEMAP, urlsetXml, xmlResponse } from "../../lib/sitemap.ts";

export const prerender = false;

const fileParam = z
  .string()
  .max(40)
  .regex(/^([a-z-]+)-(\d{1,4})$/)
  .transform((s) => {
    const m = /^([a-z-]+)-(\d{1,4})$/.exec(s);
    return { kind: m?.[1] ?? "", page: Number(m?.[2] ?? 0) };
  })
  .pipe(z.object({ kind: z.enum(SITEMAP_KINDS), page: z.number().int().min(1) }));

export const GET: APIRoute = async ({ params }) => {
  const parsed = fileParam.safeParse(params.file);
  if (!parsed.success) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  const { kind, page } = parsed.data;
  const urls = await sitemapUrls(getDb(), kind, listToday());
  const chunk = urls.slice((page - 1) * URLS_PER_SITEMAP, page * URLS_PER_SITEMAP);
  if (chunk.length === 0) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  return xmlResponse(urlsetXml(chunk), cacheControl(TTL.sitemap));
};
