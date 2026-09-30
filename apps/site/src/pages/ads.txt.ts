import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
  const env = locals.runtime?.env;
  const provider = env?.ADS_PROVIDER ?? "adsense";
  const client = env?.PUBLIC_ADSENSE_CLIENT ?? "";
  const lines: string[] = [];
  if (provider === "adsense" && client) {
    const pub = client.replace(/^pub-/, "");
    lines.push(`google.com, pub-${pub}, DIRECT, f08c47fec0942fa0`);
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
