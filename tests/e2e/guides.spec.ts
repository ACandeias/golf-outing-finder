/**
 * Guides, IndexNow and site verification (SPEC.md 9.1, 9.4, 9.8, 13 Phase 3).
 *
 * The e2e build includes drafts (NODE_ENV=development, see global-setup.ts): draft
 * pages render with noindex, and sitemaps list published guides only, whatever the
 * build. The expectations follow the guides on disk (support/guide-facts.ts).
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, linkPaths, siteOrigin, test } from "./support/fixtures.ts";
import { canonicals, isNoindex, sitemapLocs, tagsWithAttrs, titleOf } from "./support/html.ts";
import {
  DRAFT_GUIDES,
  E2E_BING_VERIFICATION,
  E2E_GOOGLE_VERIFICATION,
  E2E_INDEXNOW_KEY,
  GUIDES,
  PUBLISHED_GUIDES,
} from "./support/guide-facts.ts";
import { NKF_WINGED_FOOT } from "./support/seed-facts.ts";

async function sitemapPaths(request: APIRequestContext): Promise<string[]> {
  const index = await request.get("/sitemap-index.xml");
  expect(index.status()).toBe(200);
  const paths: string[] = [];
  for (const loc of sitemapLocs(await index.text())) {
    const child = await request.get(new URL(loc).pathname);
    expect(child.status(), loc).toBe(200);
    paths.push(...sitemapLocs(await child.text()).map((u) => new URL(u).pathname));
  }
  return paths;
}

function metaContent(html: string, name: string): string[] {
  return tagsWithAttrs(html, "meta")
    .filter((a) => (a.name ?? "").toLowerCase() === name.toLowerCase())
    .map((a) => a.content ?? "");
}

test.describe("guide pages", () => {
  for (const g of GUIDES) {
    test(`${g.path} renders with its title, canonical and breadcrumbs`, async ({ page, request, baseURL }) => {
      const res = await request.get(g.path);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(canonicals(html)).toEqual([`${siteOrigin(baseURL)}${g.path}`]);
      expect(titleOf(html)).toContain(g.title);
      // 9.8: drafts are not indexed; published guides are.
      expect(isNoindex(html, res.headers()["x-robots-tag"]), "noindex iff draft").toBe(g.draft);

      await page.goto(g.path);
      // The page renders the title as the only H1; the body uses ## and ### only.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(g.title);
      await expect(page.locator("main h1")).toHaveCount(1);
      const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(crumbs.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/guides");
      // Our own Markdown, rendered by Astro: still no scripts inside the article.
      await expect(page.locator("article script")).toHaveCount(0);
    });
  }

  test("a draft guide is noindex and not in any sitemap", async ({ request }) => {
    test.skip(DRAFT_GUIDES.length === 0, "no draft guides in seed/guides");
    const paths = await sitemapPaths(request);
    for (const g of DRAFT_GUIDES) {
      const res = await request.get(g.path);
      expect(res.status(), g.path).toBe(200);
      expect(isNoindex(await res.text(), res.headers()["x-robots-tag"]), g.path).toBe(true);
      expect(paths, g.path).not.toContain(g.path);
    }
  });

  test("sitemaps list exactly the published guides, and /guides once one is published", async ({ request }) => {
    const paths = await sitemapPaths(request);
    const guidePaths = paths.filter((p) => p.startsWith("/guides/")).sort();
    expect(guidePaths).toEqual(PUBLISHED_GUIDES.map((g) => g.path).sort());
    expect(paths.includes("/guides")).toBe(PUBLISHED_GUIDES.length > 0);
  });

  test("the guides index lists every guide this build renders", async ({ request, page }) => {
    const res = await request.get("/guides");
    expect(res.status()).toBe(200);
    const html = await res.text();
    // Indexed only once a guide is published.
    expect(isNoindex(html, res.headers()["x-robots-tag"])).toBe(PUBLISHED_GUIDES.length === 0);
    await page.goto("/guides");
    const links = await linkPaths(page);
    for (const g of GUIDES) expect(links, g.path).toContain(g.path);
  });

  test("header, footer and city pages link to the guides only when there are guides", async ({ page }) => {
    await page.goto("/golf-outings/ny/mamaroneck");
    const footer = page.getByRole("navigation", { name: "Site" });
    const main = page.locator("main");
    if (GUIDES.length > 0) {
      await expect(footer.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/guides");
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Guides" })).toBeVisible();
      await expect(main.locator('a[href="/guides"]')).toHaveCount(1);
    } else {
      await expect(footer.getByRole("link", { name: "Guides" })).toHaveCount(0);
      await expect(main.locator('a[href="/guides"]')).toHaveCount(0);
    }
  });

  test("outing pages link newcomers to the singles and entry-fee guides when they exist", async ({ page }) => {
    await page.goto(`/outings/${NKF_WINGED_FOOT.slug}`);
    const links = await linkPaths(page);
    for (const topic of ["playing-an-outing-as-a-single", "what-an-entry-fee-includes"]) {
      const exists = GUIDES.some((g) => g.topic === topic);
      expect(links.includes(`/guides/${topic}`), topic).toBe(exists);
    }
  });
});

test.describe("IndexNow key file", () => {
  test("serves the configured key as text", async ({ request }) => {
    // 9.1 `/{INDEXNOW_KEY}.txt`: "the IndexNow key".
    const res = await request.get(`/${E2E_INDEXNOW_KEY}.txt`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(res.headers()["cache-control"]).toMatch(/max-age/);
    expect((await res.text()).trim()).toBe(E2E_INDEXNOW_KEY);
  });

  test("any other .txt is a 404, and robots.txt and ads.txt still win", async ({ request }) => {
    expect((await request.get("/not-the-key-0001.txt")).status()).toBe(404);
    expect((await request.get(`/${E2E_INDEXNOW_KEY}x.txt`)).status()).toBe(404);
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("User-agent:");
    expect((await request.get("/ads.txt")).status()).toBe(200);
  });
});

test.describe("Search Console and Bing verification", () => {
  test("the home page carries both meta tags when the vars are set", async ({ request }) => {
    const html = await (await request.get("/")).text();
    expect(metaContent(html, "google-site-verification")).toEqual([E2E_GOOGLE_VERIFICATION]);
    expect(metaContent(html, "msvalidate.01")).toEqual([E2E_BING_VERIFICATION]);
  });

  test("no other page carries them", async ({ request }) => {
    for (const path of ["/about", "/golf-outings", "/golf-outings/ny/mamaroneck", "/guides"]) {
      const html = await (await request.get(path)).text();
      expect(metaContent(html, "google-site-verification"), path).toEqual([]);
      expect(metaContent(html, "msvalidate.01"), path).toEqual([]);
    }
  });
});
