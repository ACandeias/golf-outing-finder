/**
 * One-time Phase 0 recorder for seed page fixtures (SPEC §11, §13).
 *
 * Free HTTP only: no Claude API, no SERP API. Fetches the source page of every
 * open, excluded and synthetic seed entry, saves the raw HTML to
 * tests/fixtures/raw/{id}.html and a normalized record to
 * tests/fixtures/pages/{id}.json. Honors robots.txt for our user agent.
 *
 * Usage: node packages/pipeline/scripts/record-seed-fixtures.ts [--only=id1,id2]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chromium, type Browser } from "playwright";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SITE_URL = process.env.PUBLIC_SITE_URL ?? "http://localhost:8787";
const USER_AGENT = `GolfOutingFinderBot/1.0 (+${SITE_URL}/bot)`;
const MAX_TEXT = 12_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 25_000;
const ATTEMPTS = 3; // first try plus two retries

const SeedEntry = z
  .object({
    id: z.string(),
    status: z.enum(["open", "excluded", "expected", "synthetic"]),
    source_url: z.string().url().optional(),
    event_url: z.string().url().optional(),
    render_required: z.boolean().optional(),
    fixture_text: z.string().optional(),
  })
  .passthrough();
const SeedFile = z.object({ outings: z.array(SeedEntry) }).passthrough();
type SeedEntry = z.infer<typeof SeedEntry>;

export interface PageFixture {
  url: string | null;
  fetched_at: string;
  http_status: number | null;
  text: string;
  jsonld: unknown[];
}

interface LinkCandidate {
  text: string;
  href: string;
}

const BLOCK_TAGS =
  /<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figure|aside|main|nav)>|<br\s*\/?>/gi;

function htmlToText(html: string): string {
  const withBreaks = html.replace(BLOCK_TAGS, (m) => `${m}\n`);
  const { document } = parseHTML(`<!doctype html><html><body>${withBreaks}</body></html>`);
  const raw = document.body?.textContent ?? "";
  return raw
    .split("\n")
    .map((line: string) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line: string, i: number, arr: string[]) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractJsonLd(html: string): unknown[] {
  const { document } = parseHTML(html);
  const out: unknown[] = [];
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = (node as { textContent: string | null }).textContent ?? "";
    const cleaned = raw.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
    if (!cleaned) continue;
    try {
      out.push(JSON.parse(cleaned));
    } catch {
      // Some sites emit control characters inside strings; try once more without them.
      try {
        out.push(JSON.parse(cleaned.replace(/[\u0000-\u001f]+/g, " ")));
      } catch {
        // unparseable block: skip it
      }
    }
  }
  return out;
}

/**
 * Accordions and tabs often mark their panels aria-hidden or hidden until clicked.
 * Readability skips those, which drops the event details on calendar pages
 * (azgolf.org), so un-hide them before parsing.
 */
function unhide(document: { querySelectorAll: (s: string) => ArrayLike<unknown> }): void {
  for (const node of Array.from(document.querySelectorAll("[aria-hidden],[hidden]"))) {
    const el = node as { removeAttribute: (n: string) => void };
    el.removeAttribute("aria-hidden");
    el.removeAttribute("hidden");
  }
}

export function mainText(html: string, url: string): string {
  const { document } = parseHTML(html);
  unhide(document);
  let text = "";
  try {
    const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    if (article?.content) text = htmlToText(article.content);
  } catch {
    text = "";
  }
  // Readability can keep a single panel of a list-style page (association calendars),
  // so fall back to the cleaned body text when it returns too little.
  const { document: doc2 } = parseHTML(html);
  unhide(doc2);
  for (const el of Array.from(
    doc2.querySelectorAll("script,style,noscript,svg,template,nav,header,footer,form,iframe"),
  )) {
    (el as { remove: () => void }).remove();
  }
  const bodyText = htmlToText(doc2.body?.innerHTML ?? "");
  if (text.length < 400 || text.length < bodyText.length * 0.25) text = bodyText;
  void url;
  return text.slice(0, MAX_TEXT);
}

function linkCandidates(html: string, base: string): LinkCandidate[] {
  const { document } = parseHTML(html);
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const el = a as { getAttribute: (n: string) => string | null; textContent: string | null };
    const href = el.getAttribute("href") ?? "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    const hay = `${text} ${abs}`.toLowerCase();
    if (
      /regist|sign ?up|tickets?|buy|golfer|foursome|donate|sponsor|golfstatus|tourneylinks|golfgenius|birdease|givesmart|onecause|classy|eventbrite|zeffy|givebutter|qgiv|donorbox|networkforgood|bloomerang|website/.test(
        hay,
      ) &&
      !seen.has(abs)
    ) {
      seen.add(abs);
      out.push({ text: text.slice(0, 120), href: abs });
    }
  }
  return out;
}

// --- credential redaction ----------------------------------------------
/**
 * Third-party pages embed API keys (Mapbox, Google Maps, Stripe...). They are not
 * ours to republish, and GitHub push protection rejects them, so fixtures store a
 * placeholder instead.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|tk)\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // Mapbox
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g, // Stripe
  /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g, // Slack
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

export function redactCredentials(input: string): string {
  let out = input;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, "REDACTED_CREDENTIAL");
  return out;
}

// --- robots.txt ---------------------------------------------------------
const robotsCache = new Map<string, string>();

async function robotsTxt(origin: string): Promise<string> {
  const cached = robotsCache.get(origin);
  if (cached !== undefined) return cached;
  let body = "";
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    body = res.ok ? await res.text() : "";
  } catch {
    body = "";
  }
  robotsCache.set(origin, body);
  return body;
}

/** Minimal robots.txt check: groups for our bot name win over `*`; longest match wins. */
export function robotsAllows(robots: string, path: string, agent = "golfoutingfinderbot"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value === "" && key === "disallow") continue;
      current.rules.push({ allow: key === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const anchored = pattern.endsWith("\\$") ? `${pattern.slice(0, -2)}$` : pattern;
      if (new RegExp(`^${anchored}`).test(path)) {
        if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) {
          best = { allow: r.allow, len: r.path.length };
        }
      }
    }
  }
  return best ? best.allow : true;
}

// --- fetchers -----------------------------------------------------------
interface Fetched {
  finalUrl: string;
  status: number;
  html: string;
}

async function fetchPlain(url: string): Promise<Fetched> {
  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new Error(`body over ${MAX_BODY_BYTES} bytes`);
  return { finalUrl: res.url || url, status: res.status, html: new TextDecoder().decode(buf) };
}

let browserPromise: Promise<Browser> | null = null;

async function fetchRendered(url: string): Promise<Fetched> {
  browserPromise ??= chromium.launch();
  const browser = await browserPromise;
  const context = await browser.newContext({ userAgent: USER_AGENT, javaScriptEnabled: true });
  try {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // long-polling pages never go idle; take what is there
    }
    const html = await page.content();
    return { finalUrl: page.url(), status: resp?.status() ?? 0, html };
  } finally {
    await context.close();
  }
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`  ${label}: attempt ${i + 1} failed: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

// --- main ---------------------------------------------------------------
async function main(): Promise<void> {
  const only = process.argv
    .find((a) => a.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",");
  const seed = SeedFile.parse(JSON.parse(await readFile(join(ROOT, "seed/outings.json"), "utf8")));
  const targets = seed.outings.filter(
    (o) => o.status !== "expected" && (!only || only.includes(o.id)),
  );
  const rawDir = join(ROOT, "tests/fixtures/raw");
  const pagesDir = join(ROOT, "tests/fixtures/pages");
  const linksDir = join(ROOT, ".cache/fixture-links");
  await mkdir(rawDir, { recursive: true });
  await mkdir(pagesDir, { recursive: true });
  await mkdir(linksDir, { recursive: true });

  const missing: { id: string; url: string; reason: string }[] = [];
  const lastHit = new Map<string, number>();

  for (const entry of targets) {
    const fetchedAt = new Date().toISOString();
    if (entry.status === "synthetic") {
      const record: PageFixture = {
        url: null,
        fetched_at: fetchedAt,
        http_status: null,
        text: (entry.fixture_text ?? "").slice(0, MAX_TEXT),
        jsonld: [],
      };
      await writeFile(join(pagesDir, `${entry.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${entry.id}: synthetic record from fixture_text`);
      continue;
    }
    const url = entry.event_url ?? entry.source_url;
    if (!url) {
      missing.push({ id: entry.id, url: "(none)", reason: "no source_url" });
      continue;
    }
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      missing.push({ id: entry.id, url, reason: "scheme not allowed" });
      continue;
    }
    const robots = await robotsTxt(u.origin);
    if (!robotsAllows(robots, u.pathname + u.search)) {
      missing.push({ id: entry.id, url, reason: "blocked by robots.txt" });
      console.log(`${entry.id}: robots.txt disallows ${url}`);
      continue;
    }
    // Be polite: at least 5 s between requests to the same host.
    const prev = lastHit.get(u.host);
    if (prev) {
      const wait = 5000 - (Date.now() - prev);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await withRetries(entry.id, async () => {
        let r = entry.render_required ? await fetchRendered(url) : await fetchPlain(url);
        if (r.status === 403 && !entry.render_required) {
          // Some hosts serve a JavaScript check to plain clients; try one headless render
          // with the same honest user agent before giving up.
          console.warn(`  ${entry.id}: HTTP 403 on plain fetch, trying a headless render`);
          r = await fetchRendered(url);
        }
        if (r.status >= 500 || r.status === 0) throw new Error(`HTTP ${r.status}`);
        return { ...r, html: redactCredentials(r.html) };
      });
      lastHit.set(u.host, Date.now());
      if (res.status >= 400) {
        missing.push({ id: entry.id, url, reason: `HTTP ${res.status}` });
      }
      const record: PageFixture = {
        url: res.finalUrl,
        fetched_at: fetchedAt,
        http_status: res.status,
        text: mainText(res.html, res.finalUrl),
        jsonld: extractJsonLd(res.html),
      };
      await writeFile(join(rawDir, `${entry.id}.html`), res.html);
      await writeFile(join(pagesDir, `${entry.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(
        join(linksDir, `${entry.id}.json`),
        `${JSON.stringify(linkCandidates(res.html, res.finalUrl), null, 2)}\n`,
      );
      console.log(
        `${entry.id}: HTTP ${res.status}, ${record.text.length} chars, ${record.jsonld.length} JSON-LD blocks${entry.render_required ? " (rendered)" : ""}`,
      );
    } catch (err) {
      missing.push({ id: entry.id, url, reason: `failed after ${ATTEMPTS} attempts: ${String(err)}` });
    }
  }

  if (browserPromise) await (await browserPromise).close();

  if (missing.length > 0) {
    console.log("\nMISSING:");
    for (const m of missing) console.log(`- ${m.id} ${m.url}: ${m.reason}`);
    await writeFile(
      join(ROOT, ".cache/fixture-missing.json"),
      `${JSON.stringify(missing, null, 2)}\n`,
    );
  }
}

await main();
