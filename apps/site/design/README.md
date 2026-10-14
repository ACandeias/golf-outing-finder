# Members' Gate design

The site borrows the look of a well-kept club's own website (the reference was Winged Foot's
home page): a photograph of the course fills the first screen, a thin hairline frame sits inset
over it, the name is set in centred, letter-spaced serif capitals with an italic line beneath, and
very little else competes. It borrows the elegance, not the gatekeeping: a $125 muni scramble and
a charity day at a private club are set in exactly the same type, and the copy never says
"exclusive", "elite", "prestigious" or "bucket list".

## Tokens

Defined on `:root` in `src/layouts/Base.astro` and redefined under
`@media (prefers-color-scheme: dark)`. Contrast ratios are WCAG 2.1 against the page (or band)
they sit on.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--page` | `#FCFCFA` linen white | `#14291F` bottle green | page background (deliberately not warm cream) |
| `--surface` | `#ECEEEA` limestone | `#1C3529` | the rare quiet band: filter panel, guide contents |
| `--ink` | `#1E2622` (15.1:1) | `#EEF0EA` (13.4:1) | body text |
| `--ink-muted` | `#56605A` (6.4:1, 5.6:1 on limestone) | `#B4BFB7` (8.1:1) | secondary text, labels, facts |
| `--title` | `#14291F` | `#F4F4EF` | headings, outing titles, prices, date numerals |
| `--fairway` | `#2C5640` (8.1:1) | `#A8CDB5` (8.8:1) | links, button outlines, focus ring |
| `--gilt` | `#B0915A` | `#C9AC74` | hairlines, frame, ornaments, the crest; never body text |
| `--rule` / `--rule-strong` | gilt at 42% / 80% | gilt at 32% / 70% | 1px row rules / section rules |
| `--claret` | `#7A2430` (9.6:1) | `#E9A3AB` (7.5:1) | Sold out, Cancelled, the cancelled note |
| `--band` / `--band-fg` | `#14291F` / `#FCFCFA` (15:1) | `#0E1E16` / `#FCFCFA` | header, footer, photo bands, hero |
| `--display` | Marcellus | | wordmark, nav, page titles, h2, date numerals, buttons |
| `--serif` | Libre Caslon Text | | everything else |
| `--track` | `0.16em` | | letter-spacing for tracked capitals |

There is no border radius, no shadow (other than a soft text shadow on photo text), no gradient
outside the photo scrims, and no zebra striping.

## Type

Two families, both self-hosted woff2 under the SIL Open Font License (`public/fonts/LICENSE.txt`):

- **Marcellus** (Astigmatic), a Trajan-style face with flared serifs. It was picked over Cormorant
  Garamond because it holds up at 11 to 13px in tracked capitals over a photograph, has lining
  figures by default (the date numerals), and is 15 KB against Cormorant's 38 KB. Used in
  capitals with 0.12 to 0.24em tracking for the wordmark, nav, page titles and button text, and
  in sentence case for section headings and the tee sheet's day numerals.
- **Libre Caslon Text** (400, italic, and 700 for `<strong>` in prose only): body, outing titles,
  prices and summaries. The italic carries taglines, course lines, labels and secondary facts.
  Numbers use `lining-nums tabular-nums`.

Only the wordmark, nav, page titles and buttons are set in letter-spaced capitals. Labels are
plain small italic text, never boxes. Both families have metric-matched local fallbacks
(`size-adjust` and ascent/descent overrides, measured against Georgia and Times New Roman), so
the swap doesn't shift layout.

## Layout

- **Home.** A full-bleed hero (88svh desktop, 70svh mobile) with the misty-fairway photo, a
  bottle-green scrim (about 60% at the top and bottom, 30% across the fairway, darker behind the
  wordmark), and a double hairline frame inset 56px on desktop. Centred: the crest, "WELCOME TO /
  GOLF OUTING FINDER", the italic tagline, and the city/ZIP search as an underlined ivory field
  with an outlined ivory button. The nav floats over the photo. Below: a centred intro with a gilt
  ornament, "Coming up" as a tee sheet, "Outings near you", and the states in a four-column
  directory with gilt column rules.
- **Interior pages** (hub, state, city, charity city, course, organizer, outing, about) open with
  a photo band: 340px desktop, 270px on phones, scrim 60 to 74%, double hairline frame inset 24px
  on desktop, breadcrumbs in small italic above the title in tracked capitals, and an optional
  italic tagline (the date on outing pages, the course type on course pages). The band photo
  is chosen by an FNV-1a hash of the state code (organizer pages: the slug), from
  `lib/photos.ts`. On phones the current page's crumb is visually hidden, since the title names it.
- **Reading pages** (guides, legal pages, 404, map) use a plain linen header with a gilt rule
  and lozenge ornament, and a single 44rem measure.
- **Header.** Solid bottle green with a gilt hairline on every page except home; small crest and
  tracked wordmark left, tracked-caps nav right (stacked and centred on phones). The current
  section is underlined in gilt.
- **Footer.** Bottle green band: centred crest and wordmark, one line of tracked-caps links
  between gilt hairlines, then small serif lines for the listing note, the OpenStreetMap
  attribution and the photo credits link.

## Components

- **Tee sheet** (`TeeSheet.astro`, `TeeSheetRow.astro`, and `scripts/near-you.ts`, which builds
  the same markup in the browser). Rows sit between 1px gilt rules with generous padding. The
  date column has the weekday in small italic, the day as a large Marcellus numeral and the month
  in small tracked capitals, behind a thin vertical rule. The middle holds the title in Caslon
  (400), the course line in italic, then the facts (course type, outing type, status) as plain
  small text separated by thin vertical rules, with Sold out and Cancelled in claret. The price is
  right-aligned serif; the action is a slim outlined "REGISTER", "SEE SITE" or "DETAILS" button
  that fills fairway on hover. Rows lay out by the sheet's width (a container query at 680px), so
  a sheet beside the outing page's ad column keeps its narrow form.
- **Facts and inline links** (`.facts`, `.inline-links`): every item carries a left rule; the
  list is clipped by 1px and shifted left one gap, so a separator never starts a wrapped line.
- **Scorecard** (`.scorecard`): the outing details and course facts as a definition list between
  gilt hairlines, terms in italic.
- **Filters** (`FilterForm.astro`): the collapsed `<details>`, in a limestone panel between gilt
  rules, with italic serif labels and underlined fields.
- **Buttons**: outlined, square, tracked capitals, filled on hover; `.large` for the outing page's
  Register.
- **Crest** (`Crest.astro`): our own mark, a flagstick and cup line in a double ring. It is not
  any club's crest.
- **Ad slots** keep their reserved heights (`lib/ads.ts`); only the label changed, to small italic.

Motion is limited to one 900ms fade-up of the hero content on load and the filter panel opening,
both off under `prefers-reduced-motion`.

## Photos

Six generic course photographs from Unsplash and Pexels, credited in `public/photos/CREDITS.md`
and on /about (`#photo-credits`). Each has a 4:1 band crop (1440, 1920) and a 2:1 crop for
screens under 1024px (640, 960, 1440); the hero also has 16:9 (960, 1440, 1920) and 3:4 portrait
(640, 960, 1440) crops. All are AVIF with WebP fallback via `<picture>` (`Photo.astro`), loaded
eagerly with `fetchpriority="high"`; the home page also preloads the hero AVIF for each
orientation. The hero at 1440 is 45 KB.

Lighthouse mobile (local `wrangler dev`, October 2026): home, city, state and outing pages score
100 performance, 100 accessibility and 100 SEO, LCP about 1.7s, CLS 0.

## Screenshots

`screenshots/` holds each page type at 1440x900 (`*-desktop.png`) and 390x844 (`*-mobile.png`),
full page, plus dark-mode desktop views of home, city and outing (`*-desktop-dark.png`), taken
against `wrangler dev` with the seed data, ads on and `SITE_NOW=2026-09-28`. Pages: `home`, `hub`
(/golf-outings), `state` (/golf-outings/ny), `city` (/golf-outings/ny/mamaroneck), `outing` (NKF
at Winged Foot), `course` (Winged Foot), `guides`, `guide` (how shotgun starts work, a draft in
this build), `about` and `map` (tiles are blocked offline, so the map area is blank). The PNGs are
palette-quantized to keep the repo small.
