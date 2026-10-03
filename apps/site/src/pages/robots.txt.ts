import type { APIRoute } from "astro";
import { siteEnv } from "../lib/env.ts";

export const prerender = false;

export const GET: APIRoute = () => {
  const base = siteEnv().PUBLIC_SITE_URL.replace(/\/$/, "");
  const body = [
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /suggest",
    "",
    `Sitemap: ${base}/sitemap-index.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
