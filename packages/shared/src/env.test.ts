import { describe, expect, it } from "vitest";
import { BUDGET_CAPS, BUDGET_PROFILES, resolveBudget } from "./budget.ts";
import {
  SPEC_ENV_VARS,
  parsePipelineEnv,
  parseSiteEnv,
  pipelineEnvSchema,
  requireSecret,
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
  it("profiles define every cap and are frozen", () => {
    for (const p of ["nightly", "monthly"] as const) {
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
