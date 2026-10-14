/**
 * Licensed stock photographs for the home hero and the interior photo bands
 * (design/README.md). Generic course landscapes only: no club signage, logos,
 * crested flags or famous holes, and nothing from an organizer (CLAUDE.md).
 * Files live in public/photos, credited in public/photos/CREDITS.md and on /about.
 *
 * Every photo has a band crop at 4:1 (desktop) and 2:1 (phones and tablets); the
 * hero photo also has a 16:9 crop (landscape screens) and a 3:4 crop (portrait).
 */

export interface PhotoCredit {
  /** What the photo shows, in our words. */
  subject: string;
  photographer: string;
  profileUrl: string;
  sourceUrl: string;
  source: "Unsplash" | "Pexels";
  license: "Unsplash License" | "Pexels License";
  licenseUrl: string;
}

const UNSPLASH_LICENSE = { source: "Unsplash", license: "Unsplash License", licenseUrl: "https://unsplash.com/license" } as const;
const PEXELS_LICENSE = { source: "Pexels", license: "Pexels License", licenseUrl: "https://www.pexels.com/license/" } as const;

export const PHOTOS = {
  "misty-fairway": {
    subject: "A tree-lined fairway and bunkers in early morning mist",
    photographer: "Keith Tanner",
    profileUrl: "https://unsplash.com/@keithtanman",
    sourceUrl: "https://unsplash.com/photos/a-golf-course-is-surrounded-by-trees-EGQ0m5QyNu8",
    ...UNSPLASH_LICENSE,
  },
  "aerial-cart-path": {
    subject: "A cart path winding past ponds and bunkers, from above",
    photographer: "Keith Tanner",
    profileUrl: "https://unsplash.com/@keithtanman",
    sourceUrl: "https://unsplash.com/photos/aerial-view-of-a-beautiful-golf-course-4WSLeNydrlo",
    ...UNSPLASH_LICENSE,
  },
  "flag-at-dusk": {
    subject: "A red flag on a green at dusk",
    photographer: "William Martret",
    profileUrl: "https://unsplash.com/@willdwind",
    sourceUrl: "https://unsplash.com/photos/a-red-flag-sticking-out-of-the-green-of-a-golf-course-Qm5COC21eL4",
    ...UNSPLASH_LICENSE,
  },
  "bunker-edge": {
    subject: "A greenside bunker under a big sky",
    photographer: "Cristina Anne Costello",
    profileUrl: "https://unsplash.com/@lightupphotos",
    sourceUrl: "https://unsplash.com/photos/a-golf-course-with-a-sand-trap-in-the-foreground-bCK0gvNmK7A",
    ...UNSPLASH_LICENSE,
  },
  "valley-sunrise": {
    subject: "Sunrise over a public course in a valley",
    photographer: "Andrew Jooste",
    profileUrl: "https://unsplash.com/@ajpicpro",
    sourceUrl: "https://unsplash.com/photos/sunset-shines-over-a-lush-golf-course-u8NwLmx0zag",
    ...UNSPLASH_LICENSE,
  },
  "mountain-green": {
    subject: "A green and flagstick with mountains behind",
    photographer: "Ajay Kumar",
    profileUrl: "https://www.pexels.com/@ajay-kumar-602391836/",
    sourceUrl: "https://www.pexels.com/photo/view-of-a-golf-course-17383426/",
    ...PEXELS_LICENSE,
  },
} as const satisfies Record<string, PhotoCredit>;

export type PhotoKey = keyof typeof PHOTOS;

export const HERO_PHOTO: PhotoKey = "misty-fairway";

/** Band photos, in the order the hash picks from. */
export const BAND_PHOTOS: readonly PhotoKey[] = [
  "mountain-green",
  "bunker-edge",
  "flag-at-dusk",
  "valley-sunrise",
  "aerial-cart-path",
  "misty-fairway",
];

/** A stable band photo for a seed (a state code, an organizer slug): FNV-1a over the lowercased seed. */
export function bandPhotoFor(seed: string): PhotoKey {
  let h = 0x811c9dc5;
  for (const ch of seed.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return BAND_PHOTOS[h % BAND_PHOTOS.length] ?? "misty-fairway";
}

export const HERO_WIDE_WIDTHS = [960, 1440, 1920] as const;
export const HERO_TALL_WIDTHS = [640, 960, 1440] as const;
export const BAND_WIDE_WIDTHS = [1440, 1920] as const;
export const BAND_NARROW_WIDTHS = [640, 960, 1440] as const;

export type PhotoFormat = "avif" | "webp";
export type PhotoCrop = "hero" | "hero-m" | "band" | "band-m";

export function photoUrl(key: PhotoKey, crop: PhotoCrop, width: number, format: PhotoFormat): string {
  return `/photos/${key}-${crop}-${width}.${format}`;
}

export function photoSrcset(key: PhotoKey, crop: PhotoCrop, widths: readonly number[], format: PhotoFormat): string {
  return widths.map((w) => `${photoUrl(key, crop, w, format)} ${w}w`).join(", ");
}

/** Credits in display order, one per photo. */
export const PHOTO_CREDITS: readonly (PhotoCredit & { key: PhotoKey })[] = (Object.keys(PHOTOS) as PhotoKey[]).map((key) => ({
  key,
  ...PHOTOS[key],
}));
