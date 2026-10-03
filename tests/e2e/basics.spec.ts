/**
 * Worker routes from Phase 0 (SPEC.md 9.1), moved here from
 * apps/site/tests/e2e/home.spec.ts.
 */
import { expect, test } from "./support/fixtures.ts";

test("home returns 200 and renders a top-level heading", async ({ page }) => {
  // 9.1 `/`: server-rendered home page; 11: "the home ... pages render".
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("robots.txt disallows /api/ and /suggest and lists the sitemap index", async ({ request, baseURL }) => {
  // 9.1 `/robots.txt`: "disallow /api/ and /suggest; list the sitemap index".
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("Disallow: /api/");
  expect(body).toContain("Disallow: /suggest");
  const sitemap = /^Sitemap:\s*(\S+)/m.exec(body)?.[1];
  expect(sitemap, "robots.txt has a Sitemap line").toBeTruthy();
  expect(new URL(sitemap ?? "").pathname).toBe("/sitemap-index.xml");
  expect(new URL(sitemap ?? "").origin).toBe(new URL(baseURL ?? "").origin);
});

test("health returns ok JSON with no caching", async ({ request }) => {
  // 9.1 `/health`: "Worker JSON, no cache ... { ok: true } plus the build version".
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = (await res.json()) as { ok: boolean; version: string };
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
});
