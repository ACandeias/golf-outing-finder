import { describe, expect, it } from "vitest";
import { parseSiteEnv } from "@gof/shared/env";
import {
  AD_PLACEMENTS,
  adSlotView,
  adsConfig,
  adsForGroup,
  adsenseTxtLine,
  listAdPositions,
  listAdSlots,
  listAdsFor,
  MOBILE_AD_CAP,
  runtimeAttributes,
  visibleListAds,
  type AdsConfig,
} from "./ads.ts";

const CLIENT = "ca-pub-0000000000000000";

function config(vars: Record<string, string> = {}): AdsConfig {
  return adsConfig(parseSiteEnv({ PUBLIC_SITE_URL: "https://golfoutingfinder.com", ...vars }));
}

/** Every slot the site can render, as a comparable value. */
function allSlotMarkup(c: AdsConfig): unknown {
  return AD_PLACEMENTS.flatMap((p) => [0, 1, 2, 3, 4].map((ordinal) => adSlotView(c, p, { ordinal })));
}

describe("adsConfig", () => {
  it("is off by default: no slots, no script, an empty ads.txt, no extra CSP origins", () => {
    const c = config();
    expect(c.enabled).toBe(false);
    expect(c.runtime).toBe(false);
    expect(c.scriptIncludes).toEqual([]);
    expect(c.adsTxt).toEqual({ kind: "lines", lines: [] });
    expect(Object.values(c.cspOrigins).flat()).toEqual([]);
    expect(adSlotView(c, "list")).toBeNull();
    expect(runtimeAttributes(c)).toEqual({});
  });

  it("AdSense: the documented tag URL with ?client= and the ads.txt publisher line", () => {
    const c = config({ PUBLIC_ADSENSE_CLIENT: CLIENT, PUBLIC_ADSENSE_SLOT_LIST: "1234567890" });
    expect(c.enabled).toBe(true);
    expect(c.scriptIncludes).toEqual([
      { src: `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT}`, crossorigin: "anonymous" },
    ]);
    expect(c.adsTxt).toEqual({ kind: "lines", lines: ["google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0"] });
    expect(c.adsenseSlots).toEqual({ list: "1234567890", outing: null, sidebar: null });
    expect(c.cspOrigins["script-src"]).toContain("https://pagead2.googlesyndication.com");
    expect(c.cspOrigins["frame-src"]).toContain("https://googleads.g.doubleclick.net");
    expect(runtimeAttributes(c)).toMatchObject({ "data-provider": "adsense", "data-client": CLIENT, "data-slot-list": "1234567890" });
  });

  it("accepts a pub- id without the ca- prefix", () => {
    expect(config({ PUBLIC_ADSENSE_CLIENT: "pub-0000000000000000" }).adsTxt).toEqual({
      kind: "lines",
      lines: [adsenseTxtLine(CLIENT)],
    });
  });

  it("GA4 alone: analytics runtime and its origins, no ad slots", () => {
    const c = config({ PUBLIC_GA4_ID: "G-TEST12345" });
    expect(c.enabled).toBe(false);
    expect(c.runtime).toBe(true);
    expect(c.ga4Id).toBe("G-TEST12345");
    expect(c.cspOrigins["script-src"]).toEqual(["https://www.googletagmanager.com"]);
    expect(runtimeAttributes(c)).toEqual({ "data-ga4": "G-TEST12345" });
  });

  it("Raptive: the script from the site id; Journey needs its dashboard script URL", () => {
    const r = config({ ADS_PROVIDER: "raptive", ADS_SITE_ID: "abc123" });
    expect(r.scriptIncludes).toEqual([{ src: "https://ads.adthrive.com/sites/abc123/ads.min.js", crossorigin: null }]);
    expect(config({ ADS_PROVIDER: "journey", ADS_SITE_ID: "abc123" }).enabled).toBe(false);
    const j = config({ ADS_PROVIDER: "journey", ADS_SCRIPT_URL: "https://scripts.example-network.com/tags/site.js" });
    expect(j.enabled).toBe(true);
    expect(j.cspOrigins["script-src"]).toContain("https://scripts.example-network.com");
  });

  it("Journey and Raptive: /ads.txt redirects to the hosted file when configured", () => {
    const base = { ADS_PROVIDER: "raptive", ADS_SITE_ID: "abc123" };
    expect(config(base).adsTxt).toEqual({ kind: "lines", lines: [] });
    expect(config({ ...base, ADS_TXT_REDIRECT_URL: "https://ads.adthrive.com/sites/abc123/ads.txt" }).adsTxt).toEqual({
      kind: "redirect",
      url: "https://ads.adthrive.com/sites/abc123/ads.txt",
    });
    // AdSense serves its own line and ignores the redirect.
    expect(
      config({ PUBLIC_ADSENSE_CLIENT: CLIENT, ADS_TXT_REDIRECT_URL: "https://example.com/ads.txt" }).adsTxt.kind,
    ).toBe("lines");
  });

  it("switching ADS_PROVIDER changes only the script include (and ads.txt, CSP); slot markup is identical", () => {
    const shared = {
      PUBLIC_ADSENSE_CLIENT: CLIENT,
      ADS_SITE_ID: "abc123",
      PUBLIC_GA4_ID: "G-TEST12345",
    };
    const adsense = config({ ...shared, ADS_PROVIDER: "adsense" });
    // Journey's script tag comes from its dashboard.
    const journey = config({ ...shared, ADS_PROVIDER: "journey", ADS_SCRIPT_URL: "https://scripts.example-network.com/tags/site.js" });
    const raptive = config({ ...shared, ADS_PROVIDER: "raptive" });
    for (const c of [adsense, journey, raptive]) expect(c.enabled).toBe(true);

    // The slots on the page: identical for every network.
    expect(allSlotMarkup(journey)).toEqual(allSlotMarkup(adsense));
    expect(allSlotMarkup(raptive)).toEqual(allSlotMarkup(adsense));

    // The script include is what changes.
    const srcs = [adsense, journey, raptive].map((c) => c.scriptIncludes.map((s) => s.src));
    expect(new Set(srcs.map((s) => s.join())).size).toBe(3);

    // Analytics is untouched by the switch.
    expect(journey.ga4Id).toBe(adsense.ga4Id);
    expect(raptive.ga4Id).toBe(adsense.ga4Id);

    // The browser config differs only in the provider and its include (plus the
    // AdSense-only client and slot ids, which only the AdSense adapter reads).
    const strip = (a: Record<string, string>) => {
      const { "data-provider": _p, "data-script": _s, "data-crossorigin": _c, "data-client": _cl, "data-site-id": _id, ...rest } = a;
      return Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("data-slot-")));
    };
    expect(strip(runtimeAttributes(journey))).toEqual(strip(runtimeAttributes(adsense)));
    expect(strip(runtimeAttributes(raptive))).toEqual(strip(runtimeAttributes(adsense)));
  });

  it("rejects malformed ids and non-https URLs", () => {
    expect(() => config({ PUBLIC_ADSENSE_CLIENT: "1234" })).toThrow(/publisher id/);
    expect(() => config({ PUBLIC_GA4_ID: "UA-1234-1" })).toThrow(/GA4/);
    expect(() => config({ PUBLIC_ADSENSE_SLOT_LIST: "abc" })).toThrow(/ad unit id/);
    expect(() => config({ ADS_SCRIPT_URL: "http://insecure.example/x.js" })).toThrow(/https/);
    expect(() => config({ ADS_TXT_REDIRECT_URL: "javascript:alert(1)" })).toThrow();
    expect(() => config({ ADS_SITE_ID: "bad id!" })).toThrow(/site id/);
  });
});

describe("adSlotView", () => {
  const on = { enabled: true };
  it("labels nothing when ads are off", () => {
    expect(adSlotView({ enabled: false }, "outing")).toBeNull();
  });
  it("hides list units past the mobile cap on phones, and the sidebar below desktop width", () => {
    for (let i = 0; i < MOBILE_AD_CAP; i++) expect(adSlotView(on, "list", { ordinal: i })?.classes).not.toContain("ad-desktop-only");
    expect(adSlotView(on, "list", { ordinal: MOBILE_AD_CAP })?.classes).toContain("ad-desktop-only");
    expect(adSlotView(on, "sidebar")?.classes).toContain("ad-wide-only");
    expect(adSlotView(on, "outing")?.classes).toEqual(["ad-slot", "ad-outing"]);
  });
  it("an outing page shows at most one unit on a phone (the sidebar is desktop-only)", () => {
    const phone = ["outing", "sidebar"].map((p) => adSlotView(on, p as "outing" | "sidebar")).filter((v) => !v?.classes.includes("ad-wide-only"));
    expect(phone).toHaveLength(1);
  });
});

describe("list placement (SPEC.md 9.5)", () => {
  it("one unit after the third result, then every eight", () => {
    expect(listAdPositions(40)).toEqual([3, 11, 19, 27, 35]);
    expect(listAdPositions(12)).toEqual([3, 11]);
    expect(listAdPositions(20)).toEqual([3, 11, 19]);
  });
  it("never above the first result and never ending a list", () => {
    expect(listAdPositions(0)).toEqual([]);
    expect(listAdPositions(1)).toEqual([]);
    expect(listAdPositions(3)).toEqual([]);
    expect(listAdPositions(4)).toEqual([3]);
    expect(listAdPositions(11)).toEqual([3]);
    for (let n = 0; n < 60; n++) {
      for (const p of listAdPositions(n)) {
        expect(p).toBeGreaterThanOrEqual(3);
        expect(p).toBeLessThan(n);
      }
    }
  });
  it("at most three units on a phone however long the list", () => {
    const slots = listAdsFor(200);
    const onPhone = slots.filter((s) => !adSlotView({ enabled: true }, "list", { ordinal: s.ordinal })?.classes.includes("ad-desktop-only"));
    expect(onPhone).toHaveLength(MOBILE_AD_CAP);
  });
  it("counts shown results only when server-side filters hide rows", () => {
    // Rows 0-2 hidden: the first unit follows the third shown row (index 5).
    const visible = [false, false, false, true, true, true, true, true];
    expect(listAdSlots(visible)).toEqual([{ afterIndex: 5, ordinal: 0 }]);
  });
  it("counts across month sections", () => {
    // Sections of 2, 5 and 10 rows: units after flat rows 3 and 11.
    const ads = listAdsFor(17);
    expect(ads.map((a) => a.afterIndex)).toEqual([2, 10]);
    expect(adsForGroup(ads, 0, 2)).toEqual([]);
    expect(adsForGroup(ads, 2, 5)).toEqual([{ afterIndex: 0, ordinal: 0 }]);
    expect(adsForGroup(ads, 7, 10)).toEqual([{ afterIndex: 3, ordinal: 1 }]);
  });
  it("after browser filtering, a unit stays only between two shown results", () => {
    const row = (shown: boolean) => ({ kind: "row" as const, shown });
    const ad = { kind: "ad" as const };
    expect(visibleListAds([row(true), row(true), row(true), ad, row(true)])).toEqual([true]);
    expect(visibleListAds([row(false), row(false), row(false), ad, row(true)])).toEqual([false]);
    expect(visibleListAds([row(true), ad, row(false), row(false)])).toEqual([false]);
    expect(visibleListAds([row(true), ad, row(true), ad, row(false)])).toEqual([true, false]);
  });
});
