# Clubhouse design

The site looks like the paper and fittings of a clubhouse: green ink on card stock,
the scorecard, the tee sheet on the pro shop wall, a brass plate. Municipal and
private courses are set in exactly the same type.

## Tokens

Defined on `:root` in `src/layouts/Base.astro` and redefined under
`@media (prefers-color-scheme: dark)`.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--page` | `#FAF8F3` card stock | `#10201A` | page background |
| `--surface` | `#EEF2EC` turf tint | `#17291F` | alternating rows, filter panel |
| `--fairway` | `#1F4D3A` | `#8CCBA6` | links, rules |
| `--band` | `#1F4D3A` | `#1F4D3A` | header and footer bands |
| `--plaque` / `--plaque-fg` | `#1F4D3A` / `#FAF8F3` | `#2E6B50` / `#EDE9DF` | Register plaque |
| `--ink` | `#1B2A22` | `#EDE9DF` pale stone | text, label outlines |
| `--ink-muted` | `#4E5B54` | `#B8C0B6` | secondary text |
| `--brass` | `#9A7B2E` | `#9A7B2E` | wordmark flag and the 2px header hairline only, never text |
| `--flag` | `#B4332E` | `#E0706A` | Sold out and Cancelled labels, the cancelled note |
| `--radius` | `2px` | `2px` | the only radius |

Type: Libre Caslon Text (400, 400 italic, 700) for headings, lead, summaries, prose
and the wordmark; Archivo Narrow (400 to 600, variable) for every date, time,
price, label, control and link list, with `lining-nums tabular-nums`. Scale in rem:
0.875, 1, 1.125, 1.375, 1.75, 2.5 (h1 desktop) and 2 (h1 mobile). Fonts are
self-hosted in `public/fonts` (licences in `public/fonts/LICENSE.txt`) with
metric-matched local fallbacks so the swap doesn't shift layout.

## Rationale

A golf club's sense of place comes from its materials, the green-inked scorecard,
the ruled tee sheet and the brass nameplate, not from who gets turned away, so the
design borrows the materials and none of the gatekeeping. Every list of outings is a
tee sheet: ruled rows with the date in a left column like hole numbers, so the eye
scans dates, then names, then prices, the way a golfer reads a sheet. Caslon carries
the voice (titles and prose) and Archivo Narrow carries the facts, which keeps
numbers tabular and lets long course names and prices fit on phones. Color is
rationed: green does the work, brass appears twice as a small mark, and red means
only sold out or cancelled, so color never carries meaning on its own. There are no
shadows, gradients, pills or hover animations; the only motion is the filter panel
opening, and it stops under reduced motion.

## Screenshots

`screenshots/` holds home, city (`/golf-outings/ny/mamaroneck`) and outing (NKF at
Winged Foot) pages at 1280 and 390 wide, plus dark-mode desktop views, taken against
`wrangler dev` with the seed data and `SITE_NOW=2026-09-28`.
