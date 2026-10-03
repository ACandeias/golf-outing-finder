/** Response security headers (SPEC.md section 10, CLAUDE.md security rules). */

/** OpenFreeMap serves the style, vector tiles, glyphs and sprites from one host. */
export const TILE_ORIGIN = "https://tiles.openfreemap.org";

/**
 * Report-only for now (SPEC.md 10: "start in report-only mode"). Scripts are only
 * our bundled files from 'self'; the site emits no inline executable scripts, so no
 * nonce or hash is needed (JSON-LD blocks are data and are not governed by
 * script-src). Styles allow 'unsafe-inline' because Astro inlines small component
 * stylesheets; style injection cannot run code.
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

export const CSP_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => `${k} ${v}`)
  .join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy-Report-Only": CSP_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), payment=(), geolocation=(self)",
};
