/**
 * Small, dependency-free readers for server-rendered HTML. The suite checks the
 * HTML the Worker sends (what crawlers see), so these work on response bodies
 * rather than on the live DOM.
 */

/** Attributes of every start tag named `tag`, lowercased names. */
export function tagsWithAttrs(html: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  for (const m of html.matchAll(re)) out.push(parseAttrs(m[1] ?? ""));
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** `<link rel="canonical">` hrefs (SPEC.md 9.4: exactly one per page). */
export function canonicals(html: string): string[] {
  return tagsWithAttrs(html, "link")
    .filter((a) => (a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))
    .map((a) => a.href ?? "");
}

/** Content of every `<meta name="robots">`. */
export function robotsMeta(html: string): string[] {
  return tagsWithAttrs(html, "meta")
    .filter((a) => (a.name ?? "").toLowerCase() === "robots")
    .map((a) => (a.content ?? "").toLowerCase());
}

export function isNoindex(html: string, xRobotsTag?: string | null): boolean {
  const header = (xRobotsTag ?? "").toLowerCase();
  return robotsMeta(html).some((c) => c.includes("noindex")) || header.includes("noindex");
}

/** Raw text of every `<script type="application/ld+json">` block. */
export function jsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = parseAttrs(m[1] ?? "");
    if ((attrs.type ?? "").toLowerCase() === "application/ld+json") out.push(m[2] ?? "");
  }
  return out;
}

/** The HTML with `<script>` and `<style>` bodies removed: the markup that renders as text. */
export function withoutScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

/** `<title>` text, entities decoded. */
export function titleOf(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return decodeEntities((m?.[1] ?? "").trim());
}

/** Every `<loc>` in a sitemap or sitemap index. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeEntities(m[1] ?? ""));
}
