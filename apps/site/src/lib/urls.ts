import { citySlug } from "@gof/shared/slug";
import { siteEnv } from "./env.ts";

/** What `siteOrigin` needs from `Astro` to tell prerendered pages apart. */
export interface OriginSource {
  isPrerendered: boolean;
  site: URL | undefined;
}

/**
 * Site origin without a trailing slash: the PUBLIC_SITE_URL Worker var on rendered
 * pages. Prerendered pages are built before any request, so they use Astro's
 * `site`, which astro.config.mjs takes from PUBLIC_SITE_URL at build time.
 */
export function siteOrigin(astro?: OriginSource): string {
  if (astro?.isPrerendered && astro.site) return astro.site.origin;
  return siteEnv().PUBLIC_SITE_URL.replace(/\/+$/, "");
}

/**
 * Canonical path policy: lowercase, no trailing slash except the root, no query.
 */
export function canonicalPath(path: string): string {
  const p = path.split(/[?#]/)[0] ?? "/";
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  return (trimmed || "/").toLowerCase();
}

export function absoluteUrl(path: string, astro?: OriginSource): string {
  return `${siteOrigin(astro)}${canonicalPath(path)}`;
}

export const statePath = (state: string): string => `/golf-outings/${state.toLowerCase()}`;
export const cityPath = (state: string, city: string): string =>
  `/golf-outings/${state.toLowerCase()}/${citySlug(city)}`;
export const charityCityPath = (state: string, city: string): string =>
  `/charity-golf-tournaments/${state.toLowerCase()}/${citySlug(city)}`;
/** Course slugs are stored as `ny/winged-foot-golf-club`. */
export const coursePath = (courseSlug: string): string => `/courses/${courseSlug}`;
/** Outing slugs are stored as `2026/nkf-golf-classic-...`. */
export const outingPath = (outingSlug: string): string => `/outings/${outingSlug}`;
export const organizerPath = (organizerSlug: string): string => `/organizers/${organizerSlug}`;
