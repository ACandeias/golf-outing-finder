import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GofDb } from "@gof/db/queries";

let cached: GofDb | null = null;

/** Drizzle over the D1 binding `DB`. */
export function getDb(): GofDb {
  cached ??= drizzle(env.DB);
  return cached;
}
