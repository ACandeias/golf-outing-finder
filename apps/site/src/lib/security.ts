/** Response security headers (SPEC.md section 10, CLAUDE.md security rules). */
import type { CspOrigins } from "./ads.ts";

/** OpenFreeMap serves the style, vector tiles, glyphs and sprites from one host. */
export const TILE_ORIGIN = "https://tiles.openfreemap.org";

/**
 * Report-only for now (SPEC.md 10: "start in report-only mode"). Scripts are only
 * our bundled files from 'self'; the site emits no inline executable scripts, so no
 * nonce or hash is needed (JSON-LD blocks are data and are not governed by
 * script-src). Styles allow 'unsafe-inline' because Astro inlines small component
 * stylesheets; style injection cannot run code.
 *
 * This base policy is what static assets and prerendered pages get (public/_headers
 * repeats it; a unit test keeps the two equal). Server-rendered pages add the ad
 * and analytics origins in use (`cspPolicy`). AdSense supports only a strict,
 * nonce-based policy when enforced (AdSense Help 16283098), so switching from
 * report-only to enforcing means moving to nonces, not tightening this allowlist.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, string>> = {
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' data: blob:",
  "font-src": "'self'",
  "connect-src": `'self' ${TILE_ORIGIN}`,
  "worker-src": "'self'",
  "frame-src": "'none'",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
  "frame-ancestors": "'none'",
};

function serialize(d: Readonly<Record<string, string>>): string {
  return Object.entries(d)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

export const CSP_POLICY = serialize(CSP_DIRECTIVES);

/** The base policy plus the given origins; a directive at 'none' is replaced, not appended to. */
export function cspPolicy(extra?: CspOrigins): string {
  if (!extra) return CSP_POLICY;
  const d: Record<string, string> = { ...CSP_DIRECTIVES };
  for (const [k, origins] of Object.entries(extra) as [keyof CspOrigins, readonly string[]][]) {
    if (origins.length === 0) continue;
    const cur = d[k] ?? "";
    const base = cur === "'none'" ? [] : cur.split(" ").filter(Boolean);
    d[k] = [...base, ...origins.filter((o) => !base.includes(o))].join(" ");
  }
  return serialize(d);
}

/** Headers on every response; static assets get the same set from public/_headers. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy-Report-Only": CSP_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), payment=(), geolocation=(self)",
};

/** SECURITY_HEADERS with the ad and analytics origins in use (server-rendered responses). */
export function securityHeaders(extra?: CspOrigins): Readonly<Record<string, string>> {
  if (!extra) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, "Content-Security-Policy-Report-Only": cspPolicy(extra) };
}
