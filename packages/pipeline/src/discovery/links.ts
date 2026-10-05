import { parseHTML } from "linkedom";
import { normalizeUrl } from "./url.ts";

/** Pure parsers for listing pages and sitemaps (SPEC.md 8.2 items 3 to 6). */

export interface PageLink {
  url: string;
  /** Anchor text, whitespace collapsed, at most 300 characters. */
  text: string;
}

interface AnchorLike {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/** Every distinct http(s) link on the page, normalized, with its anchor text. */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const { document } = parseHTML(html);
  const baseHref = (document.querySelector("base[href]") as AnchorLike | null)?.getAttribute("href");
  let base = baseUrl;
  if (baseHref) base = normalizeUrl(baseHref, baseUrl) ?? baseUrl;
  const out: PageLink[] = [];
  const seen = new Map<string, PageLink>();
  for (const node of Array.from(document.querySelectorAll("a[href]"))) {
    const a = node as unknown as AnchorLike;
    const url = normalizeUrl(a.getAttribute("href") ?? "", base);
    if (url === null) continue;
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const prev = seen.get(url);
    if (prev) {
      if (prev.text === "" && text !== "") prev.text = text;
      continue;
    }
    const link = { url, text };
    seen.set(url, link);
    out.push(link);
  }
  return out;
}

export interface Sitemap {
  /** Page URLs from a `<urlset>`. */
  urls: string[];
  /** Child sitemaps from a `<sitemapindex>`. */
  sitemaps: string[];
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/** Reads `<loc>` entries from a sitemap or sitemap index (no DTDs, no entities beyond the five). */
export function parseSitemap(xml: string): Sitemap {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const url = normalizeUrl(decodeXml(m[1] ?? ""));
    if (url !== null) locs.push(url);
  }
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

/** Navigation and account paths a series index links to that are never events. */
const NAV_PATH =
  /\/(privacy|terms|legal|login|log-in|signin|sign-in|signup|register-account|account|cart|checkout|contact|about|careers|jobs|news|blog|press|search|donate|shop|faq|help|sitemap|wp-admin|wp-login|feed|tag|category|author)(\/|$|\?)/i;

/** Heuristic for series index pages: an event-like link, not navigation. */
export function looksLikeEventLink(link: PageLink, indexUrl: string): boolean {
  if (link.url === normalizeUrl(indexUrl)) return false;
  let path: string;
  let host: string;
  let indexHost: string;
  try {
    const u = new URL(link.url);
    path = u.pathname;
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    indexHost = new URL(indexUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (NAV_PATH.test(path)) return false;
  // A site root is navigation on the index's own host, but a per-event site on
  // another host or subdomain (ACS: akroncanton.acsgolf.org).
  if (path === "/") {
    if (host === indexHost) return false;
    return /event|golf|classic|tournament|outing|invitational|scramble/i.test(`${host} ${link.text}`);
  }
  return /event|golf|classic|tournament|outing|invitational|scramble/i.test(`${path} ${link.text}`);
}
