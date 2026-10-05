import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { GuardedPageFetcher } from "../fetch/fetcher.ts";
import { FetchBudgetExhausted } from "../fetch/fetcher.ts";
import { decodeBody } from "../fetch/http.ts";
import type { SeriesEntry } from "../overrides/load.ts";
import type { BudgetCheck, ListingLink, ListingSource, Logger } from "../stages/types.ts";
import { extractLinks, looksLikeEventLink, parseSitemap } from "./links.ts";
import { normalizeUrl, sameSite } from "./url.ts";

/**
 * Listing sources (SPEC.md 8.2 items 3 to 6): series index pages from
 * series.yaml (daily), and the platforms, association calendars and
 * directories in data/overrides/platforms.yaml, each with an `allowed` flag
 * that stays false until the owner confirms the site's terms.
 */

export const PLATFORMS_FILE = "platforms.yaml";

const listingEntrySchema = z
  .object({
    name: z.string().min(1),
    allowed: z.boolean().default(false),
    terms_url: z.string().url().optional(),
    terms_checked: z.string().optional(),
    adapter: z.enum(["page", "links", "sitemap"]),
    cadence: z.enum(["daily", "weekly"]).default("weekly"),
    months_ahead: z.number().int().min(1).max(12).default(1),
    urls: z.array(z.string().min(1)).default([]),
    /** Registrable domains the site uses (`eventbrite.*` for every country code); default: those of `urls`. */
    domains: z.array(z.string().min(1)).optional(),
    /** Path regex for listing and search pages, which never stand for one outing (platform-policy.ts). */
    listing_url_pattern: z
      .string()
      .optional()
      .refine((p) => {
        if (p === undefined) return true;
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, "not a valid regular expression"),
    event_url_pattern: z
      .string()
      .optional()
      .refine((p) => {
        if (p === undefined) return true;
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, "not a valid regular expression"),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.adapter !== "page" && !e.event_url_pattern) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${e.name}: ${e.adapter} needs event_url_pattern` });
    }
  });
export type ListingEntry = z.infer<typeof listingEntrySchema>;

const platformsFileSchema = z
  .object({
    platforms: z.array(listingEntrySchema).nullable().default([]).transform((v) => v ?? []),
    associations: z.array(listingEntrySchema).nullable().default([]).transform((v) => v ?? []),
    directories: z.array(listingEntrySchema).nullable().default([]).transform((v) => v ?? []),
  })
  .strict();
export type ListingConfig = z.infer<typeof platformsFileSchema>;

export function parsePlatformsYaml(text: string): ListingConfig {
  const r = platformsFileSchema.safeParse(parse(text) ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${PLATFORMS_FILE}: ${issues.join("; ")}`);
  }
  return r.data;
}

export async function loadPlatforms(overridesDir: string): Promise<ListingConfig> {
  return parsePlatformsYaml(await readFile(join(overridesDir, PLATFORMS_FILE), "utf8"));
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Daily sources run every night; a weekly source runs on its own fixed night. */
export function sourceDueTonight(entry: Pick<ListingEntry, "name" | "cadence">, now: Date): boolean {
  if (entry.cadence === "daily") return true;
  return Math.floor(now.getTime() / DAY_MS) % 7 === stableHash(entry.name) % 7;
}

/** Expands `{yyyy-mm}` to this month and the next `monthsAhead - 1` months (UTC). */
export function expandUrls(urls: readonly string[], monthsAhead: number, now: Date): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (!u.includes("{yyyy-mm}")) {
      out.push(u);
      continue;
    }
    for (let i = 0; i < monthsAhead; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      out.push(u.replace("{yyyy-mm}", d.toISOString().slice(0, 7)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ListingSource edge
// ---------------------------------------------------------------------------

export interface ListingSourceDeps {
  fetcher: GuardedPageFetcher;
  config: ListingConfig;
  series: readonly SeriesEntry[];
  registrationHosts: readonly string[];
  now: Date;
  log: Logger;
  /** At most this many links per listing source (keeps one big sitemap from flooding the queue). */
  maxLinksPerSource?: number;
}

export const MAX_LINKS_PER_SOURCE = 500;
const MAX_CHILD_SITEMAPS = 5;

type Kind = "platform" | "association" | "directory";

export function createListingSource(deps: ListingSourceDeps): ListingSource {
  const cap = deps.maxLinksPerSource ?? MAX_LINKS_PER_SOURCE;

  const fetchText = async (url: string, budget: BudgetCheck): Promise<{ url: string; text: string } | null> => {
    const r = await deps.fetcher.fetchRaw(url, budget);
    if (r.kind !== "response" || r.status < 200 || r.status >= 300) {
      deps.log.info("listing page not read", { url, result: r.kind === "response" ? r.status : r.kind });
      return null;
    }
    return { url: r.url, text: decodeBody(r.body, r.contentType) };
  };

  async function fromEntry(kind: Kind, e: ListingEntry, budget: BudgetCheck): Promise<ListingLink[]> {
    const urls = expandUrls(e.urls, e.months_ahead, deps.now);
    const pattern = e.event_url_pattern ? new RegExp(e.event_url_pattern, "i") : null;
    const out: ListingLink[] = [];
    const push = (url: string, title: string | null) => {
      if (out.length >= cap) return;
      out.push({ found_via: kind, origin: e.name, url, title, text: null, registration_url: null });
    };
    for (const listUrl of urls) {
      if (e.adapter === "page") {
        const u = normalizeUrl(listUrl);
        if (u) push(u, null);
        continue;
      }
      const page = await fetchText(listUrl, budget);
      if (!page) continue;
      if (e.adapter === "links") {
        for (const l of extractLinks(page.text, page.url)) {
          if (pattern?.test(l.url) && l.url !== normalizeUrl(page.url)) push(l.url, l.text || null);
        }
        continue;
      }
      // sitemap: a urlset, or an index whose children matching the pattern's host are read.
      const sm = parseSitemap(page.text);
      const children = sm.sitemaps.slice(0, MAX_CHILD_SITEMAPS);
      const all = [...sm.urls];
      for (const child of children) {
        const c = await fetchText(child, budget);
        if (c) all.push(...parseSitemap(c.text).urls);
      }
      for (const u of all) if (pattern?.test(u)) push(u, null);
    }
    return out;
  }

  async function fromSeries(s: SeriesEntry, budget: BudgetCheck): Promise<ListingLink[]> {
    const page = await fetchText(s.index_url, budget);
    if (!page) return [];
    const out: ListingLink[] = [];
    for (const l of extractLinks(page.text, page.url)) {
      if (out.length >= cap) break;
      const onSite = sameSite(l.url, s.index_url) ||
        deps.registrationHosts.some((h) => {
          const host = new URL(l.url).hostname;
          return host === h || host.endsWith(`.${h}`);
        });
      if (!onSite || !looksLikeEventLink(l, s.index_url)) continue;
      out.push({ found_via: "series", origin: s.id, url: l.url, title: l.text || null, text: null, registration_url: null });
    }
    return out;
  }

  return {
    async links(budget: BudgetCheck): Promise<ListingLink[]> {
      const out: ListingLink[] = [];
      try {
        for (const s of deps.series) out.push(...(await fromSeries(s, budget)));
        const groups: [Kind, ListingEntry[]][] = [
          ["platform", deps.config.platforms],
          ["association", deps.config.associations],
          ["directory", deps.config.directories],
        ];
        for (const [kind, entries] of groups) {
          for (const e of entries) {
            if (!e.allowed) {
              deps.log.debug("listing source not allowed yet", { source: e.name });
              continue;
            }
            if (!sourceDueTonight(e, deps.now)) continue;
            out.push(...(await fromEntry(kind, e, budget)));
          }
        }
      } catch (err) {
        if (!(err instanceof FetchBudgetExhausted)) throw err;
        deps.log.warn("listing sources stopped: fetch budget used up");
      }
      return out;
    },
  };
}
