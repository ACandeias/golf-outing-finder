/**
 * Consent, analytics and ads in the browser (SPEC.md 9.5, 10). A same-origin
 * module, never an inline script: it reads its config from the data attributes of
 * `<template id="gof-ads-config">` (src/components/AdsRuntime.astro), which the
 * server renders from validated env.
 *
 * Order matters (Google tag consent guide): the Consent Mode v2 defaults go into
 * the dataLayer before any Google script is added to the page.
 *
 *   1. Consent defaults: everything denied in the EEA, the UK and Switzerland until
 *      the consent message (Google Privacy & messaging, which the AdSense tag
 *      deploys) sends an update; granted elsewhere. wait_for_update gives the
 *      message 500 ms before tags read the state.
 *   2. GA4: gtag.js, only when PUBLIC_GA4_ID is set. It reads the consent state, so
 *      it sets no analytics cookies where consent is required until it is given.
 *   3. The ad network's script, only when ads are on.
 *   4. Slots: AdSense units are created lazily as each fixed-height box nears the
 *      viewport. Journey and Raptive place their own units into the boxes they are
 *      configured to target, so the adapter only loads their script.
 */

type Provider = "adsense" | "journey" | "raptive";
type Placement = "list" | "outing" | "sidebar";

interface RuntimeConfig {
  provider: Provider | null;
  script: string | null;
  crossorigin: boolean;
  client: string | null;
  slots: Record<Placement, string | null>;
  siteId: string | null;
  ga4: string | null;
}

interface TcData {
  gdprApplies?: boolean;
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    adsbygoogle?: unknown[];
    googlefc?: {
      callbackQueue?: unknown[];
      showRevocationMessage?: () => void;
    };
    __tcfapi?: (command: string, version: number, cb: (data: TcData, ok: boolean) => void) => void;
    adthrive?: { cmd?: unknown[]; plugin?: string; host?: string };
  }
}

/** EEA (EU 27, Iceland, Liechtenstein, Norway), the UK and Switzerland, ISO 3166-1. */
export const CONSENT_REQUIRED_REGIONS: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH",
];

const GTAG_SCRIPT = "https://www.googletagmanager.com/gtag/js";
const LAZY_MARGIN = "200px 0px";

function readConfig(): RuntimeConfig | null {
  const el = document.getElementById("gof-ads-config");
  if (!el) return null;
  const d = el.dataset;
  const provider = d.provider === "adsense" || d.provider === "journey" || d.provider === "raptive" ? d.provider : null;
  const script = d.script && d.script.startsWith("https://") ? d.script : null;
  const slot = (v: string | undefined): string | null => (v && /^\d{6,20}$/.test(v) ? v : null);
  return {
    provider: provider && script ? provider : null,
    script,
    crossorigin: d.crossorigin === "anonymous",
    client: d.client && /^ca-pub-\d{10,20}$/.test(d.client) ? d.client : null,
    slots: { list: slot(d.slotList), outing: slot(d.slotOuting), sidebar: slot(d.slotSidebar) },
    siteId: d.siteId && /^[A-Za-z0-9_-]{1,64}$/.test(d.siteId) ? d.siteId : null,
    ga4: d.ga4 && /^G-[A-Z0-9]{4,20}$/.test(d.ga4) ? d.ga4 : null,
  };
}

/** gtag.js reads Arguments objects from the dataLayer, not arrays. */
function gtag(..._args: unknown[]): void {
  // eslint-disable-next-line prefer-rest-params -- gtag.js needs the Arguments object
  (window.dataLayer ??= []).push(arguments);
}

function setConsentDefaults(): void {
  const denied = {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  };
  gtag("consent", "default", { ...denied, region: [...CONSENT_REQUIRED_REGIONS], wait_for_update: 500 });
  gtag("consent", "default", {
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
    analytics_storage: "granted",
  });
  // Ad clicks without ad_storage consent carry no ad identifiers.
  gtag("set", "ads_data_redaction", true);
}

function addScript(src: string, crossorigin: boolean): void {
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  if (crossorigin) s.crossOrigin = "anonymous";
  document.head.appendChild(s);
}

function loadAnalytics(id: string): void {
  gtag("js", new Date());
  gtag("config", id);
  addScript(`${GTAG_SCRIPT}?id=${encodeURIComponent(id)}`, false);
}

/** Raptive's self-install head code sets these globals before its script loads. */
function raptiveScript(c: RuntimeConfig, script: string): string {
  const w = window;
  w.adthrive = w.adthrive ?? {};
  w.adthrive.cmd = w.adthrive.cmd ?? [];
  w.adthrive.plugin = "adthrive-ads-manual";
  w.adthrive.host = "ads.adthrive.com";
  const url = new URL(script);
  if (c.siteId && url.hostname === "ads.adthrive.com" && !url.searchParams.has("referrer")) {
    url.searchParams.set("referrer", location.href);
  }
  return url.href;
}

function placementOf(box: HTMLElement): Placement {
  const p = box.closest<HTMLElement>("[data-ad-placement]")?.dataset.adPlacement;
  return p === "outing" || p === "sidebar" ? p : "list";
}

/** One AdSense unit sized by its box (AdSense: a responsive unit whose size comes from CSS). */
function fillAdsense(box: HTMLElement, c: RuntimeConfig): void {
  if (!c.client || box.dataset.filled) return;
  box.dataset.filled = "1";
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.style.width = "100%";
  ins.style.height = "100%";
  ins.dataset.adClient = c.client;
  const slot = c.slots[placementOf(box)];
  if (slot) ins.dataset.adSlot = slot;
  ins.dataset.fullWidthResponsive = "false";
  box.appendChild(ins);
  try {
    (window.adsbygoogle ??= []).push({});
  } catch {
    // The ad script reports its own errors; a failed unit leaves the reserved box.
  }
}

function lazyFill(c: RuntimeConfig): void {
  const boxes = Array.from(document.querySelectorAll<HTMLElement>("[data-ad-box]"));
  if (boxes.length === 0 || c.provider !== "adsense") return;
  if (!("IntersectionObserver" in window)) {
    for (const b of boxes) if (b.offsetParent !== null) fillAdsense(b, c);
    return;
  }
  // A box hidden by CSS (the mobile cap, the desktop-only sidebar) or by the
  // filters never intersects, so it never requests an ad.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        fillAdsense(e.target as HTMLElement, c);
      }
    },
    { rootMargin: LAZY_MARGIN },
  );
  for (const b of boxes) io.observe(b);
}

/**
 * The footer's "Privacy choices" button, shown only where the EU consent message
 * applies; it reopens the message (Privacy & messaging JavaScript API).
 */
function privacyChoices(): void {
  const item = document.querySelector<HTMLElement>("[data-privacy-choices]");
  const button = item?.querySelector<HTMLButtonElement>("button");
  if (!item || !button) return;
  const fc = (window.googlefc ??= {});
  (fc.callbackQueue ??= []).push({
    CONSENT_DATA_READY: () => {
      window.__tcfapi?.("getTCData", 2, (data, ok) => {
        if (!ok || data.gdprApplies !== true) return;
        item.hidden = false;
        button.addEventListener("click", () => window.googlefc?.showRevocationMessage?.());
      });
    },
  });
}

export function initAds(): void {
  const c = readConfig();
  if (!c) return;
  if (!c.provider && !c.ga4) return;
  setConsentDefaults();
  if (c.ga4) loadAnalytics(c.ga4);
  if (!c.provider || !c.script) return;
  if (c.provider === "adsense") {
    privacyChoices();
    addScript(c.script, c.crossorigin);
    lazyFill(c);
  } else if (c.provider === "raptive") {
    addScript(raptiveScript(c, c.script), false);
  } else {
    addScript(c.script, false);
  }
}
