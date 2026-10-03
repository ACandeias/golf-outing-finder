import { createHash } from "node:crypto";
import { ulid } from "@gof/shared/ids";

/** sha256 of `text` as hex (pure; used for ids and content hashes). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The id a new `sources` row gets for a URL, and so the Message Batches
 * custom_id of its extraction: deterministic, so a batch collected on a later
 * run maps back to the same row. Existing rows keep their own ids.
 */
export function sourceIdForUrl(url: string): string {
  return `src_${sha256Hex(`source:${url}`).slice(0, 40)}`;
}

/** `{prefix}_{ULID}` with the run's time and randomness from a hash of `key` (the seed loader's scheme). */
export function stableId(prefix: string, nowMs: number, key: string): string {
  const bytes = createHash("sha256").update(`${prefix}:${key}`).digest();
  return `${prefix}_${ulid(nowMs, bytes.subarray(0, 10))}`;
}
