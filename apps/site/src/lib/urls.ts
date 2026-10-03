import { citySlug } from "@gof/shared/slug";
import { siteEnv } from "./env.ts";

/** Site origin without a trailing slash. */
export function siteOrigin(): string {
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

export function absoluteUrl(path: string): string {
  return `${siteOrigin()}${canonicalPath(path)}`;
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
