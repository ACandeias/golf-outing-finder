/**
 * Host and registrable-domain helpers for extraction and classification. No
 * public-suffix list dependency: the sites we list are US organizers, so the
 * registrable domain is the last two labels, or three under the few multi-label
 * suffixes US schools and governments use (k12.az.us, co.uk, ...).
 */

/** Second-level labels that act as public suffixes under a country code. */
const MULTI_LABEL_SECOND = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "k12"]);

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** `support.kidney.org` gives `kidney.org`; `www.lausd.k12.ca.us` gives `lausd.k12.ca.us`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  // US locality domains: school.k12.ca.us, city.ca.us
  if (tld === "us" && /^[a-z]{2}$/.test(second)) {
    const third = labels[labels.length - 3] ?? "";
    if (third === "k12" && labels.length >= 4) return labels.slice(-4).join(".");
    return labels.slice(-3).join(".");
  }
  if (tld.length === 2 && MULTI_LABEL_SECOND.has(second)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/** Registrable domain of a URL, or null when it doesn't parse. */
export function registrableDomainOf(url: string): string | null {
  const host = hostOf(url);
  return host ? registrableDomain(host) : null;
}

/** `sources.domain`: the host without a leading `www.`. */
export function sourceDomain(url: string): string {
  return (hostOf(url) ?? "").replace(/^www\./, "");
}

/** True when `host` is one of `entries` or a subdomain of one. */
export function hostIn(host: string, entries: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return entries.some((e) => h === e || h.endsWith(`.${e}`));
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Amendment A5: keep `registration_url` when it is http(s) and its registrable
 * domain equals the page's, or its host is on the registration-host allowlist.
 * Otherwise null, and the card shows "See site".
 */
export function keepRegistrationUrl(
  registrationUrl: string | null,
  pageUrl: string,
  allowedHosts: readonly string[],
): string | null {
  if (!registrationUrl || !isHttpUrl(registrationUrl)) return null;
  const host = hostOf(registrationUrl);
  const pageHost = hostOf(pageUrl);
  if (!host) return null;
  if (pageHost && registrableDomain(host) === registrableDomain(pageHost)) return registrationUrl;
  return hostIn(host, allowedHosts) ? registrationUrl : null;
}
