import { siteOrigin, type OriginSource } from "./urls.ts";

/** The planned domain (SPEC.md 15); used for the mailbox until PUBLIC_SITE_URL is a real domain. */
const PLANNED_DOMAIN = "golfoutingfinder.com";

function domain(astro?: OriginSource): string {
  try {
    const host = new URL(siteOrigin(astro)).hostname.replace(/^www\./, "");
    return host.includes(".") && !/^\d+(\.\d+){3}$/.test(host) ? host : PLANNED_DOMAIN;
  } catch {
    return PLANNED_DOMAIN;
  }
}

export function correctionsEmail(astro?: OriginSource): string {
  return `corrections@${domain(astro)}`;
}

export const BOT_NAME = "GolfOutingFinderBot/1.0";

export function botUserAgent(astro?: OriginSource): string {
  return `${BOT_NAME} (+${siteOrigin(astro)}/bot)`;
}
