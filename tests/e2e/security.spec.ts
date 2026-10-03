/**
 * Security controls visible from outside (SPEC.md 10, CLAUDE.md "Security rules").
 */
import { expect, test } from "./support/fixtures.ts";
import { jsonLdBlocks, withoutScripts } from "./support/html.ts";
import { HOPE_HEROES_EXPECTED_SLUG, NKF_WINGED_FOOT, THRIVERS } from "./support/seed-facts.ts";

const HTML_PAGES = ["/", "/golf-outings/ny/mamaroneck", `/outings/${NKF_WINGED_FOOT.slug}`, "/map", "/about"];

for (const path of HTML_PAGES) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const h = res.headers();
    // 10: "a Content-Security-Policy that allows only the ad, analytics and map origins
    // in use (start in report-only mode)".
    const csp = h["content-security-policy-report-only"];
    expect(csp, "CSP report-only header").toBeTruthy();
    expect(csp).toMatch(/default-src\s/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBeTruthy();
  });
}

test("nosniff on JSON and XML routes too", async ({ request }) => {
  for (const path of ["/api/outings?bbox=-74,40.8,-73.5,41.4", "/sitemap-index.xml", "/health"]) {
    const res = await request.get(path);
    expect(res.headers()["x-content-type-options"], path).toBe("nosniff");
  }
});

test("database text is escaped, never injected as HTML", async ({ request }) => {
  // CLAUDE.md: "Scraped text never reaches a page as HTML. Render it as text. Never
  // use set:html or innerHTML with anything from the database." The seed title
  // "Thrivers & Survivors ..." must reach the markup as "&amp;".
  const res = await request.get(`/outings/${THRIVERS.slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  const markup = withoutScripts(html);
  expect(markup).toContain("Thrivers &amp; Survivors");
  expect(markup).not.toMatch(/Thrivers & Survivors/);
  // The same title inside JSON-LD is JSON, not HTML, and must not be able to close
  // the script element.
  for (const block of jsonLdBlocks(html)) expect(block).not.toMatch(/<\/script/i);
});

test("an organizer name with an ampersand and an apostrophe is escaped", async ({ request }) => {
  // e06 organizer "Hope & Heroes Children's Cancer Fund".
  const res = await request.get(`/outings/${HOPE_HEROES_EXPECTED_SLUG}`);
  expect(res.status()).toBe(200);
  const markup = withoutScripts(await res.text());
  expect(markup).toContain("Hope &amp; Heroes");
  expect(markup).not.toMatch(/Hope & Heroes/);
});
