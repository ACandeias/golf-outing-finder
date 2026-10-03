import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBudget } from "@gof/shared/budget";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/paths.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { normalize, sha256Hex } from "./normalize.ts";
import { normalizedPageSchema, type Context, type FetchedPage } from "./types.ts";

const ctx: Context = {
  now: new Date("2026-09-28T12:00:00Z"),
  caps: resolveBudget("nightly"),
  overrides: emptyOverrides(),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  clock: { nowMs: () => 0 },
};

const fixture = (id: string) => ({
  html: readFileSync(join(REPO_ROOT, "tests/fixtures/raw", `${id}.html`), "utf8"),
  page: JSON.parse(readFileSync(join(REPO_ROOT, "tests/fixtures/pages", `${id}.json`), "utf8")) as {
    url: string;
    text: string;
  },
});

function fetched(patch: Partial<FetchedPage>): FetchedPage {
  return {
    requested_url: "https://example.org/e",
    url: "https://example.org/e",
    kind: "organizer",
    found_via: "submission",
    fetched_at: "2026-09-28T12:00:00.000Z",
    http_status: 200,
    outcome: "ok",
    content_type: "text/html",
    html: null,
    pdf_text: null,
    rendered: false,
    error: null,
    recheck_outing_id: null,
    directory_host: null,
    ...patch,
  };
}

describe("normalize", () => {
  it("turns the NKF Winged Foot page into the recorded text, hash and JSON-LD event", () => {
    const { html, page } = fixture("s06-nkf-winged-foot");
    const out = normalize(ctx, {
      pages: [fetched({ url: page.url, requested_url: page.url, html, rendered: true })],
      previousHashes: {},
    });
    const [p] = out.output.pages;
    expect(normalizedPageSchema.parse(p)).toBeTruthy();
    expect(p?.text).toBe(page.text);
    expect(p?.hash).toBe(sha256Hex(page.text));
    expect(p?.unchanged).toBe(false);
    expect(p?.needs_render).toBe(false);
    expect(p?.jsonld_events[0]).toMatchObject({
      name: "2026 NKF Golf Classic at Winged Foot Golf Club",
      start_date: "2026-10-19",
      start_time: "10:00",
    });
  });

  it("marks a page unchanged when the hash matches the last one", () => {
    const { html, page } = fixture("s02-builders-institute-metropolis");
    const out = normalize(ctx, {
      pages: [fetched({ url: page.url, requested_url: page.url, html })],
      previousHashes: { [page.url]: sha256Hex(page.text) },
    });
    expect(out.output.pages[0]?.unchanged).toBe(true);
    expect(out.result.counters.pages_unchanged).toBe(1);
  });

  it("flags short plain-fetch pages for a render, never rendered ones", () => {
    const short = "<html><body><div id=app></div><p>Loading golf classic…</p></body></html>";
    const out = normalize(ctx, {
      pages: [fetched({ html: short }), fetched({ html: short, rendered: true, url: "https://example.org/r" })],
      previousHashes: {},
    });
    expect(out.output.pages.map((p) => p.needs_render)).toEqual([true, false]);
  });

  it("uses PDF text and never asks to render a PDF", () => {
    const out = normalize(ctx, {
      pages: [fetched({ content_type: "application/pdf", pdf_text: "Flyer  text\n\n\n\nmore" })],
      previousHashes: {},
    });
    expect(out.output.pages[0]).toMatchObject({ text: "Flyer text\n\nmore", needs_render: false, jsonld: [] });
  });

  it("turns a 304 into an unchanged page with the previous hash", () => {
    const h = sha256Hex("old");
    const out = normalize(ctx, {
      pages: [
        fetched({ outcome: "not_modified", http_status: 304, requested_url: "https://example.org/e" }),
        fetched({ outcome: "not_modified", http_status: 304, url: "https://example.org/nohash", requested_url: "https://example.org/nohash" }),
      ],
      previousHashes: { "https://example.org/e": h },
    });
    expect(out.output.pages).toHaveLength(1);
    expect(out.output.pages[0]).toMatchObject({ hash: h, unchanged: true, text: "" });
    expect(out.output.failed).toHaveLength(1);
  });

  it("passes failures through", () => {
    const out = normalize(ctx, {
      pages: [
        fetched({ outcome: "not_found", http_status: 404 }),
        fetched({ outcome: "robots_blocked", http_status: null }),
        fetched({ outcome: "ok", html: null, pdf_text: null }),
      ],
      previousHashes: {},
    });
    expect(out.output.pages).toEqual([]);
    expect(out.output.failed).toHaveLength(3);
  });
});
