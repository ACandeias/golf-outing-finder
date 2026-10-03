/**
 * URL normalization and registrable domains (SPEC.md 8.2). Pure; used by the
 * discovery stage, the fetch plan and the edges.
 */

/** Query parameters that only track clicks (exact names, lowercase). */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "_ga",
  "_gl",
  "mkt_tok",
]);
/** Prefixes: utm_* (Google Analytics), mc_* (Mailchimp). */
const TRACKING_PREFIXES = ["utm_", "mc_"];

export const MAX_URL_LENGTH = 2048;

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/** True for a dotted IPv4 literal or a bracketed IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/**
 * Normalizes a URL for the queue and dedupe: resolves it against `base`, keeps
 * http and https only, lowercases the host (URL does), drops a trailing dot,
 * default ports, the fragment and tracking parameters. Returns null for
 * anything unusable: another scheme, embedded credentials, a host without a
 * dot (other than an IP literal), or more than 2,048 characters.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  const raw = input.trim();
  if (raw === "" || raw.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.hostname.endsWith(".")) u.hostname = u.hostname.replace(/\.+$/, "");
  const host = u.hostname;
  if (host === "" || (!host.includes(".") && !isIpLiteral(host))) return null;
  u.hash = "";
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (!isTrackingParam(k)) kept.push([k, v]);
  if (kept.length !== [...u.searchParams].length) {
    u.search = kept.length === 0 ? "" : new URLSearchParams(kept).toString();
  }
  const out = u.toString();
  return out.length > MAX_URL_LENGTH ? null : out;
}

/** Lowercase host of a URL, or null when it does not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A committed subset of the Public Suffix List (publicsuffix.org): the
 * multi-label ICANN suffixes we are likely to meet, plus hosting platforms
 * (PSL private section) where each subdomain is a separate site. Single-label
 * TLDs need no entry. US locality domains (`glendale.ca.us`) and K-12
 * (`k12.ny.us`) are handled by rule below.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // ICANN
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp",
  "com.br", "com.mx", "org.mx", "co.za", "com.cn", "com.tw", "com.sg", "com.hk",
  "co.in", "co.kr", "com.ar", "com.co", "co.il",
  "gc.ca", "qc.ca", "on.ca", "bc.ca", "ab.ca",
  "fed.us", "dni.us", "nsn.us", "isa.us",
  // Private: hosting platforms
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "herokuapp.com", "web.app", "firebaseapp.com", "azurewebsites.net", "cloudfront.net",
  "blogspot.com", "wordpress.com", "wixsite.com", "weebly.com", "square.site",
  "godaddysites.com", "myshopify.com", "webflow.io", "carrd.co", "squarespace.com",
  "sites.google.com",
]);

const US_STATES = new Set(
  "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy pr vi gu as mp".split(
    " ",
  ),
);

const US_STATE_SUBSUFFIXES = new Set(["k12", "cc", "lib", "pvt", "tec", "gen", "mus"]);

/** Number of labels in the public suffix of `labels`. */
function suffixLength(labels: readonly string[]): number {
  const n = labels.length;
  // `{state}.us` is a suffix (PSL), and so are `k12.{state}.us`, `cc.{state}.us`
  // and `lib.{state}.us`; a locality such as `glendale.ca.us` is registrable.
  if (n >= 3 && labels[n - 1] === "us" && US_STATES.has(labels[n - 2] ?? "")) {
    if (US_STATE_SUBSUFFIXES.has(labels[n - 3] ?? "")) return 3;
    return 2;
  }
  if (n >= 2 && labels[n - 1] === "us" && US_STATES.has(labels[n - 2] ?? "")) return 2;
  for (const len of [3, 2]) {
    if (n > len && MULTI_LABEL_SUFFIXES.has(labels.slice(-len).join("."))) return len;
  }
  return 1;
}

/**
 * The registrable domain (eTLD+1) of a host: `support.kidney.org` gives
 * `kidney.org`, `www.golf.co.uk` gives `golf.co.uk`, `club.wixsite.com` stays
 * itself. IP literals and single labels are returned as they are.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (isIpLiteral(h) || !h.includes(".")) return h;
  const labels = h.split(".");
  const suffix = suffixLength(labels);
  if (labels.length <= suffix) return h;
  return labels.slice(-(suffix + 1)).join(".");
}

/** Both URLs parse and share a registrable domain. */
export function sameSite(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha !== null && hb !== null && registrableDomain(ha) === registrableDomain(hb);
}
