import { expect, test } from "@playwright/test";

test("home returns 200 and renders the heading", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Golf Outing Finder" })).toBeVisible();
});

test("robots.txt lists sitemap and disallows /api", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("Disallow: /api/");
  expect(body).toContain("Sitemap:");
});
