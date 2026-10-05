/** Edge cache TTLs in seconds, per route (SPEC.md 9.1). */
export const TTL = {
  home: 60 * 60,
  list: 6 * 60 * 60,
  api: 10 * 60,
  sitemap: 6 * 60 * 60,
  robots: 6 * 60 * 60,
  /** The IndexNow key file: short, so a rotated key takes effect within the hour. */
  keyFile: 60 * 60,
} as const;

/** `public, s-maxage=<ttl>` (shared caches only; browsers revalidate). */
export function cacheControl(ttlSeconds: number): string {
  return `public, max-age=0, s-maxage=${ttlSeconds}`;
}

export const NO_STORE = "no-store";
