/** 404 rules (SPEC.md 9.1, 11, 13 Phase 1 item 3). */
import { expect, test } from "./support/fixtures.ts";
import { EMPTY_COURSE_SLUGS, HELD_E17_ORGANIZER, HELD_E17_SLUG } from "./support/seed-facts.ts";

for (const slug of EMPTY_COURSE_SLUGS) {
  test(`course with no outings ${slug} returns 404`, async ({ request }) => {
    // 9.1 course: "courses that never had an outing return 404"; 13 Phase 1 item 3.
    // Both courses are in tests/fixtures/courses.json and loaded, but no seed entry uses them.
    const res = await request.get(`/courses/${slug}`);
    expect(res.status()).toBe(404);
  });
}

test("an unknown outing slug returns 404", async ({ request }) => {
  const res = await request.get("/outings/2026/no-such-outing-anywhere");
  expect(res.status()).toBe(404);
});

test("the held e17 outing returns 404", async ({ request }) => {
  // 8.8: e17 is held with hold_reason no_date and stays unpublished.
  const res = await request.get(`/outings/${HELD_E17_SLUG}`);
  expect(res.status()).toBe(404);
});

test("an organizer with no published outing returns 404", async ({ request }) => {
  // 9.1 organizer: indexed "when it has a published outing"; e17's organizer has none, and
  // organizerBySlug (packages/db) returns null for it, so there is nothing to render.
  const res = await request.get(`/organizers/${HELD_E17_ORGANIZER}`);
  expect(res.status()).toBe(404);
});

test("unknown state, city and course paths return 404", async ({ request }) => {
  // Inferred from 9.1: these routes render from D1 rows, and there is no row to render.
  for (const path of ["/golf-outings/zz", "/golf-outings/ny/no-such-city", "/courses/ny/no-such-course"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
});
