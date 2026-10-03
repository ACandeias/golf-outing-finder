import { z } from "zod";
import type { IndexNowClient } from "../stages/types.ts";

/** IndexNow accepts at most 10,000 URLs per request. */
export const INDEXNOW_BATCH = 10_000;
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

const configSchema = z.object({
  siteUrl: z.string().url(),
  key: z
    .string()
    .regex(/^[a-zA-Z0-9-]{8,128}$/, "IndexNow keys are 8 to 128 letters, digits or dashes"),
  endpoint: z.string().url().default(INDEXNOW_ENDPOINT),
});
export type IndexNowConfig = z.input<typeof configSchema>;

/**
 * IndexNow (SPEC.md 8.8): POSTs the published outing URLs. The fetch is
 * injected, so tests and dry runs never touch the network; a live run passes
 * the guarded fetcher. Paths from the publish stage are resolved against
 * PUBLIC_SITE_URL, and URLs on any other host are dropped. The key is served
 * at /{key}.txt by the site.
 */
export function indexNowClient(config: IndexNowConfig, fetchFn: FetchLike): IndexNowClient {
  const c = configSchema.parse(config);
  const site = new URL(c.siteUrl);
  return {
    async ping(urls) {
      const full = [
        ...new Set(
          urls
            .map((u) => new URL(u, site))
            .filter((u) => u.host === site.host)
            .map((u) => u.toString()),
        ),
      ];
      for (let i = 0; i < full.length; i += INDEXNOW_BATCH) {
        const res = await fetchFn(c.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            host: site.host,
            key: c.key,
            keyLocation: new URL(`/${c.key}.txt`, site).toString(),
            urlList: full.slice(i, i + INDEXNOW_BATCH),
          }),
        });
        // 200 and 202 are success; anything else is reported, not retried.
        if (!res.ok) throw new Error(`IndexNow returned HTTP ${res.status}`);
      }
    },
  };
}
