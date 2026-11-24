import { homePageOnlyPlatform, type PlatformRule } from "../discovery/platform-policy.ts";
import { normalizeUrl } from "../discovery/url.ts";
import { itemKey, platformOf, type AccessItem } from "./load.ts";

/**
 * Rules for the hand-curated link catalog (data/access-links.json): links a
 * person added, with the facts typed in from a page they opened themselves.
 * Nothing here fetches anything. A platform's terms may forbid crawling and
 * still allow a link; the catalog is how such a listing reaches the site.
 * Where the terms allow links to the home page only (`deep_links: false` in
 * platforms.yaml), a link to any other page is refused.
 */

/** For a link: the platform that allows home-page links only, when the link goes deeper; else null. */
export type HomePageOnly = (link: string) => string | null;

/** The check built from platforms.yaml rules. An unparseable link matches nothing. */
export function homePageOnlyCheck(rules: readonly PlatformRule[]): HomePageOnly {
  return (link) => {
    try {
      return homePageOnlyPlatform(link, rules);
    } catch {
      return null;
    }
  };
}

const hostOf = (link: string): string => {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** Every reason an entry can't go in the catalog, as "<course>, <title>: <reason>". Empty when all is well. */
export function curatedLinkProblems(items: readonly AccessItem[], homePageOnly: HomePageOnly = () => null): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const say = (reason: string) => problems.push(`${it.course_name}, ${it.title}: ${reason}`);
    // Compare the link the way the loader stores it: no fragment, no tracking parameters.
    const link = normalizeUrl(it.link) ?? it.link;
    if (!it.checked_on) say("no checked_on date");
    if (it.kind === "auction" && (it.status === "open" || it.status === "upcoming") && it.date_end === null) {
      say("an open auction lot needs date_end (its closing day)");
    }
    const homeOnly = homePageOnly(link);
    if (homeOnly) say(`${homeOnly} allows links to its home page only`);
    const host = hostOf(link);
    const platform = platformOf(it.platform);
    if (host && host !== platform && !host.endsWith(`.${platform}`)) say(`the link opens ${host}, not ${platform}`);
    const key = itemKey(link, it.kind, it.course_name, it.title);
    if (seen.has(key)) say("listed twice");
    seen.add(key);
  }
  return problems;
}
