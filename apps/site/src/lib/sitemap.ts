/** Sitemaps (SPEC.md 9.1, 9.4): indexable pages only, 45,000 URLs per file. */
import {
  sitemapCharityCities,
  sitemapCities,
  sitemapCourses,
  sitemapOrganizers,
  sitemapOutings,
  sitemapStatesCurrent,
  type GofDb,
} from "@gof/db/queries";
import { absoluteUrl, charityCityPath, cityPath, statePath } from "./urls.ts";

export const URLS_PER_SITEMAP = 45_000;

export const SITEMAP_KINDS = ["pages", "states", "cities", "charity-cities", "courses", "organizers", "outings"] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** Every indexable URL of one kind. */
export async function sitemapUrls(db: GofDb, kind: SitemapKind, today: string): Promise<SitemapUrl[]> {
  switch (kind) {
    case "pages":
      return ["/", "/golf-outings", "/about"].map((p) => ({ loc: absoluteUrl(p) }));
    case "states":
      return (await sitemapStatesCurrent(db, today)).map((r) => ({ loc: absoluteUrl(statePath(r.state)), lastmod: r.lastmod }));
    case "cities":
      return (await sitemapCities(db, today)).map((r) => ({ loc: absoluteUrl(cityPath(r.state, r.city)), lastmod: r.lastmod }));
    case "charity-cities":
      return (await sitemapCharityCities(db, today)).map((r) => ({
        loc: absoluteUrl(charityCityPath(r.state, r.city)),
        lastmod: r.lastmod,
      }));
    case "courses":
      return (await sitemapCourses(db)).map((r) => ({ loc: absoluteUrl(r.path), lastmod: r.lastmod }));
    case "organizers":
      return (await sitemapOrganizers(db)).map((r) => ({ loc: absoluteUrl(r.path), lastmod: r.lastmod }));
    case "outings":
      return (await sitemapOutings(db)).map((r) => ({ loc: absoluteUrl(r.path), lastmod: r.lastmod }));
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** W3C date for lastmod; drops anything unparseable. */
function lastmod(v: string | undefined): string | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function urlsetXml(urls: readonly SitemapUrl[]): string {
  const body = urls
    .map((u) => {
      const lm = lastmod(u.lastmod);
      return `  <url><loc>${xmlEscape(u.loc)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function indexXml(entries: readonly SitemapUrl[]): string {
  const body = entries
    .map((e) => {
      const lm = lastmod(e.lastmod);
      return `  <sitemap><loc>${xmlEscape(e.loc)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

export function latest(urls: readonly SitemapUrl[]): string | undefined {
  let best: string | undefined;
  for (const u of urls) if (u.lastmod && (!best || u.lastmod > best)) best = u.lastmod;
  return best;
}

export function xmlResponse(xml: string, cacheControl: string): Response {
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": cacheControl, "x-robots-tag": "noindex" },
  });
}
