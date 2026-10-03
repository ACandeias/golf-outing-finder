import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import type { Resolver } from "../net/ssrf.ts";
import type { FetchFn } from "./http.ts";

/**
 * Offline stand-ins for the network, used by tests and `--dry-run`:
 * a FetchFn that serves recorded pages (tests/fixtures/raw by the URL in
 * tests/fixtures/pages) and the hand-written listing pages in
 * tests/fixtures/discovery, and a resolver that answers every public-looking
 * host with one public address. Nothing here opens a socket.
 */

const FIXTURES = join(REPO_ROOT, "tests/fixtures");
/** example.com's address: public, so the SSRF guard lets fixture hosts through. */
export const FIXTURE_ADDRESS = "93.184.216.34";

const pageFixtureSchema = z.object({ url: z.string().nullable(), http_status: z.number().nullable() });
const syntheticPageSchema = z.object({
  url: z.string().nullable(),
  text: z.string(),
  jsonld: z.array(z.unknown()),
  synthetic: z.literal(true).optional(),
});

/** The URL a page fixture stands for; s15 has none, so it gets the reserved .invalid TLD. */
export function fixturePageUrl(id: string, url: string | null): string {
  return url ?? `https://fixtures.invalid/${id}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A plain HTML document for a page fixture that has no usable raw HTML: the
 * hand-written `*.synthetic.json` stand-ins (gc1's page is gone, gc5's sits
 * behind a login) and the synthetic gc7 page. Text is escaped and split into
 * paragraphs; JSON-LD blocks ride along as script tags, as on a real page.
 */
export function syntheticHtml(text: string, jsonld: readonly unknown[]): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const title = escapeHtml(lines[0] ?? "Fixture");
  const scripts = jsonld
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`)
    .join("");
  const body = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${scripts}</head><body><main><article>${body}</article></main></body></html>`;
}

export interface FixtureDoc {
  status: number;
  contentType: string;
  body: string;
}

/**
 * URL → document, from the recorded seed pages and the discovery fixtures. A
 * page with a hand-written `{id}.synthetic.json` stand-in is served from that
 * text instead of its raw recording (the golden harness prefers it the same
 * way), and a page fixture with no raw HTML at all (s15) is served from its
 * text at its `fixturePageUrl`.
 */
export function loadFixtureDocs(root = FIXTURES): Map<string, FixtureDoc> {
  const docs = new Map<string, FixtureDoc>();
  const pagesDir = join(root, "pages");
  const files = readdirSync(pagesDir).sort();
  for (const f of files.filter((f) => f.endsWith(".synthetic.json"))) {
    const id = f.replace(/\.synthetic\.json$/, "");
    const page = syntheticPageSchema.parse(JSON.parse(readFileSync(join(pagesDir, f), "utf8")));
    const url = fixturePageUrl(id, page.url);
    if (!docs.has(url))
      docs.set(url, { status: 200, contentType: "text/html; charset=utf-8", body: syntheticHtml(page.text, page.jsonld) });
  }
  for (const f of files.filter((f) => f.endsWith(".json") && !f.includes(".synthetic."))) {
    const id = f.replace(/\.json$/, "");
    const raw = join(root, "raw", `${id}.html`);
    const parsed: unknown = JSON.parse(readFileSync(join(pagesDir, f), "utf8"));
    const page = pageFixtureSchema.parse(parsed);
    if (!page.url && !existsSync(raw)) {
      const text = syntheticPageSchema.safeParse(parsed);
      const url = fixturePageUrl(id, null);
      if (text.success && !docs.has(url))
        docs.set(url, { status: 200, contentType: "text/html; charset=utf-8", body: syntheticHtml(text.data.text, text.data.jsonld) });
      continue;
    }
    if (!page.url || !existsSync(raw) || docs.has(page.url)) continue;
    docs.set(page.url, {
      status: page.http_status ?? 200,
      contentType: "text/html; charset=utf-8",
      body: readFileSync(raw, "utf8"),
    });
  }
  const indexFile = join(root, "discovery", "index.json");
  if (existsSync(indexFile)) {
    const index = z.record(z.string()).parse(JSON.parse(readFileSync(indexFile, "utf8")));
    for (const [url, file] of Object.entries(index)) {
      if (!/^https?:\/\//.test(url)) continue;
      docs.set(url, {
        status: 200,
        contentType: file.endsWith(".xml") ? "application/xml" : "text/html; charset=utf-8",
        body: readFileSync(join(root, "discovery", file), "utf8"),
      });
    }
  }
  return docs;
}

/** Serves fixture documents; robots.txt and unknown URLs are 404. Records every URL asked for. */
export function fixtureFetch(docs: ReadonlyMap<string, FixtureDoc> = loadFixtureDocs()): {
  fetchFn: FetchFn;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    requested.push(url);
    const doc = docs.get(url);
    if (!doc) return new Response("not in the fixtures", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(doc.body, { status: doc.status, headers: { "content-type": doc.contentType } });
  };
  return { fetchFn, requested };
}

/** Every dotted host resolves to one public address; nothing is looked up. */
export const fixtureResolver: Resolver = async (host) =>
  host.includes(".") && !host.endsWith(".internal") ? [FIXTURE_ADDRESS] : [];
