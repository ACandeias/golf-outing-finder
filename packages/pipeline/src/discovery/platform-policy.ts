import { z } from "zod";
import { hostOf, registrableDomain } from "../extract/domain.ts";

/**
 * platforms.yaml applied to any URL, wherever it came from (pure; stages use
 * it). The listing adapters already skip platforms and directories with
 * `allowed: false`, but search results and rechecks reach the same sites by
 * another road: the first local nightly (2026-10-04) fetched 30 Eventbrite and
 * 20 Network for Good pages from search, and published Eventbrite search
 * listings as single outings' canonical sources. Two rules follow:
 *
 * - a URL on a platform or directory with `allowed: false` is not fetched,
 *   whichever route found it (search, series links, submissions, rechecks),
 *   and an outing that only such pages support is not published;
 * - a platform *listing* page (Eventbrite `/d/...` search results, a Network
 *   for Good `/events` index) is never an outing's canonical source, even on an
 *   allowed platform; its event pages are.
 *
 * Directories (SPEC.md 8.2 item 6) are stricter: every page on a directory's
 * domain that doesn't match its `event_url_pattern` is an index page, a
 * listing that never publishes, and the event pages themselves are marked
 * `directory` so whichever route found them carries the directory host (the
 * outing's canonical source is then its off-directory registration page, and
 * an outing whose canonical is still a directory page doesn't publish).
 *
 * Domains: an entry's `domains` (`eventbrite.*` matches every registrable
 * domain whose own label is `eventbrite`: eventbrite.ca, eventbrite.com.au),
 * else the registrable domains of its `urls`.
 */

export const platformRuleSchema = z.object({
  name: z.string(),
  allowed: z.boolean(),
  domains: z.array(z.string()),
  listing_url_pattern: z.string().nullable(),
  /** A directory (platforms.yaml `directories`), not a platform. */
  directory: z.boolean().optional(),
  /** Full-URL regex for event pages; on a directory, everything else is an index page. */
  event_url_pattern: z.string().nullable().optional(),
});
export type PlatformRule = z.infer<typeof platformRuleSchema>;

interface EntryLike {
  name: string;
  allowed: boolean;
  urls: readonly string[];
  domains?: readonly string[] | undefined;
  listing_url_pattern?: string | undefined;
  event_url_pattern?: string | undefined;
}

export function platformRulesFrom(config: {
  platforms: readonly EntryLike[];
  directories: readonly EntryLike[];
}): PlatformRule[] {
  const tagged = [
    ...config.platforms.map((e) => ({ e, directory: false })),
    ...config.directories.map((e) => ({ e, directory: true })),
  ];
  return tagged.map(({ e, directory }) => {
    const fromUrls = e.urls.flatMap((u) => {
      const h = hostOf(u.replace("{yyyy-mm}", "2000-01"));
      return h ? [registrableDomain(h)] : [];
    });
    return {
      name: e.name,
      allowed: e.allowed,
      domains: [...new Set(e.domains && e.domains.length > 0 ? e.domains : fromUrls)],
      listing_url_pattern: e.listing_url_pattern ?? null,
      directory,
      event_url_pattern: e.event_url_pattern ?? null,
    };
  });
}

function matches(pattern: string, subject: string, flags = ""): boolean {
  try {
    return new RegExp(pattern, flags).test(subject);
  } catch {
    return false;
  }
}

function domainMatches(registrable: string, entry: string): boolean {
  const d = entry.toLowerCase();
  if (d.endsWith(".*")) return registrable.split(".")[0] === d.slice(0, -2);
  return registrable === d;
}

export interface PlatformVerdict {
  platform: string;
  allowed: boolean;
  /** A listing or search page (or a directory's index page), never an outing's canonical source. */
  listing: boolean;
  /** The URL is on a directory's domain (an event page when `listing` is false). */
  directory: boolean;
}

/** Which platform or directory `url` belongs to, if any, and whether it is a listing page. */
export function platformVerdict(url: string, rules: readonly PlatformRule[]): PlatformVerdict | null {
  const host = hostOf(url);
  if (!host) return null;
  const reg = registrableDomain(host);
  const rule = rules.find((r) => r.domains.some((d) => domainMatches(reg, d)));
  if (!rule) return null;
  let listing = false;
  if (rule.listing_url_pattern) listing = matches(rule.listing_url_pattern, new URL(url).pathname);
  const directory = rule.directory === true;
  // Same test the listing adapter applies (sources.ts): the full URL, case-insensitive.
  if (directory && rule.event_url_pattern && !matches(rule.event_url_pattern, url, "i")) listing = true;
  return { platform: rule.name, allowed: rule.allowed, listing, directory };
}

/** True when a page from `url` may not stand for an outing: a disallowed platform, or any platform's listing page. */
export function blockedAsSource(url: string, rules: readonly PlatformRule[]): PlatformVerdict | null {
  const v = platformVerdict(url, rules);
  return v && (!v.allowed || v.listing) ? v : null;
}
