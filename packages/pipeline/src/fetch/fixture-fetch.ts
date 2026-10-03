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

export interface FixtureDoc {
  status: number;
  contentType: string;
  body: string;
}

/** URL → document, from the recorded seed pages and the discovery fixtures. */
export function loadFixtureDocs(root = FIXTURES): Map<string, FixtureDoc> {
  const docs = new Map<string, FixtureDoc>();
  const pagesDir = join(root, "pages");
  for (const f of readdirSync(pagesDir).filter((f) => f.endsWith(".json") && !f.includes(".synthetic."))) {
    const id = f.replace(/\.json$/, "");
    const raw = join(root, "raw", `${id}.html`);
    const page = pageFixtureSchema.parse(JSON.parse(readFileSync(join(pagesDir, f), "utf8")));
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
