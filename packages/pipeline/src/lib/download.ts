/**
 * Downloads a public data file (GeoNames) with our user agent, a timeout and a
 * size cap. Only used by `places:build`; tests never call it.
 */
export async function downloadBuffer(
  url: string,
  opts: { userAgent: string; timeoutMs?: number; maxBytes?: number },
): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`refusing non-https download: ${url}`);
  const res = await fetch(u, {
    headers: { "user-agent": opts.userAgent },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const max = opts.maxBytes ?? 100 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new Error(`GET ${url}: over ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
