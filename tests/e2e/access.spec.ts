/**
 * Access opportunities (auction lots, tee times, ...): the timeline on
 * /top-courses and the countdown on a course page. The rows come from
 * tests/fixtures/access-e2e.json; the clock is pinned to 2026-09-28.
 */
import { expect, test } from "./support/fixtures.ts";

test.describe("/top-courses timeline", () => {
  test("coming up: the next 7 days first, then by month, each entry on its act-by day", async ({ page }) => {
    await page.goto("/top-courses");
    const upcoming = page.locator('[data-timeline="upcoming"]');
    await expect(upcoming.getByRole("heading", { level: 2 })).toHaveText("Coming up");
    await expect(upcoming.locator("[data-timeline-group] h3")).toHaveText(["In the next 7 days", "November 2026"]);

    const soon = upcoming.locator('[data-timeline-group="week"] [data-timeline-entry]');
    await expect(soon).toHaveCount(1);
    await expect(soon).toHaveAttribute("data-date", "2026-09-29");
    await expect(soon).toContainText("Sep 29");
    await expect(soon).toContainText("Bidding closes tomorrow");
    await expect(soon).toContainText("Current bid $2,500");
    await expect(soon.getByRole("link", { name: "Winged Foot Golf Club" })).toHaveAttribute("href", "/courses/ny/winged-foot-golf-club");

    const later = upcoming.locator('[data-timeline-group="2026-11"] [data-timeline-entry]');
    await expect(later).toContainText("Starts Nov 9, 2026");
    await expect(later).toContainText("Quaker Ridge Golf Club");
  });

  test("expected back: a recurring lot sits in the month it closed last time, a year on", async ({ page }) => {
    await page.goto("/top-courses");
    const expected = page.locator('[data-timeline="expected"]');
    await expect(expected.locator("[data-timeline-group] h3")).toHaveText(["April 2027"]);
    const entry = expected.locator("[data-timeline-entry]");
    await expect(entry).toContainText("Last closed Apr 12, 2026");
    await expect(entry).toContainText("Sold for $14,000");
    // The moved-forward day isn't shown as if it were announced.
    await expect(entry.locator("time")).toHaveCount(0);
  });

  test("open any time: undated open items; closed lots stay out of the timeline", async ({ page }) => {
    await page.goto("/top-courses");
    const anytime = page.locator('[data-timeline="anytime"]');
    await expect(anytime.locator("[data-access]")).toHaveCount(1);
    await expect(anytime).toContainText("TPC Harding Park");
    const timelineText = await page.locator("[data-timeline]").allInnerTexts();
    expect(timelineText.join("\n")).not.toContain("closed test lot");
    // It is still listed under its course.
    await expect(page.locator("[data-access]", { hasText: "closed test lot" })).toHaveCount(1);
  });

  test("the page stays out of the index and its outbound links carry nofollow", async ({ page }) => {
    await page.goto("/top-courses");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const out = page.locator('[data-timeline] a[href^="https://auctions.example.org"]').first();
    await expect(out).toHaveAttribute("rel", "nofollow noopener");
  });

  test("no sideways scroll at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/top-courses");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("course page access rows", () => {
  test("an open lot counts down to its closing day, and the page says when listings have fallen", async ({ page }) => {
    await page.goto("/courses/ny/winged-foot-golf-club");
    const rows = page.locator("[data-access]");
    await expect(rows.first()).toContainText("Foursome with a member");
    await expect(rows.first().locator("[data-deadline]")).toHaveText("Bidding closes tomorrow");
    // The recurring lot has no countdown.
    await expect(rows.nth(1).locator("[data-deadline]")).toHaveCount(0);
    await expect(page.locator("[data-access-months]")).toHaveText("Dated listings here have fallen in April and September.");
  });
});
