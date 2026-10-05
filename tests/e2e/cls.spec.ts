/**
 * Layout shift with ads on (SPEC.md 9.4 "CLS under 0.1 with ads on", 13 Phase 4).
 *
 * The AdSense script URL is served by a stub that behaves like a slow ad server:
 * each unit the page pushes is filled after a delay with an element taller than
 * its box (the worst case), and the fill repeats for units created later as the
 * page scrolls. Layout shifts are summed with a PerformanceObserver (buffered,
 * excluding shifts right after input) while the test scrolls the whole page.
 * Offline: the stub is fulfilled locally; every other cross-origin request is
 * still aborted by the fixtures.
 */
import { expect, test } from "./support/fixtures.ts";
import { ADSENSE_SCRIPT_URL } from "./support/ads-facts.ts";
import { NKF_WINGED_FOOT } from "./support/seed-facts.ts";

const STUB_AD_SCRIPT = `
(function () {
  var q = window.adsbygoogle || [];
  function fill() {
    var units = document.querySelectorAll("ins.adsbygoogle:not([data-stub])");
    units.forEach(function (ins) {
      ins.setAttribute("data-stub", "1");
      setTimeout(function () {
        var ad = document.createElement("div");
        ad.style.cssText = "width:100%;height:700px;background:#c33";
        ad.textContent = "stub ad";
        ins.appendChild(ad);
        ins.setAttribute("data-ad-status", "filled");
      }, 400);
    });
  }
  window.adsbygoogle = { push: function () { fill(); }, length: 0 };
  for (var i = 0; i < q.length; i++) fill();
  fill();
})();
`;

const PAGES = ["/golf-outings/ny", "/golf-outings/ny/mamaroneck", `/outings/${NKF_WINGED_FOOT.slug}`];
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

for (const vp of VIEWPORTS) {
  for (const path of PAGES) {
    test(`CLS < 0.1 with stub ads on ${path} (${vp.name})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      let served = 0;
      await page.route(ADSENSE_SCRIPT_URL, (route) => {
        served++;
        return route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_AD_SCRIPT });
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number };
        w.__cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
            if (!e.hadRecentInput) w.__cls += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      // Scroll through the page in viewport steps so every lazy unit loads and fills.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y <= height; y += Math.floor(vp.height * 0.8)) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(700);

      expect(served, "the page requested the ad script").toBe(1);
      const filled = await page.locator("ins.adsbygoogle[data-ad-status=filled]").count();
      const boxes = await page.locator("[data-ad-box]:visible").count();
      expect(filled, "every visible unit was filled by the stub").toBe(boxes);
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      expect(cls).toBeLessThan(0.1);
    });
  }
}
