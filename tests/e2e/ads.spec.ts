/**
 * Ads and consent (SPEC.md 9.5, 13 Phase 4): /ads.txt from env, slot placement,
 * the consent bootstrap and the CSP origins. The server runs with an AdSense
 * client and a GA4 id (support/ads-facts.ts); the fixtures abort the Google
 * scripts, so slots stay as their reserved, empty boxes here.
 */
import { expect, test } from "./support/fixtures.ts";
import { ADSENSE_SCRIPT_URL, E2E_ADSENSE_CLIENT, E2E_GA4_ID } from "./support/ads-facts.ts";
import { NKF_WINGED_FOOT } from "./support/seed-facts.ts";

const STATE = "/golf-outings/ny";
const OUTING = `/outings/${NKF_WINGED_FOOT.slug}`;

test("/ads.txt serves the configured publisher line", async ({ request }) => {
  // 13 Phase 4: "/ads.txt serves the configured publisher line".
  const res = await request.get("/ads.txt");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
  expect(res.headers()["cache-control"]).toBe("public, max-age=86400");
  expect(await res.text()).toBe("google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n");
});

test("list units: after the third result, never above the first, labelled", async ({ page }) => {
  await page.goto(STATE);
  const layout = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-filter-group] .tee-row, [data-filter-group] [data-ad-row]")].map((el) =>
      el.hasAttribute("data-ad-row") ? "ad" : "row",
    ),
  );
  const rows = layout.filter((x) => x === "row").length;
  expect(rows, "the NY state page lists enough outings for a unit").toBeGreaterThanOrEqual(4);
  const firstAd = layout.indexOf("ad");
  expect(firstAd).toBe(3);
  expect(layout.at(-1)).toBe("row");
  // Every unit after the first follows eight more results.
  const adIdx = layout.flatMap((x, i) => (x === "ad" ? [i] : []));
  adIdx.forEach((i, k) => expect(layout.slice(0, i).filter((x) => x === "row").length).toBe(3 + 8 * k));

  const slot = page.locator("[data-ad-row] [role=group]").first();
  await expect(slot).toHaveAttribute("aria-label", "Advertisement");
  await expect(slot.getByText("Advertisement")).toBeVisible();
  // Desktop: a 90px leaderboard box, reserved before any ad arrives.
  const box = await slot.locator("[data-ad-box]").boundingBox();
  expect(box?.height).toBe(90);
  // Striping counts outing rows only.
  const stripes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-filter-group] .tee-sheet")].map((ul) =>
      [...ul.querySelectorAll<HTMLElement>(".tee-row")].map((li) => getComputedStyle(li).backgroundColor),
    ),
  );
  for (const list of stripes) {
    for (let i = 0; i + 2 < list.length; i++) expect(list[i]).toBe(list[i + 2]);
  }
});

test("at most three units on a phone, each with a reserved 280px box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(STATE);
  const visible = page.locator("[data-ad-box]:visible");
  const n = await visible.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(3);
  expect((await visible.first().boundingBox())?.height).toBe(280);
});

test("outing page: one unit below the details and a desktop sidebar unit", async ({ page }) => {
  await page.goto(OUTING);
  await expect(page.locator(".ad-outing")).toHaveCount(1);
  const afterDetails = await page.evaluate(() => {
    const details = document.querySelector("dl.details");
    const ad = document.querySelector(".ad-outing");
    return Boolean(details && ad && details.compareDocumentPosition(ad) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(afterDetails).toBe(true);
  await expect(page.locator(".ad-sidebar [data-ad-box]")).toBeVisible();
  expect((await page.locator(".ad-sidebar [data-ad-box]").boundingBox())?.height).toBe(600);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".ad-sidebar")).toBeHidden();
  await expect(page.locator("[data-ad-box]:visible")).toHaveCount(1);
});

test("consent defaults go into the dataLayer before gtag.js and the ad script are requested", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(OUTING);
  await page.waitForFunction(() => Array.isArray(window.dataLayer) && window.dataLayer.length >= 3);
  const layer = await page.evaluate(() => (window.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>)));
  expect(layer[0]?.slice(0, 2)).toEqual(["consent", "default"]);
  const regional = layer[0]?.[2] as { region: string[]; ad_storage: string; ad_user_data: string; ad_personalization: string; analytics_storage: string; wait_for_update: number };
  expect(regional).toMatchObject({
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    wait_for_update: 500,
  });
  for (const r of ["DE", "FR", "GB", "CH", "NO"]) expect(regional.region).toContain(r);
  expect(regional.region).not.toContain("US");
  expect(layer[1]?.slice(0, 2)).toEqual(["consent", "default"]);
  expect(layer[1]?.[2]).toMatchObject({ ad_storage: "granted", analytics_storage: "granted" });
  expect(layer.findIndex((a) => a[0] === "config")).toBeGreaterThan(1);
  expect(layer.find((a) => a[0] === "config")?.[1]).toBe(E2E_GA4_ID);
  await expect.poll(() => requested).toContain(ADSENSE_SCRIPT_URL);
  await expect.poll(() => requested).toContain(`https://www.googletagmanager.com/gtag/js?id=${E2E_GA4_ID}`);
});

test("prerendered pages load no ad or analytics script", async ({ page, request }) => {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.goto("/about");
  await page.waitForLoadState("networkidle");
  expect(await page.locator("#gof-ads-config").count()).toBe(0);
  expect(await page.locator("[data-ad-box]").count()).toBe(0);
  expect(requested.filter((u) => !u.startsWith(new URL(page.url()).origin))).toEqual([]);
  const csp = (await request.get("/about")).headers()["content-security-policy-report-only"] ?? "";
  expect(csp).not.toContain("googlesyndication");
});

test("server-rendered pages allow the ad and analytics origins in the report-only CSP", async ({ request }) => {
  const res = await request.get(OUTING);
  const h = res.headers();
  expect(h["content-security-policy"]).toBeUndefined();
  const csp = h["content-security-policy-report-only"] ?? "";
  expect(csp).toMatch(/script-src 'self' [^;]*https:\/\/pagead2\.googlesyndication\.com/);
  expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
  expect(csp).toMatch(/frame-src [^;]*https:\/\/googleads\.g\.doubleclick\.net/);
  expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.google-analytics\.com/);
  const html = await res.text();
  expect(html).toContain(`data-client="${E2E_ADSENSE_CLIENT}"`);
  // No inline executable script: the bootstrap is a same-origin module.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/g)];
  expect(inline.map((m) => m[0])).toEqual([]);
});

test("filtering never leaves a unit above the first shown result", async ({ page }) => {
  await page.goto(STATE);
  // Show private courses only: the shown rows change, the units' positions don't.
  await page.locator("details.filters > summary").click();
  await page.locator('[data-filter-form] input[name="course_type"][value="private"]').check();
  await expect(page).toHaveURL(/course_type=private/);
  const ok = await page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>("[data-filter-group] [data-outing], [data-filter-group] [data-ad-row]")];
    let seen = false;
    for (const el of items) {
      if (el.hidden) continue;
      if (el.hasAttribute("data-ad-row") && !seen) return false;
      if (el.hasAttribute("data-outing")) seen = true;
    }
    const shown = items.filter((el) => !el.hidden);
    return shown.length === 0 || !shown.at(-1)?.hasAttribute("data-ad-row");
  });
  expect(ok).toBe(true);
});

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}
