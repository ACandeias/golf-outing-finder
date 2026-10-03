import type { Clock } from "../stages/types.ts";

/**
 * robots.txt (RFC 9309) for the crawler (SPEC.md 8.3): the groups naming
 * `GolfOutingFinderBot` win over `*`; within the chosen groups the longest
 * matching rule wins and `allow` wins a tie; `*` and `$` are supported.
 * Crawl-delay is honored up to 30 s. Files are cached per origin for 24 hours.
 */

export const ROBOTS_AGENT = "golfoutingfinderbot";
export const ROBOTS_TTL_MS = 24 * 3600_000;
/** A robots.txt that could not be read (5xx, network) is retried sooner. */
export const ROBOTS_ERROR_TTL_MS = 3600_000;
export const MAX_CRAWL_DELAY_MS = 30_000;
/** RFC 9309 lets crawlers stop parsing after 500 KiB. */
export const MAX_ROBOTS_BYTES = 500 * 1024;

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelaySec: number | null;
}

export interface Robots {
  /** Groups that apply to us: ours if any, else `*`. Empty means allow all. */
  rules: Rule[];
  crawlDelayMs: number;
  sitemaps: string[];
  /** Set for a robots.txt that could not be fetched (5xx or network): disallow all. */
  unreachable?: boolean;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
}

function canonicalPath(p: string): string {
  // Compare in percent-encoded form so `/café` and `/caf%C3%A9` match.
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = canonicalPath(anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** The product token a user-agent line names: `GolfOutingFinderBot/1.0` gives `golfoutingfinderbot`. */
function productToken(value: string): string {
  return (value.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

export function parseRobots(text: string, agent = ROBOTS_AGENT): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value === "*" ? "*" : productToken(value));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "") continue; // an empty Disallow allows everything
      current.rules.push({ allow: key === "allow", pattern: value, re: compile(value) });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }
  const mine = groups.filter((g) => g.agents.includes(agent));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  const delays = chosen.map((g) => g.crawlDelaySec).filter((d): d is number => d !== null);
  const delaySec = delays.length > 0 ? Math.max(...delays) : 0;
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelayMs: Math.min(MAX_CRAWL_DELAY_MS, Math.round(delaySec * 1000)),
    sitemaps,
  };
}

/** Whether `pathAndQuery` (path plus `?query`) may be fetched. */
export function robotsDecision(robots: Robots, pathAndQuery: string): RobotsDecision {
  if (robots.unreachable) return { allowed: false, crawlDelayMs: robots.crawlDelayMs };
  if (pathAndQuery === "/robots.txt") return { allowed: true, crawlDelayMs: robots.crawlDelayMs };
  const path = canonicalPath(pathAndQuery);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (!r.re.test(path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return { allowed: best ? best.allow : true, crawlDelayMs: robots.crawlDelayMs };
}

/** Fetches `{origin}/robots.txt` (through the SSRF guard, with our user agent). */
export type RobotsFetch = (url: string) => Promise<{ status: number; body: string }>;

export interface RobotsCacheOptions {
  fetchRobots: RobotsFetch;
  clock: Clock;
}

interface Entry {
  robots: Robots;
  expiresMs: number;
}

/** Per-origin robots.txt cache, 24 hours (one hour for an unreachable file). */
export class RobotsCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly opts: RobotsCacheOptions;

  constructor(opts: RobotsCacheOptions) {
    this.opts = opts;
  }

  async check(url: string): Promise<RobotsDecision> {
    const u = new URL(url);
    const robots = await this.forOrigin(u.origin);
    return robotsDecision(robots, `${u.pathname}${u.search}`);
  }

  async forOrigin(origin: string): Promise<Robots> {
    const now = this.opts.clock.nowMs();
    const hit = this.entries.get(origin);
    if (hit && hit.expiresMs > now) return hit.robots;
    let p = this.inflight.get(origin);
    if (!p) {
      p = this.load(origin).finally(() => this.inflight.delete(origin));
      this.inflight.set(origin, p);
    }
    return (await p).robots;
  }

  private async load(origin: string): Promise<Entry> {
    const now = this.opts.clock.nowMs();
    let entry: Entry;
    try {
      const res = await this.opts.fetchRobots(`${origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) {
        entry = { robots: parseRobots(res.body), expiresMs: now + ROBOTS_TTL_MS };
      } else if (res.status >= 400 && res.status < 500) {
        // RFC 9309: 4xx means no robots.txt, so everything is allowed.
        entry = { robots: parseRobots(""), expiresMs: now + ROBOTS_TTL_MS };
      } else {
        entry = { robots: unreachable(), expiresMs: now + ROBOTS_ERROR_TTL_MS };
      }
    } catch {
      entry = { robots: unreachable(), expiresMs: now + ROBOTS_ERROR_TTL_MS };
    }
    this.entries.set(origin, entry);
    return entry;
  }
}

function unreachable(): Robots {
  return { rules: [], crawlDelayMs: 0, sitemaps: [], unreachable: true };
}
