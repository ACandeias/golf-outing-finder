import type { AstroGlobal } from "astro";
import { cacheControl } from "./cache.ts";

/** Sets the per-route edge cache header (SPEC.md 9.1). */
export function setCache(astro: AstroGlobal, ttlSeconds: number): void {
  astro.response.headers.set("Cache-Control", cacheControl(ttlSeconds));
}

/** Renders the 404 page with a 404 status. */
export function notFound(astro: AstroGlobal): Promise<Response> {
  return astro.rewrite("/404");
}
