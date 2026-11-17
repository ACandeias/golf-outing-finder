# The Clubhouse design

The site looks like a well-kept club's own website: a photograph of the course fills the first
screen, the headline is set large in a calm serif at its foot, and the page below is paper, a
few hairlines and a lot of room. It borrows the elegance, not the gatekeeping: a $125 muni
scramble and a charity day at a private club are set in exactly the same type, and the copy never
says "exclusive", "elite", "prestigious" or "bucket list".

It replaces the "Members' Gate" design (October 2026), which centred everything in small tracked
capitals inside a hairline frame and turned into a plain list below the hero. What changed:

- Titles are large Cormorant Garamond in sentence case, set bottom-left on the page grid.
- The home page has sections with their own weight: a statement, the tee sheet, a second
  photograph for "near you", the states by region on linen, and the guides.
- The search is a paper panel at the foot of the hero, not an underlined field over the photo.
- The outing page has a booking card (price, the one action, last verified).
- The footer is two short lists beside the mark.

## Tokens

Defined on `:root` in `src/layouts/Base.astro` and redefined under
`@media (prefers-color-scheme: dark)`.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--page` | `#FBFAF6` paper | `#14291F` bottle green | page background |
| `--surface` | `#F1EEE4` linen | `#1A3327` | bands and panels: states, booking card, filters, guide contents |
| `--ink` | `#1C241F` | `#EEF0EA` | body text |
| `--ink-muted` | `#545E57` | `#B4BFB7` | secondary text, small labels, facts |
| `--title` | `#14291F` | `#F4F4EF` | headings, outing titles, prices, date numerals |
| `--fairway` | `#2C5640` | `#A8CDB5` | links, the solid button, focus ring |
| `--gilt` | `#A88A52` | `#C9AC74` | hairlines, the rule above headings, the crest; never body text |
| `--rule` / `--rule-strong` | gilt at 38% / 80% | gilt at 30% / 70% | row rules / section rules |
| `--claret` | `#7A2430` | `#E9A3AB` | Sold out, Cancelled, the cancelled note |
| `--band` / `--band-fg` | `#14291F` / `#FBFAF6` | `#0E1E16` / `#FBFAF6` | header, footer, photo bands, hero |
| `--display` | Cormorant Garamond (variable, 500 and 600) | | page titles, headings, outing titles, date numerals, prices on the booking card |
| `--label` | Marcellus | | tracked capitals only: wordmark, nav, buttons, small labels, the month under a date |
| `--serif` | Libre Caslon Text | | everything else |
| `--wrap` / `--measure` | `1180px` / `44rem` | | page width / reading width (guides, legal) |
| `--gutter` | `20px`, `40px` from 720px | | side padding everywhere |
| `--space-section` | `clamp(3.5rem, 8vw, 6.5rem)` | | space between sections |

All three families are self-hosted woff2 under the SIL Open Font License
(`public/fonts/LICENSE.txt`), with metric-matched local fallbacks so the swap doesn't move the
page. No border radius, no shadows except under map popups, no gradients except photo scrims.

Breakpoints: 480 (stacked forms), 560, 720 (gutter, band height), 860 (multi-column grids), 900
(header in one row) and 1024 (outing page columns). The tee sheet switches layout by its own
width (a container query at 680px), not the viewport's.

## Components

- **Header** (`Base.astro`): crest and wordmark left, nav right, on bottle green. On the home page
  it sits over the photograph. Under 900px the nav wraps below the wordmark; there is no menu
  button, so it works without JavaScript.
- **Hero** (`pages/index.astro`): the photograph at 92svh (78svh on phones), the scrim darkest at
  the foot, the h1 at up to 6.5rem, an italic line, and the search panel.
- **Page head** (`PageHead.astro`): with a photo, a 420px band (300px on phones) with breadcrumbs,
  title and tagline bottom-left; without one, the same block on paper with a short gilt rule.
- **Section heading**: every `h2` has a 2.5rem gilt rule above it. `.section-head` pairs a heading
  with one quiet italic link on the right.
- **Tee sheet** (`TeeSheet.astro`, `TeeSheetRow.astro`): rows between hairlines. The date is a
  weekday in italic, a large numeral and the month in small capitals. In lists the action is
  outlined and fills on hover, so a page of rows isn't a column of solid buttons.
- **Booking card** (outing page, `.actions`): price, the solid Register button and "Last
  verified" on linen under a gilt rule. From 1024px, with ads off, it sits beside the details and
  stays in view; with ads on, the ad column takes that place and the card stays in the text.
- **Buttons**: solid fairway green for the main action; `.secondary` is outlined.
- **Facts and scorecard**: course type, outing type and status as small text between thin rules;
  details as a definition list between hairlines.
- **States by region** (home): the four census regions as columns on linen, counts in italic.
- **Map** (`scripts/map.ts`): clusters in bottle green, single outings in fairway green, popups on
  paper. A browser without WebGL gets a sentence and the link to the lists.
- **Footer**: the mark and a note on the left, "Find an outing" and "About this site" lists on the
  right, the attributions on one line below.
- **Crest** (`Crest.astro`): our own mark, a flagstick and cup line in a double ring. It is not
  any club's crest.
- **Ad slots** keep their reserved heights (`lib/ads.ts`).

Motion is limited to one 900ms fade of the hero headline on load, button colour changes, and the
filter panel opening, all off under `prefers-reduced-motion`.

## Photos

Six generic course photographs from Unsplash and Pexels, credited in `public/photos/CREDITS.md`
and on /about (`#photo-credits`). Each has a 4:1 band crop (1440, 1920) and a 2:1 crop for
screens under 1024px (640, 960, 1440); the hero also has 16:9 (960, 1440, 1920) and 3:4 portrait
(640, 960, 1440) crops. All are AVIF with WebP fallback via `<picture>` (`Photo.astro`). The first
photograph on a page loads eagerly at high priority; the home page's second band is lazy.

The library is small: every page in a state shares one photograph. Adding more needs new files
with new names (photos are cached for 30 days without a content hash) and a row in the credits.

## Screenshots

`screenshots/` holds each page type at 1440x900 (`*-desktop.png`) and 390x844 (`*-mobile.png`),
full page, plus dark-mode desktop views of home, city and outing (`*-desktop-dark.png`), taken
against `wrangler dev` with the seed data, ads off and `SITE_NOW=2026-09-28`. Pages: `home`, `hub`
(/golf-outings), `state` (/golf-outings/ny), `city` (/golf-outings/ny/mamaroneck), `outing` (NKF
at Winged Foot), `course` (Winged Foot), `guides`, `guide` (how shotgun starts work, a draft in
this build), `about` and `map` (first screen only). The PNGs are palette-quantized to keep the
repo small.
