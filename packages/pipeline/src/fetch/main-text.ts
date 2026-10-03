import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { JsonLdEvent } from "../stages/types.ts";

/**
 * Main text and JSON-LD from HTML (SPEC.md 8.3). Pure and synchronous, so the
 * normalize stage can call it. The text logic is the Phase 0 fixture
 * recorder's (scripts/record-seed-fixtures.ts), so the golden pages in
 * tests/fixtures/pages are exactly what this produces from tests/fixtures/raw:
 * un-hide aria-hidden/hidden panels, run Readability, and fall back to the
 * cleaned body text when Readability keeps too little.
 */

export const MAX_TEXT = 12_000;

const BLOCK_TAGS =
  /<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figure|aside|main|nav)>|<br\s*\/?>/gi;

interface ElementLike {
  removeAttribute(name: string): void;
  remove(): void;
  textContent: string | null;
}
interface DocumentLike {
  querySelectorAll(selector: string): ArrayLike<unknown>;
  body: { innerHTML: string; textContent: string | null } | null;
}

function doc(html: string): DocumentLike {
  return parseHTML(html).document as unknown as DocumentLike;
}

function nodes(d: DocumentLike, selector: string): ElementLike[] {
  return Array.from(d.querySelectorAll(selector)) as ElementLike[];
}

/** HTML fragment to plain text with line breaks at block boundaries. */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(BLOCK_TAGS, (m) => `${m}\n`);
  const d = doc(`<!doctype html><html><body>${withBreaks}</body></html>`);
  const raw = d.body?.textContent ?? "";
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Accordions and tabs hide their panels until clicked; Readability would skip them. */
function unhide(d: DocumentLike): void {
  for (const el of nodes(d, "[aria-hidden],[hidden]")) {
    el.removeAttribute("aria-hidden");
    el.removeAttribute("hidden");
  }
}

/** Readability main text, or the cleaned body text when that is longer by 4x or more. */
export function mainText(html: string): string {
  const d = doc(html);
  unhide(d);
  let text = "";
  try {
    const article = new Readability(d as unknown as ConstructorParameters<typeof Readability>[0], {
      charThreshold: 200,
    }).parse();
    if (article?.content) text = htmlToText(article.content);
  } catch {
    text = "";
  }
  const d2 = doc(html);
  unhide(d2);
  for (const el of nodes(
    d2,
    "script,style,noscript,svg,template,nav,header,footer,form,iframe",
  )) {
    el.remove();
  }
  const bodyText = htmlToText(d2.body?.innerHTML ?? "");
  if (text.length < 400 || text.length < bodyText.length * 0.25) text = bodyText;
  return text.slice(0, MAX_TEXT);
}

/** Every parseable `<script type="application/ld+json">` block, in page order. */
export function extractJsonLd(html: string): unknown[] {
  const d = doc(html);
  const out: unknown[] = [];
  for (const node of nodes(d, 'script[type="application/ld+json"]')) {
    const cleaned = (node.textContent ?? "")
      .replace(/^\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, "")
      .trim();
    if (!cleaned) continue;
    try {
      out.push(JSON.parse(cleaned));
    } catch {
      try {
        out.push(JSON.parse(cleaned.replace(/[\u0000-\u001f]+/g, " ")));
      } catch {
        // an unparseable block is skipped
      }
    }
  }
  return out;
}

/** Plain text of a PDF, tidied like page text and truncated. */
export function pdfMainText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------------------
// schema.org Event blocks
// ---------------------------------------------------------------------------

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function types(o: Record<string, Json>): string[] {
  const t = o["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^.*[/#:]/, ""));
}

/** schema.org Event and its subtypes (SportsEvent, SocialEvent, ...). */
function isEventType(o: Record<string, Json>): boolean {
  return types(o).some((t) => t === "Event" || (t.endsWith("Event") && t !== "EventSeries"));
}

function str(v: Json): string | null {
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return s === "" ? null : s;
  }
  if (Array.isArray(v)) return str(v[0]);
  return null;
}

function address(v: Json): string | null {
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) return address(v[0]);
  if (!isObject(v)) return null;
  const parts = [
    v.streetAddress,
    v.addressLocality,
    [str(v.addressRegion), str(v.postalCode)].filter(Boolean).join(" "),
  ]
    .map(str)
    .filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ") : str(v.name);
}

function location(v: Json): { name: string | null; address: string | null } {
  if (Array.isArray(v)) {
    const physical = v.find(
      (x) => typeof x === "string" || (isObject(x) && !types(x).includes("VirtualLocation")),
    );
    return location(physical ?? v[0]);
  }
  if (typeof v === "string") return { name: str(v), address: null };
  if (!isObject(v)) return { name: null, address: null };
  if (types(v).includes("VirtualLocation")) return { name: null, address: null };
  return { name: str(v.name), address: address(v.address) };
}

/** `2026-10-19T10:00:00-04:00` gives date 2026-10-19 and time 10:00 (local wall time as written). */
function dateTime(v: Json): { date: string | null; time: string | null } {
  const s = str(v);
  if (!s) return { date: null, time: null };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return { date: null, time: null };
  const date = m[1] ?? null;
  const time = m[2] && m[3] ? `${m[2]}:${m[3]}` : null;
  // A midnight UTC time is usually a date written as a timestamp.
  return { date, time: time === "00:00" && /Z$|[+-]00:?00$/.test(s) ? null : time };
}

function collect(v: Json, out: Record<string, Json>[], depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1);
    return;
  }
  if (!isObject(v)) return;
  if (isEventType(v)) out.push(v);
  if (Array.isArray(v["@graph"])) collect(v["@graph"], out, depth + 1);
  // EventSeries and ItemList hold events in subEvent / itemListElement.item.
  if (v.subEvent !== undefined) collect(v.subEvent, out, depth + 1);
  if (Array.isArray(v.itemListElement)) {
    for (const el of v.itemListElement) collect(isObject(el) && el.item ? el.item : el, out, depth + 1);
  }
}

/** Name, start date, start time and location of every schema.org Event in the blocks. */
export function jsonLdEvents(blocks: readonly unknown[]): JsonLdEvent[] {
  const found: Record<string, Json>[] = [];
  for (const b of blocks) collect(b, found, 0);
  const out: JsonLdEvent[] = [];
  const seen = new Set<string>();
  for (const e of found) {
    const { date, time } = dateTime(e.startDate);
    const loc = location(e.location);
    const ev: JsonLdEvent = {
      name: str(e.name),
      start_date: date,
      start_time: time,
      location_name: loc.name,
      location_address: loc.address,
    };
    const key = JSON.stringify(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}
