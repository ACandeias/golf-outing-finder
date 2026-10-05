import { describe, expect, it } from "vitest";
import { BUDGET_CAPS, BUDGET_PROFILES, budgetJob, resolveBudget } from "./budget.ts";
import {
  SPEC_ENV_VARS,
  parsePipelineEnv,
  parseSiteEnv,
  pipelineEnvSchema,
  requireSecret,
  requiredLiveSecrets,
  resolveNow,
  siteEnvSchema,
} from "./env.ts";

describe("env schemas cover SPEC section 6", () => {
  it("every section 6 variable is in the site or pipeline schema", () => {
    const keys = new Set([
      ...Object.keys(siteEnvSchema.shape),
      ...Object.keys(pipelineEnvSchema.shape),
    ]);
    for (const name of SPEC_ENV_VARS) expect(keys, name).toContain(name);
  });

  it("parses a minimal site env with defaults", () => {
    const env = parseSiteEnv({ PUBLIC_SITE_URL: "http://localhost:8787" });
    expect(env.ADS_PROVIDER).toBe("adsense");
    expect(env.NODE_ENV).toBe("development");
    expect(env.SITE_NOW).toBeUndefined();
  });

  it("rejects a bad site URL and a bad ads provider", () => {
    expect(() => parseSiteEnv({ PUBLIC_SITE_URL: "not a url" })).toThrow();
    expect(() =>
      parseSiteEnv({ PUBLIC_SITE_URL: "http://localhost:8787", ADS_PROVIDER: "other" }),
    ).toThrow();
  });

  it("treats empty secrets as unset and validates the SERP credential shape", () => {
    const env = parsePipelineEnv({
      PUBLIC_SITE_URL: "https://golfoutingfinder.com",
      ANTHROPIC_API_KEY: "",
      SERP_API_KEY: "login:password",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() =>
      parsePipelineEnv({ PUBLIC_SITE_URL: "https://x.example", SERP_API_KEY: "nocolon" }),
    ).toThrow(/login:password/);
  });

  it("takes optional Search Console and Bing verification tokens", () => {
    const base = { PUBLIC_SITE_URL: "https://golfoutingfinder.com" };
    const none = parseSiteEnv({ ...base, GOOGLE_SITE_VERIFICATION: "", BING_SITE_VERIFICATION: "  " });
    expect(none.GOOGLE_SITE_VERIFICATION).toBeUndefined();
    expect(none.BING_SITE_VERIFICATION).toBeUndefined();
    expect(parseSiteEnv(base).GOOGLE_SITE_VERIFICATION).toBeUndefined();
    const set = parseSiteEnv({
      ...base,
      GOOGLE_SITE_VERIFICATION: "aBcD-1234_efGH5678ijkl",
      BING_SITE_VERIFICATION: "0123456789ABCDEF0123456789ABCDEF",
    });
    expect(set.GOOGLE_SITE_VERIFICATION).toBe("aBcD-1234_efGH5678ijkl");
    expect(set.BING_SITE_VERIFICATION).toBe("0123456789ABCDEF0123456789ABCDEF");
    // The token only: a pasted meta tag or anything with quotes is rejected.
    expect(() =>
      parseSiteEnv({ ...base, GOOGLE_SITE_VERIFICATION: '<meta name="google-site-verification" content="abc">' }),
    ).toThrow(/verification token only/);
    expect(() => parseSiteEnv({ ...base, BING_SITE_VERIFICATION: 'abc"def12345' })).toThrow();
  });

  it("validates clock overrides and cap overrides", () => {
    expect(parsePipelineEnv({ PUBLIC_SITE_URL: "https://x.example", PIPELINE_NOW: "2026-09-28" }).PIPELINE_NOW).toBe(
      "2026-09-28",
    );
    expect(() =>
      parsePipelineEnv({ PUBLIC_SITE_URL: "https://x.example", PIPELINE_NOW: "yesterday" }),
    ).toThrow();
    expect(
      parsePipelineEnv({ PUBLIC_SITE_URL: "https://x.example", MAX_SERP_QUERIES_PER_RUN: "5" })
        .MAX_SERP_QUERIES_PER_RUN,
    ).toBe(5);
  });
});

describe("LLM and SERP providers", () => {
  const base = { PUBLIC_SITE_URL: "https://x.example" };

  it("defaults to no provider override and accepts the subscription-backed ones", () => {
    const env = parsePipelineEnv(base);
    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.SERP_PROVIDER).toBeUndefined();
    const sub = parsePipelineEnv({ ...base, LLM_PROVIDER: "claude-cli", SERP_PROVIDER: "claude-search", CLAUDE_CLI_CONCURRENCY: "2" });
    expect(sub).toMatchObject({ LLM_PROVIDER: "claude-cli", SERP_PROVIDER: "claude-search", CLAUDE_CLI_CONCURRENCY: 2 });
  });

  it("rejects an unknown provider and an out-of-range concurrency", () => {
    expect(() => parsePipelineEnv({ ...base, LLM_PROVIDER: "openai" })).toThrow();
    expect(() => parsePipelineEnv({ ...base, SERP_PROVIDER: "google" })).toThrow();
    expect(() => parsePipelineEnv({ ...base, CLAUDE_CLI_CONCURRENCY: "0" })).toThrow();
    expect(() => parsePipelineEnv({ ...base, CLAUDE_CLI_CONCURRENCY: "9" })).toThrow();
  });

  it("a live run needs only the secrets its providers and D1 target use", () => {
    expect(requiredLiveSecrets({ job: "nightly", llm: "api", serp: "dataforseo", d1: "remote" })).toEqual([
      "PUBLIC_SITE_URL",
      "ANTHROPIC_API_KEY",
      "SERP_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "D1_DATABASE_ID",
    ]);
    expect(requiredLiveSecrets({ job: "nightly", llm: "claude-cli", serp: "claude-search", d1: "local" })).toEqual([]);
    expect(requiredLiveSecrets({ job: "nightly", llm: "claude-cli", serp: "dataforseo", d1: "local" })).toEqual([
      "SERP_API_KEY",
    ]);
    expect(requiredLiveSecrets({ job: "monthly", llm: "api", serp: "dataforseo", d1: "local" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    expect(requiredLiveSecrets({ job: "nightly", llm: "api", serp: "fixture", d1: "memory" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });
});

describe("requireSecret", () => {
  it("names the variable and never echoes a value", () => {
    expect(() => requireSecret({ ANTHROPIC_API_KEY: undefined }, "ANTHROPIC_API_KEY")).toThrow(
      "ANTHROPIC_API_KEY is not set",
    );
    expect(requireSecret({ X: "v" }, "X")).toBe("v");
  });
});

describe("resolveNow", () => {
  const system = Date.parse("2026-10-03T15:00:00Z");
  it("uses the override outside production", () => {
    expect(new Date(resolveNow("2026-09-28", "test", system)).toISOString()).toBe(
      "2026-09-28T12:00:00.000Z",
    );
    expect(resolveNow("2026-09-28T04:00:00Z", undefined, system)).toBe(
      Date.parse("2026-09-28T04:00:00Z"),
    );
  });
  it("ignores the override in production", () => {
    expect(resolveNow("2026-09-28", "production", system)).toBe(system);
  });
  it("falls back to the system clock without an override", () => {
    expect(resolveNow(undefined, "development", system)).toBe(system);
  });
});

describe("budget profiles (SPEC section 14)", () => {
  it("nightly matches the spec table", () => {
    expect(BUDGET_PROFILES.nightly).toEqual({
      MAX_SERP_QUERIES_PER_RUN: 450,
      MAX_EXTRACTIONS_PER_RUN: 600,
      MAX_LLM_INPUT_TOKENS_PER_RUN: 2_000_000,
      MAX_COURSE_CLASSIFICATIONS_PER_RUN: 0,
      MAX_FETCHES_PER_RUN: 2500,
      MAX_RENDERS_PER_RUN: 400,
      MAX_FETCH_MINUTES: 45,
      MAX_FETCHES_PER_HOST_PER_RUN: 150,
      MONTHLY_SPEND_CAP_CENTS: 15_000,
    });
  });
  it("monthly matches the spec table", () => {
    expect(BUDGET_PROFILES.monthly).toEqual({
      MAX_SERP_QUERIES_PER_RUN: 0,
      MAX_EXTRACTIONS_PER_RUN: 0,
      MAX_LLM_INPUT_TOKENS_PER_RUN: 2_000_000,
      MAX_COURSE_CLASSIFICATIONS_PER_RUN: 4000,
      MAX_FETCHES_PER_RUN: 8000,
      MAX_RENDERS_PER_RUN: 0,
      MAX_FETCH_MINUTES: 45,
      MAX_FETCHES_PER_HOST_PER_RUN: 150,
      MONTHLY_SPEND_CAP_CENTS: 15_000,
    });
  });
  it("smoke caps every count at 5 to 10 for the owner's first live run", () => {
    expect(BUDGET_PROFILES.smoke).toEqual({
      MAX_SERP_QUERIES_PER_RUN: 5,
      MAX_EXTRACTIONS_PER_RUN: 10,
      MAX_LLM_INPUT_TOKENS_PER_RUN: 60_000,
      MAX_COURSE_CLASSIFICATIONS_PER_RUN: 0,
      MAX_FETCHES_PER_RUN: 10,
      MAX_RENDERS_PER_RUN: 5,
      MAX_FETCH_MINUTES: 10,
      MAX_FETCHES_PER_HOST_PER_RUN: 5,
      MONTHLY_SPEND_CAP_CENTS: 15_000,
    });
    // Never above nightly: smoke only lowers caps.
    for (const cap of BUDGET_CAPS) {
      expect(BUDGET_PROFILES.smoke[cap]).toBeLessThanOrEqual(BUDGET_PROFILES.nightly[cap]);
    }
    expect(budgetJob("smoke")).toBe("nightly");
    expect(budgetJob("monthly")).toBe("monthly");
  });
  it("profiles define every cap and are frozen", () => {
    for (const p of ["nightly", "monthly", "smoke"] as const) {
      expect(Object.keys(BUDGET_PROFILES[p]).sort()).toEqual([...BUDGET_CAPS].sort());
      expect(Object.isFrozen(BUDGET_PROFILES[p])).toBe(true);
    }
  });
  it("env vars override a profile's defaults", () => {
    const b = resolveBudget("nightly", { MAX_SERP_QUERIES_PER_RUN: "5", MAX_FETCHES_PER_RUN: "" });
    expect(b.MAX_SERP_QUERIES_PER_RUN).toBe(5);
    expect(b.MAX_FETCHES_PER_RUN).toBe(2500);
    expect(() => resolveBudget("monthly", { MAX_RENDERS_PER_RUN: "-1" })).toThrow(
      /MAX_RENDERS_PER_RUN/,
    );
  });
});
