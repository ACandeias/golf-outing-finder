/**
 * Sitemaps (SPEC.md 9.1, 9.4, G3): an index of child sitemaps, children with only
 * indexable URLs, and every listed URL serving 200 with a canonical equal to itself.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, siteOrigin, test } from "./support/fixtures.ts";
import { canonicals, isNoindex, sitemapLocs } from "./support/html.ts";
import {
  COURSE_SLUGS_WITH_OUTINGS,
  EMPTY_COURSE_SLUGS,
  HELD_E17_ORGANIZER,
  HELD_E17_SLUG,
  PUBLISHED_ORGANIZER_SLUGS,
  PUBLISHED_OUTING_SLUGS,
  STATES_WITH_OUTINGS,
} from "./support/seed-facts.ts";

const MAX_URLS_PER_FILE = 45_000;
const STATIC_PATHS = new Set(["/", "/golf-outings", "/about"]);

async function childSitemaps(request: APIRequestContext): Promise<{ loc: string; xml: string }[]> {
  const res = await request.get("/sitemap-index.xml");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"] ?? "").toMatch(/xml/);
  const xml = await res.text();
  expect(xml).toContain("<sitemapindex");
  const locs = sitemapLocs(xml);
  const out: { loc: string; xml: string }[] = [];
  for (const loc of locs) {
    const child = await request.get(new URL(loc).pathname);
    expect(child.status(), loc).toBe(200);
    out.push({ loc, xml: await child.text() });
  }
  return out;
}

async function allUrls(request: APIRequestContext): Promise<string[]> {
  return (await childSitemaps(request)).flatMap((c) => sitemapLocs(c.xml));
}

test("the sitemap index lists child sitemaps under /sitemaps/", async ({ request, baseURL }) => {
  // 9.1: "/sitemap-index.xml, /sitemaps/*.xml ... generated from D1"; 9.4: "split by type".
  const origin = siteOrigin(baseURL);
  const children = await childSitemaps(request);
  expect(children.length).toBeGreaterThanOrEqual(2);
  for (const { loc, xml } of children) {
    expect(new URL(loc).origin).toBe(origin);
    expect(new URL(loc).pathname).toMatch(/^\/sitemaps\/[a-z0-9-]+\.xml$/);
    expect(xml).toContain("<urlset");
    const urls = sitemapLocs(xml);
    // 9.1: "45,000 URLs per file at most".
    expect(urls.length).toBeLessThanOrEqual(MAX_URLS_PER_FILE);
    // 9.4: "lastmod from updated_at": every URL backed by D1 rows carries one; the
    // static pages (home, hub, about) have no updated_at to report.
    for (const entry of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
      const path = new URL(sitemapLocs(entry)[0] ?? origin).pathname;
      if (STATIC_PATHS.has(path)) continue;
      expect(entry, `${path} has a lastmod`).toMatch(
        /<lastmod>\s*\d{4}-\d{2}-\d{2}[^<]*<\/lastmod>/,
      );
    }
  }
});

test("children list exactly the indexable outings, courses, organizers and states", async ({
  request,
  baseURL,
}) => {
  // 9.4: "Only indexable pages appear". 9.1: outings "when published and source_gone = 0,
  // including expected outings"; courses "when outing_count >= 1"; organizers "when it
  // has a published outing".
  const origin = siteOrigin(baseURL);
  const urls = await allUrls(request);
  const paths = urls.map((u) => new URL(u).pathname);
  expect(new Set(urls).size, "no duplicate URLs").toBe(urls.length);

  const outings = paths
    .filter((p) => p.startsWith("/outings/"))
    .map((p) => p.slice("/outings/".length));
  expect(outings.sort()).toEqual([...PUBLISHED_OUTING_SLUGS].sort());
  expect(outings).not.toContain(HELD_E17_SLUG);

  const courses = paths
    .filter((p) => p.startsWith("/courses/"))
    .map((p) => p.slice("/courses/".length));
  expect(courses.sort()).toEqual([...COURSE_SLUGS_WITH_OUTINGS].sort());
  for (const empty of EMPTY_COURSE_SLUGS) expect(courses).not.toContain(empty);

  const organizers = paths
    .filter((p) => p.startsWith("/organizers/"))
    .map((p) => p.slice("/organizers/".length));
  expect(organizers.sort()).toEqual([...PUBLISHED_ORGANIZER_SLUGS].sort());
  expect(organizers).not.toContain(HELD_E17_ORGANIZER);

  const states = paths.filter((p) => /^\/golf-outings\/[a-z]{2}$/.test(p)).map((p) => p.slice(-2));
  expect(states.sort()).toEqual([...STATES_WITH_OUTINGS].sort());

  // City pages with an upcoming or recent outing (9.1), and their charity twins.
  for (const p of [
    "/golf-outings/ny/mamaroneck",
    "/golf-outings/ny/white-plains",
    "/golf-outings/az/phoenix",
    "/golf-outings/ca/la-jolla",
  ]) {
    expect(paths).toContain(p);
  }
  expect(paths).toContain("/charity-golf-tournaments/ny/mamaroneck");
  expect(paths).not.toContain("/golf-outings/ny/scarsdale");

  // G3: "every indexable page has a canonical URL and a sitemap entry": the home page,
  // the national hub and /about are indexed (9.1).
  for (const p of ["/", "/golf-outings", "/about"]) expect(paths, p).toContain(p);

  // Never filtered URLs, never unindexed routes.
  for (const u of urls) {
    expect(u.startsWith(origin), u).toBe(true);
    expect(u, "no query strings in sitemaps").not.toContain("?");
    expect(new URL(u).pathname).not.toMatch(
      /^\/(map|api|suggest|health|privacy|terms|corrections|bot|listed)(\/|$)/,
    );
  }
});

test("every sitemap URL returns 200, is indexable and is its own canonical", async ({
  request,
}) => {
  test.setTimeout(180_000);
  // G3 and 9.4: canonical on every page; sitemaps hold only indexable pages.
  const urls = await allUrls(request);
  const failures: string[] = [];
  const queue = [...urls];
  const worker = async (): Promise<void> => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      const res = await request.get(new URL(u).pathname);
      if (res.status() !== 200) {
        failures.push(`${u}: HTTP ${res.status()}`);
        continue;
      }
      const html = await res.text();
      const canon = canonicals(html);
      if (canon.length !== 1 || canon[0] !== u)
        failures.push(`${u}: canonical ${JSON.stringify(canon)}`);
      if (isNoindex(html, res.headers()["x-robots-tag"])) failures.push(`${u}: noindex`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  expect(failures).toEqual([]);
});
