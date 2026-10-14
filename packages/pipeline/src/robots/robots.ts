import type { Clock } from "../stages/types.ts";

/**
 * robots.txt (RFC 9309) for the crawler (SPEC.md 8.3): the groups naming
 * `GolfOutingFinderBot` win over `*`; within the chosen groups the longest
 * matching rule wins and `allow` wins a tie; `*` and `$` are supported.
 * Crawl-delay is honored up to 30 s. Files are cached per origin for 24 hours.
 *
 * A robots.txt we could not read is not a green light. 404, 410 and other
 * plain 4xx mean "no robots.txt", so everything is allowed (RFC 9309). But
 * 401, 403 and 429, any 5xx, a network failure, or a bot-challenge page served
 * in place of the file (Cloudflare "Just a moment...", seen on first contact
 * with several platforms on 2026-10-14) make the whole host disallowed for the
 * rest of the run. That outcome is kept only in memory, so the next run asks
 * again.
 */

export const ROBOTS_AGENT = "golfoutingfinderbot";
export const ROBOTS_TTL_MS = 24 * 3600_000;
/** Status codes that mean "we were refused", not "there is no file". */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
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
  /** Why the file could not be read (`HTTP 403`, `challenge page`, a network error): disallow all. */
  unavailable?: string;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
  /** Set when the host is blocked because its robots.txt could not be read this run. */
  unavailable?: string;
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
  if (robots.unavailable !== undefined) {
    return { allowed: false, crawlDelayMs: robots.crawlDelayMs, unavailable: robots.unavailable };
  }
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
  /** Called once per origin whose robots.txt could not be read (the host is skipped this run). */
  onUnavailable?: (origin: string, reason: string) => void;
}

/**
 * Markers of the bot-challenge and WAF interstitials that some hosts serve with
 * a 200 in place of robots.txt. A real robots.txt never contains these.
 */
const CHALLENGE_MARKERS: readonly RegExp[] = [
  /<title>\s*just a moment/i, // Cloudflare managed challenge
  /\/cdn-cgi\/challenge-platform\//i,
  /_cf_chl_opt|cf-chl-|cf_chl_/i,
  /<title>\s*attention required!? \| cloudflare/i,
  /_incapsula_resource|incapsula incident/i, // Imperva
  /sucuri website firewall/i,
  /captcha-delivery\.com/i, // DataDome
  /px-captcha|perimeterx/i,
  /awswaf|gokuprops/i, // AWS WAF
];

/** True for an HTML page that is a bot challenge rather than a robots.txt file. */
export function isChallengePage(body: string): boolean {
  const head = body.slice(0, 64 * 1024);
  if (!/<(!doctype\s+html|html|head|body|script|title)[\s>]/i.test(head)) return false;
  return CHALLENGE_MARKERS.some((re) => re.test(head));
}

interface Entry {
  robots: Robots;
  expiresMs: number;
}

/** Per-origin robots.txt cache: 24 hours, or the rest of the run for a file we could not read. */
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
    let reason: string | null = null;
    let robots: Robots | null = null;
    try {
      const res = await this.opts.fetchRobots(`${origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) {
        if (isChallengePage(res.body)) reason = "challenge page";
        else robots = parseRobots(res.body);
      } else if (REFUSED_STATUSES.has(res.status) || res.status >= 500) {
        reason = `HTTP ${res.status}`;
      } else {
        // RFC 9309: 404, 410 and other 4xx mean there is no robots.txt, so everything is allowed.
        robots = parseRobots("");
      }
    } catch (err) {
      reason = (err instanceof Error ? err.message : String(err)).slice(0, 200) || "network error";
    }
    const entry: Entry =
      robots !== null
        ? { robots, expiresMs: now + ROBOTS_TTL_MS }
        : // Held for the rest of the run: this cache lives only as long as the run.
          { robots: unavailable(reason ?? "unreadable"), expiresMs: Number.POSITIVE_INFINITY };
    this.entries.set(origin, entry);
    if (robots === null) this.opts.onUnavailable?.(origin, entry.robots.unavailable ?? "unreadable");
    return entry;
  }
}

function unavailable(reason: string): Robots {
  return { rules: [], crawlDelayMs: 0, sitemaps: [], unavailable: reason };
}
