import { createHash } from "node:crypto";
import { extractJsonLd, jsonLdEvents, mainText, pdfMainText } from "../fetch/main-text.ts";
import {
  emptyResult,
  RENDER_TEXT_MIN,
  type FetchedPage,
  type NormalizedPage,
  type NormalizeStage,
} from "./types.ts";

/**
 * SPEC.md 8.3, workstream B. Readability main text (with the aria-hidden fix in
 * tests/fixtures/MISSING.md and the body-text fallback), JSON-LD blocks kept
 * separately with their schema.org Events summarized, PDF text from the
 * fetcher, text truncated at 12,000 characters and hashed (sha256 hex);
 * `unchanged` when the hash equals the source's last one; `needs_render` when a
 * plain HTML fetch yields under 400 characters.
 *
 * A 304 Not Modified becomes an unchanged page carrying the previous hash (no
 * text), so extraction is skipped and only `last_verified` moves. Failures and
 * non-HTML/PDF responses go to `failed` for the source bookkeeping.
 */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function previousHash(page: FetchedPage, prev: Readonly<Record<string, string>>): string | null {
  return prev[page.url] ?? prev[page.requested_url] ?? null;
}

export const normalize: NormalizeStage = (ctx, input) => {
  const result = emptyResult();
  const pages: NormalizedPage[] = [];
  const failed: FetchedPage[] = [];
  let unchanged = 0;

  for (const page of input.pages) {
    const prev = previousHash(page, input.previousHashes);
    const base = {
      url: page.url,
      kind: page.kind,
      found_via: page.found_via,
      fetched_at: page.fetched_at,
      http_status: page.http_status,
      rendered: page.rendered,
      recheck_outing_id: page.recheck_outing_id,
      directory_host: page.directory_host,
    };

    if (page.outcome === "not_modified") {
      if (prev === null) {
        failed.push({ ...page, error: page.error ?? "304 without a previous hash" });
        continue;
      }
      unchanged++;
      pages.push({
        ...base,
        text: "",
        jsonld: [],
        jsonld_events: [],
        hash: prev,
        unchanged: true,
        needs_render: false,
      });
      continue;
    }

    if (page.outcome !== "ok" || (page.html === null && page.pdf_text === null)) {
      failed.push(page);
      continue;
    }

    let text: string;
    let jsonld: unknown[] = [];
    if (page.html !== null) {
      try {
        text = mainText(page.html);
        jsonld = extractJsonLd(page.html);
      } catch (err) {
        ctx.log.warn("normalize: could not parse page", { url: page.url, error: String(err) });
        failed.push({ ...page, error: `normalize: ${String(err)}`.slice(0, 500) });
        continue;
      }
    } else {
      text = pdfMainText(page.pdf_text ?? "");
    }

    const hash = sha256Hex(text);
    const same = prev === hash;
    if (same) unchanged++;
    pages.push({
      ...base,
      text,
      jsonld,
      jsonld_events: jsonLdEvents(jsonld),
      hash,
      unchanged: same,
      needs_render: page.html !== null && !page.rendered && text.length < RENDER_TEXT_MIN,
    });
  }

  if (unchanged > 0) result.counters.pages_unchanged = unchanged;
  return { output: { pages, failed }, result };
};
