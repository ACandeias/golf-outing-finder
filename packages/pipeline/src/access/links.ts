import { itemKey, type AccessItem } from "./load.ts";

/**
 * Rules for the hand-curated link catalog (data/access-links.json): links a
 * person added, with the facts typed in from a page they opened themselves.
 * Nothing here fetches anything. A platform's terms may forbid crawling and
 * still allow a link; the catalog is how such a listing reaches the site.
 */

/** Sites whose terms allow links to their home page only. A curated link to any other page is refused. */
export const HOME_PAGE_LINKS_ONLY: readonly string[] = ["ajga.org"];

const hostOf = (link: string): string => {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const isHomePage = (link: string): boolean => {
  try {
    const u = new URL(link);
    return (u.pathname === "/" || u.pathname === "") && u.search === "";
  } catch {
    return false;
  }
};

/** Every reason an entry can't go in the catalog, as "<course>, <title>: <reason>". Empty when all is well. */
export function curatedLinkProblems(items: readonly AccessItem[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const say = (reason: string) => problems.push(`${it.course_name}, ${it.title}: ${reason}`);
    if (!it.checked_on) say("no checked_on date");
    if (it.kind === "auction" && (it.status === "open" || it.status === "upcoming") && it.date_end === null) {
      say("an open auction lot needs date_end (its closing day)");
    }
    const host = hostOf(it.link);
    const homeOnly = HOME_PAGE_LINKS_ONLY.find((h) => host === h || host.endsWith(`.${h}`));
    if (homeOnly && !isHomePage(it.link)) say(`${homeOnly} allows links to its home page only`);
    const key = itemKey(it.link, it.kind, it.course_name, it.title);
    if (seen.has(key)) say("listed twice");
    seen.add(key);
  }
  return problems;
}
