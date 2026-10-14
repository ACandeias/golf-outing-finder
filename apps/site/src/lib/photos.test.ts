import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BAND_NARROW_WIDTHS,
  BAND_PHOTOS,
  BAND_WIDE_WIDTHS,
  bandPhotoFor,
  HERO_PHOTO,
  HERO_TALL_WIDTHS,
  HERO_WIDE_WIDTHS,
  PHOTO_CREDITS,
  PHOTOS,
  photoSrcset,
  photoUrl,
  type PhotoKey,
} from "./photos.ts";

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

describe("photos", () => {
  it("every file a srcset can name is in public/photos, in both formats", () => {
    const urls: string[] = [];
    for (const format of ["avif", "webp"] as const) {
      for (const w of HERO_WIDE_WIDTHS) urls.push(photoUrl(HERO_PHOTO, "hero", w, format));
      for (const w of HERO_TALL_WIDTHS) urls.push(photoUrl(HERO_PHOTO, "hero-m", w, format));
      for (const key of BAND_PHOTOS) {
        for (const w of BAND_WIDE_WIDTHS) urls.push(photoUrl(key, "band", w, format));
        for (const w of BAND_NARROW_WIDTHS) urls.push(photoUrl(key, "band-m", w, format));
      }
      urls.push(photoUrl(HERO_PHOTO, "hero", 1440, "webp"));
    }
    const missing = urls.filter((u) => !existsSync(`${PUBLIC}${u}`));
    expect(missing).toEqual([]);
  });

  it("srcsets list each width with its descriptor", () => {
    expect(photoSrcset("bunker-edge", "band", [1440, 1920], "avif")).toBe(
      "/photos/bunker-edge-band-1440.avif 1440w, /photos/bunker-edge-band-1920.avif 1920w",
    );
  });

  it("picks a stable band photo per seed, case-insensitively, and uses every photo", () => {
    expect(bandPhotoFor("NY")).toBe(bandPhotoFor("ny"));
    expect(bandPhotoFor("NY")).toBe(bandPhotoFor("NY"));
    const states = ["AL", "AZ", "CA", "CO", "FL", "GA", "IL", "MA", "MI", "NC", "NJ", "NY", "OH", "PA", "TX", "VA", "WA"];
    const used = new Set<PhotoKey>(states.map(bandPhotoFor));
    expect(used.size).toBe(BAND_PHOTOS.length);
  });

  it("credits every photo, and CREDITS.md names each source page", () => {
    expect(PHOTO_CREDITS.map((c) => c.key).sort()).toEqual((Object.keys(PHOTOS) as PhotoKey[]).sort());
    const md = readFileSync(`${PUBLIC}/photos/CREDITS.md`, "utf8");
    for (const c of PHOTO_CREDITS) {
      expect(c.sourceUrl).toMatch(/^https:\/\/(unsplash\.com|www\.pexels\.com)\//);
      expect(md).toContain(c.sourceUrl);
      expect(md).toContain(c.photographer);
    }
  });
});
