import { adsConfig, type AdsConfig } from "./ads.ts";
import { siteEnv } from "./env.ts";

/** The ads config for this request's Worker vars (SPEC.md 9.5). */
export function siteAdsConfig(): AdsConfig {
  return adsConfig(siteEnv());
}
