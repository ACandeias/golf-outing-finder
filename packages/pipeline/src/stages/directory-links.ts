import { extractLinks, looksLikeOrganizerLink } from "../discovery/links.ts";
import { blockedAsSource, platformVerdict, type PlatformRule } from "../discovery/platform-policy.ts";
import { hostOf, normalizeUrl } from "../discovery/url.ts";
import { registrableDomain } from "../extract/domain.ts";
import { isExcludedUrl, removedUrlSet } from "../overrides/load.ts";
import { PRIORITY } from "./discover.ts";
import type { Context, FetchedPage, QueueEntry } from "./types.ts";

/**
 * SPEC.md 8.2 item 6: "Enqueue each listing's event page and the organizer and
 * registration links found on it." When a directory event page (Play Private
 * Golf's "Official event page" and "Official golfer registration" links) has
 * been fetched, its off-directory organizer and registration links go to
 * discovery_queue as organizer pages. They are fetched and extracted on their
 * own on a later run, so the outing can publish with the organizer's page as
 * its canonical source and its own registration link, even when the
 * directory's registration link was on a host registration-hosts.yaml doesn't
 * list. Pure; the fetch handler writes the rows.
 *
 * The gates are the ones every other URL passes: normalized, exclusions.yaml,
 * removals.yaml, platforms.yaml (no disallowed platform, no listing page),
 * never the directory's own pages, nothing fetched this run or already queued.
 * The 7-day dedupe and the per-host caps apply when the row comes back through
 * discover and planFetch.
 */

/** A directory page links to one organizer and a registration form or two; more is navigation. */
export const MAX_LINKS_PER_DIRECTORY_PAGE = 5;

export interface DirectoryLinksInput {
  pages: readonly FetchedPage[];
  platform_rules: readonly PlatformRule[];
  /** URLs already in discovery_queue or otherwise known; not queued again. */
  known?: readonly string[];
}

export interface DirectoryLinksOutput {
  queue: QueueEntry[];
  skipped: { url: string; reason: "excluded" | "removed" | "platform_not_allowed" | "platform_listing" }[];
}

export function directoryLinks(ctx: Context, input: DirectoryLinksInput): DirectoryLinksOutput {
  const rules = input.platform_rules;
  const removed = removedUrlSet(ctx.overrides.removals);
  const seen = new Set<string>(input.known?.map((u) => normalizeUrl(u) ?? u) ?? []);
  for (const p of input.pages) {
    seen.add(normalizeUrl(p.requested_url) ?? p.requested_url);
    seen.add(normalizeUrl(p.url) ?? p.url);
  }
  const queue: QueueEntry[] = [];
  const skipped: DirectoryLinksOutput["skipped"] = [];

  for (const p of input.pages) {
    if (p.outcome !== "ok" || p.html === null || p.directory_host === null) continue;
    // Only an event page on a directory we may read; never an index page.
    const verdict = platformVerdict(p.url, rules);
    if (!verdict || !verdict.directory || !verdict.allowed || verdict.listing) continue;
    const directoryDomain = registrableDomain(p.directory_host);

    let taken = 0;
    for (const link of extractLinks(p.html, p.url)) {
      if (taken >= MAX_LINKS_PER_DIRECTORY_PAGE) break;
      const url = normalizeUrl(link.url);
      if (url === null || seen.has(url)) continue;
      const host = hostOf(url);
      if (host === null || registrableDomain(host) === directoryDomain) continue;
      if (!looksLikeOrganizerLink({ url, text: link.text })) continue;
      seen.add(url);
      if (isExcludedUrl(url, ctx.overrides.exclusions)) {
        skipped.push({ url, reason: "excluded" });
        continue;
      }
      if (removed.has(url)) {
        skipped.push({ url, reason: "removed" });
        continue;
      }
      const blocked = blockedAsSource(url, rules);
      if (blocked) {
        skipped.push({ url, reason: blocked.allowed ? "platform_listing" : "platform_not_allowed" });
        continue;
      }
      taken++;
      queue.push({
        url,
        found_via: "directory",
        kind: "organizer",
        priority: PRIORITY.directory,
        bypass_dedupe: false,
        recheck_outing_id: null,
        directory_host: null,
      });
    }
  }
  return { queue, skipped };
}
