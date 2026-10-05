import { z } from "zod";
import { BUDGET_CAPS } from "./budget.ts";

/**
 * Environment schemas for SPEC.md section 6. The Worker and the pipeline both
 * validate their env with these at startup. Secrets are optional here so that
 * dry runs and local dev work without them; the stages that need a secret call
 * `requireSecret`.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const isoDateOrTimestamp = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: "must be an ISO date or timestamp",
  });

const optionalClock = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v))
  .pipe(isoDateOrTimestamp.optional());

export const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development");

export const adsProviderSchema = z.enum(["adsense", "journey", "raptive"]);

/** Worker vars and secrets (apps/site). */
export const siteEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  PUBLIC_SITE_URL: z.string().url(),
  PUBLIC_ADSENSE_CLIENT: z.string().default(""),
  PUBLIC_GA4_ID: z.string().default(""),
  ADS_PROVIDER: adsProviderSchema.default("adsense"),
  INDEXNOW_KEY: optionalString,
  TURNSTILE_SECRET: optionalString,
  SITE_NOW: optionalClock,
});
export type SiteEnv = z.infer<typeof siteEnvSchema>;

const capOverrides = Object.fromEntries(
  BUDGET_CAPS.map((cap) => [cap, z.coerce.number().int().min(0).optional()]),
) as Record<(typeof BUDGET_CAPS)[number], z.ZodOptional<z.ZodNumber>>;

/**
 * Where the pipeline's LLM calls go: `api` is the Anthropic Message Batches API
 * (ANTHROPIC_API_KEY); `claude-cli` spawns the logged-in `claude -p` (Claude
 * Code headless, billed to the owner's subscription, no key).
 */
export const llmProviderSchema = z.enum(["api", "claude-cli"]);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

/**
 * Where search-by-place and search-by-course queries go: `dataforseo`
 * (SERP_API_KEY), `claude-search` (`claude -p` with only WebSearch, on the
 * subscription), or `fixture` (tests/fixtures/serp, no network).
 */
export const serpProviderSchema = z.enum(["dataforseo", "claude-search", "fixture"]);
export type SerpProvider = z.infer<typeof serpProviderSchema>;

const optionalEnum = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()))
    .pipe(schema.optional());

/** GitHub Actions and local env for packages/pipeline. */
export const pipelineEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  PUBLIC_SITE_URL: z.string().url(),
  ANTHROPIC_API_KEY: optionalString,
  SERP_API_KEY: optionalString.refine((v) => v === undefined || v.includes(":"), {
    message: "SERP_API_KEY must be DataForSEO credentials as login:password",
  }),
  CLOUDFLARE_API_TOKEN: optionalString,
  CLOUDFLARE_ACCOUNT_ID: optionalString,
  D1_DATABASE_ID: optionalString,
  INDEXNOW_KEY: optionalString,
  GH_TOKEN: optionalString,
  PIPELINE_NOW: optionalClock,
  LLM_PROVIDER: optionalEnum(llmProviderSchema),
  SERP_PROVIDER: optionalEnum(serpProviderSchema),
  /** Parallel `claude -p` processes for claude-cli and claude-search (default 3). */
  CLAUDE_CLI_CONCURRENCY: z.coerce.number().int().min(1).max(8).optional(),
  ...capOverrides,
});
export type PipelineEnv = z.infer<typeof pipelineEnvSchema>;

export interface LiveSecretsInput {
  job: "nightly" | "monthly";
  llm: LlmProvider;
  serp: SerpProvider;
  d1: "local" | "remote" | "memory";
}

/**
 * The variables a live run must have, given its providers and D1 target. The
 * remote D1 needs the Cloudflare credentials and the public site URL (the
 * crawler's user agent names it); a local D1 run falls back to the dev URL.
 * `claude-cli` and `claude-search` need no key: they run on the logged-in
 * Claude Code subscription.
 */
export function requiredLiveSecrets(o: LiveSecretsInput): (keyof PipelineEnv)[] {
  const out: (keyof PipelineEnv)[] = [];
  if (o.d1 === "remote") out.push("PUBLIC_SITE_URL");
  if (o.llm === "api") out.push("ANTHROPIC_API_KEY");
  if (o.job === "nightly" && o.serp === "dataforseo") out.push("SERP_API_KEY");
  if (o.d1 === "remote") out.push("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID");
  return out;
}

/** Every variable named in SPEC.md section 6, for docs and tests. */
export const SPEC_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "SERP_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
  "INDEXNOW_KEY",
  "TURNSTILE_SECRET",
  "PUBLIC_SITE_URL",
  "PUBLIC_ADSENSE_CLIENT",
  "PUBLIC_GA4_ID",
  "ADS_PROVIDER",
  "PIPELINE_NOW",
  "SITE_NOW",
  ...BUDGET_CAPS,
] as const;

export function parseSiteEnv(env: Readonly<Record<string, unknown>>): SiteEnv {
  return siteEnvSchema.parse(env);
}

export function parsePipelineEnv(env: Readonly<Record<string, unknown>>): PipelineEnv {
  return pipelineEnvSchema.parse(env);
}

/** Throws a message that names the variable, never its value. */
export function requireSecret<K extends string>(
  env: Readonly<Partial<Record<K, string | undefined>>>,
  name: K,
): string {
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
}

/**
 * The clock override (`PIPELINE_NOW`, `SITE_NOW`) applies only outside production.
 * Returns epoch milliseconds.
 */
export function resolveNow(
  override: string | undefined,
  nodeEnv: string | undefined,
  systemNowMs: number,
): number {
  if (override && nodeEnv !== "production") {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(override) ? `${override}T12:00:00Z` : override);
    if (!Number.isNaN(ms)) return ms;
  }
  return systemNowMs;
}
