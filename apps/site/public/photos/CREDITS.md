# Photo credits

The hero and page-band photographs are generic golf course landscapes from free stock libraries.
None is an organizer's image, and none shows club signage, a logo, a crested flag or a famous hole.
They are credited on /about as well (`src/lib/photos.ts` holds the same list for the site).

| Files | Subject | Photographer | Source | Licence |
| --- | --- | --- | --- | --- |
| `misty-fairway-*` | A tree-lined fairway and bunkers in early morning mist (home hero, band) | Keith Tanner ([@keithtanman](https://unsplash.com/@keithtanman)) | https://unsplash.com/photos/a-golf-course-is-surrounded-by-trees-EGQ0m5QyNu8 | [Unsplash License](https://unsplash.com/license) |
| `aerial-cart-path-*` | A cart path winding past ponds and bunkers, from above | Keith Tanner ([@keithtanman](https://unsplash.com/@keithtanman)) | https://unsplash.com/photos/aerial-view-of-a-beautiful-golf-course-4WSLeNydrlo | [Unsplash License](https://unsplash.com/license) |
| `flag-at-dusk-*` | A red flag on a green at dusk | William Martret ([@willdwind](https://unsplash.com/@willdwind)) | https://unsplash.com/photos/a-red-flag-sticking-out-of-the-green-of-a-golf-course-Qm5COC21eL4 | [Unsplash License](https://unsplash.com/license) |
| `bunker-edge-*` | A greenside bunker under a big sky | Cristina Anne Costello ([@lightupphotos](https://unsplash.com/@lightupphotos)) | https://unsplash.com/photos/a-golf-course-with-a-sand-trap-in-the-foreground-bCK0gvNmK7A | [Unsplash License](https://unsplash.com/license) |
| `valley-sunrise-*` | Sunrise over a public course in a valley | Andrew Jooste ([@ajpicpro](https://unsplash.com/@ajpicpro)) | https://unsplash.com/photos/sunset-shines-over-a-lush-golf-course-u8NwLmx0zag | [Unsplash License](https://unsplash.com/license) |
| `mountain-green-*` | A green and flagstick with mountains behind | Ajay Kumar ([profile](https://www.pexels.com/@ajay-kumar-602391836/)) | https://www.pexels.com/photo/view-of-a-golf-course-17383426/ | [Pexels License](https://www.pexels.com/license/) |

Both licences allow free commercial use without attribution; we credit the photographers anyway.

## Processing

Downloaded in October 2026 (Unsplash `/download?w=2600`, Pexels `?w=2600`), then cropped and encoded
with sharp (the copy Astro already installs; no new dependency), metadata stripped:

- `{name}-band-{1440,1920}`: 4:1 crop for page bands at 1024px and wider.
- `{name}-band-m-{640,960,1440}`: 2:1 crop for bands below 1024px.
- `misty-fairway-hero-{960,1440,1920}`: 16:9 crop for the home hero on landscape screens.
- `misty-fairway-hero-m-{640,960,1440}`: 3:4 crop for the home hero on portrait screens.

Each size is AVIF (quality 48) and WebP (quality 66). The largest file, `mountain-green-band-1920.webp`,
is about 200 KB; the hero at 1440 is 45 KB as AVIF and 61 KB as WebP.
