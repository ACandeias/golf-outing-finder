# Seed fixtures: missing and degraded recordings

Recorded 2026-10-03 by `packages/pipeline/scripts/record-seed-fixtures.ts` with the user agent
`GolfOutingFinderBot/1.0 (+http://localhost:8787/bot)`. Free HTTP only; no Claude API or SERP calls.
Each failure was retried twice before it was listed here.

## Missing

| Seed id | URL | Result | Effect |
| --- | --- | --- | --- |
| s14-panther-national-package (gc1) | https://golfwithaccess.com/events/2026-access-palm-beach-golf-experience | HTTP 404 on all three attempts. The event is no longer in golfwithaccess.com's `/events` listing or `sitemap/events.xml`, and the Wayback Machine has no snapshot. | `raw/` and `pages/` hold the 404 page (`http_status: 404`), which has no event text. gc1 (`resort_package` rejection) cannot be asserted from a recorded page; Phase 2 needs a hand-written fixture for it or a replacement case. |

## Degraded

| Seed id | What was recorded | Gap |
| --- | --- | --- |
| s10-brian-ong-mccormick-ranch | The Scramble Hunter event page (`event_url` in the seed), HTTP 200. | Scramble Hunter shows the date, location, price and registration link only to signed-in users. We don't use stored credentials, so the fixture has only the title and a teaser. No organizer page turned up from a few direct guesses at likely domains, and no search API was used, so `registration_url` is `null`. Under amended §8.2, a directory event page without an off-directory `registration_url` doesn't publish, so this entry should end up held. |
| s12-grady-rocky-point (gc5) | The Scramble Hunter event page, HTTP 200. | The same login wall applies, so the fixture lacks the date, the $150/$600 prices and the registration link. gc5 can't pass on this text alone. Phase 2 needs the Grady Dad's Club's own page (owner or a SERP-enabled run) or a hand-written fixture. `registration_url` is `null`. |
| s09-hyslop-arizona-biltmore | The shared azgolf.org calendar (same page as s01), HTTP 200. | The cleaned calendar text is 35k characters. The Hyslop entry comes after the 12,000-character cap in §8.3, so `pages/s09-*.json` doesn't contain it, while the s01 Encanto/PEJATC entry does (around character 7,100). `raw/s09-*.html` has the full page. `registration_url` is the organizer's Qgiv page, linked from driveforeacure.com (the site the calendar links to). |
| s04-fordham-winged-foot | now.fordham.edu, rendered with Playwright. | A plain fetch got HTTP 403. One headless render with the same honest user agent returned 200, so the fixture came from that render. |

## Notes

- The azgolf.org calendar hides each event's details in accordion panels marked `aria-hidden`. The recorder removes `aria-hidden` and `hidden` before running Readability, and falls back to the cleaned body text when Readability returns under 400 characters or under a quarter of the body text. The Phase 2 normalizer should do the same.
- `pages/s15-synthetic-oakmont-glendale.json` is built from the seed's `fixture_text`, with `url: null` and `http_status: null`. No raw HTML exists for it.
- For s03, s05 and s06, registration happens through a button on the source page itself (Classy and Network for Good), so `registration_url` equals the event page.
- Third-party API keys found in the recorded pages (Mapbox tokens on s11 and s14, Google Maps browser keys on s02, s03 and s06) are replaced with `REDACTED_CREDENTIAL` in `raw/`. They are the sites' keys, not ours, and GitHub push protection rejects them. The recorder redacts them at record time.
- Phase 2 adds hand-written stand-ins for the two golden cases these gaps block:
  `pages/s14-panther-national-package.synthetic.json` (gc1: a three-day package with a resort stay and no
  golf-only option) and `pages/s12-grady-rocky-point.synthetic.json` (gc5: 2026-11-07, 08:30 shotgun,
  $150 single and $600 foursome, registration off the directory). Both carry `synthetic: true` and a note;
  the golden harness prefers a `.synthetic.json` file when one exists and logs that it did.
- The dry run (`pnpm run pipeline --dry-run`) serves those two stand-ins in place of their raw
  recordings (as plain HTML built from the fixture text), and serves s15 at
  `https://fixtures.invalid/s15-synthetic-oakmont-glendale`.

## LLM recordings (Phase 2)

`tests/fixtures/llm/` holds results for the eight golden-case pages only (s01, s02, s04, s06, s12,
s13, s14, s15), hand-written with `recorded: false` until the owner approves
`pnpm run test:live-extract`. The other open seed pages (s03, s05, s07, s08, s10, s11; s09 shares
s01's page) have no result, so in the dry run their batch result comes back
`errored (fixture_missing)`, they are listed under Errors in the run report, and they create no
outing. Recording them is part of the same owner-approved `test:live-extract` run.
