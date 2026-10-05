/**
 * Accessibility smoke (SPEC.md 9.7: WCAG 2.1 AA) with axe-core on the home, a
 * city and an outing page: no serious or critical violations.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./support/fixtures.ts";
import { NKF_WINGED_FOOT } from "./support/seed-facts.ts";
import { SAMPLE_GUIDE_PATH } from "./support/guide-facts.ts";

const PAGES = [
  ...new Set(["/", "/golf-outings/ny/mamaroneck", `/outings/${NKF_WINGED_FOOT.slug}`, "/guides", SAMPLE_GUIDE_PATH]),
];

for (const path of PAGES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${path} has no serious or critical axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map(
          (v) =>
            `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
        );
      expect(blocking).toEqual([]);
    });
  }
}
