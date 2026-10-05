/**
 * Ads and analytics configuration (SPEC.md 9.5, 10). Pure: everything here takes
 * the validated Worker env, so it tests offline without `cloudflare:workers`.
 *
 * One rule runs through it: slot markup is provider-neutral. `ADS_PROVIDER` picks
 * the script include (and, with it, the ads.txt answer and the CSP origins); the
 * containers on the page are the same for AdSense, Journey and Raptive. The
 * provider adapter that fills a container lives in the browser script
 * (src/scripts/ads.ts), never in slot markup.
 */
import type { SiteEnv } from "@gof/shared/env";

export type AdsProvider = SiteEnv["ADS_PROVIDER"];

/** Where a unit sits: in a result list, below an outing's details, or in the outing page's desktop sidebar. */
export type AdPlacement = "list" | "outing" | "sidebar";
export const AD_PLACEMENTS: readonly AdPlacement[] = ["list", "outing", "sidebar"];

/** The env fields this module reads. */
export type AdsEnv = Pick<
  SiteEnv,
  | "ADS_PROVIDER"
  | "PUBLIC_ADSENSE_CLIENT"
  | "PUBLIC_GA4_ID"
  | "PUBLIC_ADSENSE_SLOT_LIST"
  | "PUBLIC_ADSENSE_SLOT_OUTING"
  | "PUBLIC_ADSENSE_SLOT_SIDEBAR"
  | "ADS_SITE_ID"
  | "ADS_SCRIPT_URL"
  | "ADS_TXT_REDIRECT_URL"
>;

export interface ScriptInclude {
  src: string;
  /** AdSense's documented tag carries crossorigin="anonymous". */
  crossorigin: "anonymous" | null;
}

/** Extra origins per CSP directive, added to the base policy on rendered pages. */
export interface CspOrigins {
  "script-src": readonly string[];
  "img-src": readonly string[];
  "connect-src": readonly string[];
  "frame-src": readonly string[];
}

export type AdsTxt = { kind: "lines"; lines: readonly string[] } | { kind: "redirect"; url: string };

export interface AdsConfig {
  provider: AdsProvider;
  /** Ad slots render only when the configured provider has what it needs to serve. */
  enabled: boolean;
  /** The ad network's script; empty when ads are off. */
  scriptIncludes: readonly ScriptInclude[];
  /** `ca-pub-...` when the provider is AdSense and ads are on. */
  adsenseClient: string | null;
  /** AdSense ad unit ids per placement (null: a display unit without `data-ad-slot`). */
  adsenseSlots: Readonly<Record<AdPlacement, string | null>>;
  /** Raptive's site id, which its loader needs. */
  siteId: string | null;
  /** GA4 measurement id; gtag.js loads only when it is set. */
  ga4Id: string | null;
  /** The browser script runs when ads or analytics are on. */
  runtime: boolean;
  adsTxt: AdsTxt;
  cspOrigins: CspOrigins;
}

/** Google's AdSense certification authority id in ads.txt (AdSense Help 12171612). */
export const ADSENSE_TXT_CERT_ID = "f08c47fec0942fa0";
export const ADSENSE_SCRIPT = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
export const GTAG_SCRIPT = "https://www.googletagmanager.com/gtag/js";
/** Raptive's self-install head code loads `https://ads.adthrive.com/sites/{SITE ID}/ads.min.js`. */
export const RAPTIVE_HOST = "ads.adthrive.com";

/** `pub-0000000000000000` or `ca-pub-0000000000000000` → `ca-pub-0000000000000000`. */
export function adsenseClientId(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  return v.startsWith("ca-") ? v : `ca-${v}`;
}

/** The ads.txt publisher line for an AdSense client id. */
export function adsenseTxtLine(client: string): string {
  return `google.com, ${client.replace(/^ca-/, "")}, DIRECT, ${ADSENSE_TXT_CERT_ID}`;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * AdSense hosts, for the report-only policy. AdSense supports only a strict,
 * nonce-based CSP because its hosts change over time (AdSense Help 16283098), so
 * this allowlist exists to keep reports quiet, not to be enforced.
 */
const ADSENSE_CSP: CspOrigins = {
  "script-src": [
    "https://pagead2.googlesyndication.com",
    "https://tpc.googlesyndication.com",
    "https://fundingchoicesmessages.google.com",
    "https://*.adtrafficquality.google",
    "https://googleads.g.doubleclick.net",
    "https://www.google.com",
  ],
  "img-src": [
    "https://pagead2.googlesyndication.com",
    "https://tpc.googlesyndication.com",
    "https://*.g.doubleclick.net",
    "https://*.adtrafficquality.google",
    "https://www.google.com",
    "https://www.gstatic.com",
  ],
  "connect-src": [
    "https://pagead2.googlesyndication.com",
    "https://*.g.doubleclick.net",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
    "https://www.google.com",
  ],
  "frame-src": [
    "https://googleads.g.doubleclick.net",
    "https://tpc.googlesyndication.com",
    "https://*.googlesyndication.com",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
    "https://www.google.com",
  ],
};

/** GA4 through gtag.js, "with Ads features" (Google tag CSP guide). */
const GA4_CSP: CspOrigins = {
  "script-src": ["https://www.googletagmanager.com"],
  "img-src": ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.g.doubleclick.net", "https://*.google.com"],
  "connect-src": [
    "https://www.googletagmanager.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.g.doubleclick.net",
    "https://*.google.com",
    "https://pagead2.googlesyndication.com",
  ],
  "frame-src": ["https://www.googletagmanager.com"],
};

/**
 * Journey and Raptive run header bidding, which loads scripts, pixels and frames
 * from many exchanges that change without notice; the report-only policy allows
 * any https origin for them rather than pretend to list them.
 */
function managedNetworkCsp(scriptSrc: string): CspOrigins {
  return {
    "script-src": [originOf(scriptSrc), "https:"],
    "img-src": ["https:"],
    "connect-src": ["https:"],
    "frame-src": ["https:"],
  };
}

const EMPTY_CSP: CspOrigins = { "script-src": [], "img-src": [], "connect-src": [], "frame-src": [] };

function mergeCsp(...parts: CspOrigins[]): CspOrigins {
  const out: Record<keyof CspOrigins, string[]> = { "script-src": [], "img-src": [], "connect-src": [], "frame-src": [] };
  for (const p of parts) {
    for (const k of Object.keys(out) as (keyof CspOrigins)[]) {
      for (const o of p[k]) if (!out[k].includes(o)) out[k].push(o);
    }
  }
  return out;
}

function providerScript(e: AdsEnv): ScriptInclude | null {
  switch (e.ADS_PROVIDER) {
    case "adsense": {
      const client = adsenseClientId(e.PUBLIC_ADSENSE_CLIENT);
      return client ? { src: `${ADSENSE_SCRIPT}?client=${encodeURIComponent(client)}`, crossorigin: "anonymous" } : null;
    }
    case "raptive": {
      if (e.ADS_SCRIPT_URL) return { src: e.ADS_SCRIPT_URL, crossorigin: null };
      return e.ADS_SITE_ID ? { src: `https://${RAPTIVE_HOST}/sites/${encodeURIComponent(e.ADS_SITE_ID)}/ads.min.js`, crossorigin: null } : null;
    }
    case "journey":
      // Journey's script tag is site-specific and comes from its dashboard.
      return e.ADS_SCRIPT_URL ? { src: e.ADS_SCRIPT_URL, crossorigin: null } : null;
  }
}

function adsTxtFor(e: AdsEnv, client: string | null): AdsTxt {
  if (e.ADS_PROVIDER === "adsense") return { kind: "lines", lines: client ? [adsenseTxtLine(client)] : [] };
  // Journey and Raptive host the file and keep it current; a single redirect off
  // the site's domain is allowed by the IAB ads.txt spec.
  if (e.ADS_TXT_REDIRECT_URL) return { kind: "redirect", url: e.ADS_TXT_REDIRECT_URL };
  return { kind: "lines", lines: [] };
}

export function adsConfig(e: AdsEnv): AdsConfig {
  const script = providerScript(e);
  const enabled = script !== null;
  const client = e.ADS_PROVIDER === "adsense" ? adsenseClientId(e.PUBLIC_ADSENSE_CLIENT) : null;
  const ga4Id = e.PUBLIC_GA4_ID || null;
  const blank = (v: string): string | null => (v === "" ? null : v);
  const adsCsp = !script ? EMPTY_CSP : e.ADS_PROVIDER === "adsense" ? ADSENSE_CSP : managedNetworkCsp(script.src);
  return {
    provider: e.ADS_PROVIDER,
    enabled,
    scriptIncludes: script ? [script] : [],
    adsenseClient: enabled ? client : null,
    adsenseSlots: {
      list: blank(e.PUBLIC_ADSENSE_SLOT_LIST),
      outing: blank(e.PUBLIC_ADSENSE_SLOT_OUTING),
      sidebar: blank(e.PUBLIC_ADSENSE_SLOT_SIDEBAR),
    },
    siteId: e.ADS_PROVIDER === "adsense" ? null : (e.ADS_SITE_ID ?? null),
    ga4Id,
    runtime: enabled || ga4Id !== null,
    adsTxt: adsTxtFor(e, client),
    cspOrigins: mergeCsp(adsCsp, ga4Id ? GA4_CSP : EMPTY_CSP),
  };
}

/**
 * The `data-*` attributes the browser script reads its config from (rendered on a
 * `<template>` in the head of server-rendered pages: no inline script, no
 * `set:html`). Values come from validated env only, never from the database.
 */
export function runtimeAttributes(c: AdsConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.enabled) {
    out["data-provider"] = c.provider;
    const s = c.scriptIncludes[0];
    if (s) out["data-script"] = s.src;
    if (s?.crossorigin) out["data-crossorigin"] = s.crossorigin;
    if (c.adsenseClient) {
      out["data-client"] = c.adsenseClient;
      for (const p of AD_PLACEMENTS) {
        const id = c.adsenseSlots[p];
        if (id) out[`data-slot-${p}`] = id;
      }
    }
    if (c.siteId) out["data-site-id"] = c.siteId;
  }
  if (c.ga4Id) out["data-ga4"] = c.ga4Id;
  return out;
}

/** Reserved box heights in CSS px (SPEC.md 9.5: fixed-height containers). */
export const AD_HEIGHTS: Readonly<Record<AdPlacement, { mobile: number; desktop: number }>> = {
  // 300x250 or 336x280 on phones; a 728x90 leaderboard across the list on wider screens.
  list: { mobile: 280, desktop: 90 },
  // 300x250 or 336x280 below an outing's details at every width.
  outing: { mobile: 280, desktop: 280 },
  // 300x600 half page in the desktop sidebar (hidden below 1024px).
  sidebar: { mobile: 600, desktop: 600 },
};

/** Units on a phone, at most (SPEC.md 9.5). */
export const MOBILE_AD_CAP = 3;

export interface AdSlotView {
  placement: AdPlacement;
  /** CSS classes on the container. */
  classes: string[];
  /** Attributes on the container (provider-neutral). */
  attrs: Record<string, string>;
}

/**
 * What a slot renders, or null when ads are off. Depends only on whether ads are
 * on, the placement and the slot's place on the page: never on the provider.
 */
export function adSlotView(
  c: Pick<AdsConfig, "enabled">,
  placement: AdPlacement,
  opts: { ordinal?: number } = {},
): AdSlotView | null {
  if (!c.enabled) return null;
  const ordinal = opts.ordinal ?? 0;
  const classes = ["ad-slot", `ad-${placement}`];
  // The sidebar exists only in the two-column layout (1024px and up); list units
  // past the mobile cap show from 720px up.
  if (placement === "sidebar") classes.push("ad-wide-only");
  else if (placement === "list" && ordinal >= MOBILE_AD_CAP) classes.push("ad-desktop-only");
  return {
    placement,
    classes,
    attrs: { "data-ad-placement": placement, "data-ad-ordinal": String(ordinal) },
  };
}

export interface ListAdRule {
  /** The first unit follows this many results. */
  first: number;
  /** Then one every this many results. */
  every: number;
}

/** SPEC.md 9.5: one unit after the third result and one every eight results after that. */
export const LIST_AD_RULE: ListAdRule = { first: 3, every: 8 };

/**
 * After how many results each list unit goes: 3, 11, 19, ... A unit goes only
 * where another result follows it, so a list never starts or ends on an ad and a
 * list of three or fewer has none.
 */
export function listAdPositions(resultCount: number, rule: ListAdRule = LIST_AD_RULE): number[] {
  const out: number[] = [];
  for (let n = rule.first; n < resultCount; n += rule.every) out.push(n);
  return out;
}

export interface ListAd {
  /** Index into the rows: the unit goes right after this row. */
  afterIndex: number;
  /** The unit's place among the page's list units (0-based), for the mobile cap. */
  ordinal: number;
}

/**
 * List units over rows some of which start hidden (server-side filters): positions
 * count visible results only, so a filtered page still never opens on an ad.
 */
export function listAdSlots(visible: readonly boolean[], rule: ListAdRule = LIST_AD_RULE): ListAd[] {
  const visibleIdx: number[] = [];
  visible.forEach((v, i) => {
    if (v) visibleIdx.push(i);
  });
  return listAdPositions(visibleIdx.length, rule).map((n, ordinal) => ({ afterIndex: visibleIdx[n - 1] as number, ordinal }));
}

/** Splits page-wide list units across consecutive groups (month sections) by row offset. */
export function adsForGroup(ads: readonly ListAd[], offset: number, length: number): ListAd[] {
  return ads
    .filter((a) => a.afterIndex >= offset && a.afterIndex < offset + length)
    .map((a) => ({ afterIndex: a.afterIndex - offset, ordinal: a.ordinal }));
}

/**
 * Which list units stay shown once the browser filters rows: a unit needs a shown
 * result before it and one after it. `items` is the list in document order.
 */
export function visibleListAds(items: readonly ({ kind: "row"; shown: boolean } | { kind: "ad" })[]): boolean[] {
  const shownAfter: boolean[] = new Array<boolean>(items.length).fill(false);
  let seen = false;
  for (let i = items.length - 1; i >= 0; i--) {
    shownAfter[i] = seen;
    const it = items[i];
    if (it?.kind === "row" && it.shown) seen = true;
  }
  const out: boolean[] = [];
  let before = false;
  items.forEach((it, i) => {
    if (it.kind === "row") {
      if (it.shown) before = true;
    } else {
      out.push(before && (shownAfter[i] ?? false));
    }
  });
  return out;
}

/** List units for a list whose rows are all shown (course, organizer and national hub pages). */
export function listAdsFor(rowCount: number, rule: ListAdRule = LIST_AD_RULE): ListAd[] {
  return listAdSlots(new Array<boolean>(rowCount).fill(true), rule);
}
