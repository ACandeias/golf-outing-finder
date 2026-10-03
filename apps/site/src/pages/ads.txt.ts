import type { APIRoute } from "astro";
import { siteEnv } from "../lib/env.ts";

export const prerender = false;

/** Generated from env (SPEC.md 9.1, 9.5). Phase 4 fills in the publisher line. */
export const GET: APIRoute = () => {
  const e = siteEnv();
  const lines: string[] = [];
  if (e.ADS_PROVIDER === "adsense" && e.PUBLIC_ADSENSE_CLIENT) {
    const pub = e.PUBLIC_ADSENSE_CLIENT.replace(/^ca-/, "").replace(/^pub-/, "");
    lines.push(`google.com, pub-${pub}, DIRECT, f08c47fec0942fa0`);
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
