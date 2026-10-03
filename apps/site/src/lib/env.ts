import { env } from "cloudflare:workers";
import { parseSiteEnv, resolveNow, type SiteEnv } from "@gof/shared/env";

/** Worker vars validated with zod (SPEC.md section 6). Throws on a bad config. */
export function siteEnv(): SiteEnv {
  return parseSiteEnv(env as unknown as Record<string, unknown>);
}

/** Request clock: SITE_NOW overrides it outside production (SPEC.md 9.4). */
export function siteNow(e: SiteEnv = siteEnv()): number {
  return resolveNow(e.SITE_NOW, e.NODE_ENV, Date.now());
}

export const BUILD_VERSION: string = import.meta.env.BUILD_VERSION ?? "dev";
