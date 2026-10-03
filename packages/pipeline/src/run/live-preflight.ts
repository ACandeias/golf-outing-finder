import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetJob } from "@gof/shared/budget";
import { pipelineEnvSchema, type PipelineEnv } from "@gof/shared/env";
import type { D1Target } from "../d1/port.ts";
import { PATHS } from "../lib/paths.ts";

/**
 * Checks before a live run touches anything (SPEC.md 6, 8.0). The environment
 * is validated with the shared zod schema; every secret the job needs must be
 * set; and when the run writes the remote D1, `apps/site/wrangler.toml` must
 * name the real database (wrangler reads the id from there, not from the
 * environment). Messages name variables, never values.
 */

/** Secrets and variables each live job needs. */
export const LIVE_REQUIREMENTS: Readonly<Record<BudgetJob, readonly (keyof PipelineEnv)[]>> = Object.freeze({
  nightly: ["PUBLIC_SITE_URL", "ANTHROPIC_API_KEY", "SERP_API_KEY"],
  monthly: ["PUBLIC_SITE_URL", "ANTHROPIC_API_KEY"],
});
/** Needed whenever the run reads and writes the remote D1. */
export const REMOTE_D1_REQUIREMENTS: readonly (keyof PipelineEnv)[] = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
];

export const WRANGLER_TOML = join(PATHS.site, "wrangler.toml");
export const DATABASE_ID_PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";

/** `database_id` of the `gof` D1 binding in wrangler.toml, or null. */
export function wranglerDatabaseId(toml: string): string | null {
  const m = /^\s*database_id\s*=\s*"([^"]*)"/m.exec(toml);
  return m?.[1] ?? null;
}

export interface PreflightResult {
  ok: boolean;
  env: PipelineEnv | null;
  problems: string[];
}

export function livePreflight(
  job: BudgetJob,
  rawEnv: Readonly<Record<string, string | undefined>>,
  opts: { d1: D1Target; wranglerToml?: string | null },
): PreflightResult {
  const problems: string[] = [];
  const parsed = pipelineEnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    for (const i of parsed.error.issues) problems.push(`${i.path.join(".") || "env"}: ${i.message}`);
    return { ok: false, env: null, problems };
  }
  const env = parsed.data;
  const needed = [...LIVE_REQUIREMENTS[job], ...(opts.d1 === "remote" ? REMOTE_D1_REQUIREMENTS : [])];
  for (const name of needed) {
    const v = env[name];
    if (v === undefined || v === "") problems.push(`${name} is not set`);
  }
  if (opts.d1 === "remote") {
    let toml = opts.wranglerToml;
    if (toml === undefined) {
      try {
        toml = readFileSync(WRANGLER_TOML, "utf8");
      } catch {
        toml = null;
      }
    }
    const id = toml ? wranglerDatabaseId(toml) : null;
    if (!id || id === DATABASE_ID_PLACEHOLDER) {
      problems.push(
        "apps/site/wrangler.toml still has no database_id for the gof D1 (set it to the id from `wrangler d1 create gof`)",
      );
    } else if (env.D1_DATABASE_ID && env.D1_DATABASE_ID !== id) {
      problems.push("D1_DATABASE_ID does not match database_id in apps/site/wrangler.toml");
    }
  }
  return { ok: problems.length === 0, env, problems };
}

/** The message a refused live run prints. */
export function preflightMessage(job: BudgetJob, problems: readonly string[]): string {
  return [
    `pipeline: refusing to start a live ${job} run; nothing was fetched, sent or written:`,
    ...problems.map((p) => `  - ${p}`),
    "Secrets come from the environment (GitHub Actions: the production environment). See the root README, 'Before the first live run'.",
  ].join("\n");
}
