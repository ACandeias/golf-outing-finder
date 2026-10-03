import { siteOrigin } from "./urls.ts";

/** The planned domain (SPEC.md 15); used for the mailbox until PUBLIC_SITE_URL is a real domain. */
const PLANNED_DOMAIN = "golfoutingfinder.com";

function domain(): string {
  try {
    const host = new URL(siteOrigin()).hostname.replace(/^www\./, "");
    return host.includes(".") && !/^\d+(\.\d+){3}$/.test(host) ? host : PLANNED_DOMAIN;
  } catch {
    return PLANNED_DOMAIN;
  }
}

export function correctionsEmail(): string {
  return `corrections@${domain()}`;
}

export const BOT_NAME = "GolfOutingFinderBot/1.0";

export function botUserAgent(): string {
  return `${BOT_NAME} (+${siteOrigin()}/bot)`;
}
