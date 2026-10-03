import { z } from "zod";

/** Every per-run cap from SPEC.md section 14. */
export const BUDGET_CAPS = [
  "MAX_SERP_QUERIES_PER_RUN",
  "MAX_EXTRACTIONS_PER_RUN",
  "MAX_LLM_INPUT_TOKENS_PER_RUN",
  "MAX_COURSE_CLASSIFICATIONS_PER_RUN",
  "MAX_FETCHES_PER_RUN",
  "MAX_RENDERS_PER_RUN",
  "MAX_FETCH_MINUTES",
  "MAX_FETCHES_PER_HOST_PER_RUN",
  "MONTHLY_SPEND_CAP_CENTS",
] as const;
export type BudgetCap = (typeof BUDGET_CAPS)[number];
export type Budget = Record<BudgetCap, number>;

export const budgetProfileSchema = z.enum(["nightly", "monthly", "smoke"]);
export type BudgetProfile = z.infer<typeof budgetProfileSchema>;
/** The `runs.kind` a profile runs as: `smoke` is a small nightly run. */
export type BudgetJob = "nightly" | "monthly";

export function budgetJob(profile: BudgetProfile): BudgetJob {
  return profile === "monthly" ? "monthly" : "nightly";
}

/**
 * Budget profiles from SPEC.md section 14. Raising any of these values needs the
 * owner's approval (CLAUDE.md). An env var of the same name overrides its default.
 */
export const BUDGET_PROFILES: Readonly<Record<BudgetProfile, Readonly<Budget>>> = Object.freeze({
  nightly: Object.freeze({
    MAX_SERP_QUERIES_PER_RUN: 450,
    MAX_EXTRACTIONS_PER_RUN: 600,
    MAX_LLM_INPUT_TOKENS_PER_RUN: 2_000_000,
    MAX_COURSE_CLASSIFICATIONS_PER_RUN: 0,
    MAX_FETCHES_PER_RUN: 2500,
    MAX_RENDERS_PER_RUN: 400,
    MAX_FETCH_MINUTES: 45,
    MAX_FETCHES_PER_HOST_PER_RUN: 150,
    MONTHLY_SPEND_CAP_CENTS: 15_000,
  }),
  monthly: Object.freeze({
    MAX_SERP_QUERIES_PER_RUN: 0,
    MAX_EXTRACTIONS_PER_RUN: 0,
    MAX_LLM_INPUT_TOKENS_PER_RUN: 2_000_000,
    MAX_COURSE_CLASSIFICATIONS_PER_RUN: 4000,
    MAX_FETCHES_PER_RUN: 8000,
    MAX_RENDERS_PER_RUN: 0,
    MAX_FETCH_MINUTES: 45,
    MAX_FETCHES_PER_HOST_PER_RUN: 150,
    MONTHLY_SPEND_CAP_CENTS: 15_000,
  }),
  /**
   * The owner's first live run (`--budget=smoke`): the nightly stages with every
   * count capped at 5 to 10, so one run costs a few cents and finishes in
   * minutes. The token cap fits 10 extractions of about 4,000 tokens plus
   * headroom; the monthly spend cap is the same month-wide ceiling as nightly.
   */
  smoke: Object.freeze({
    MAX_SERP_QUERIES_PER_RUN: 5,
    MAX_EXTRACTIONS_PER_RUN: 10,
    MAX_LLM_INPUT_TOKENS_PER_RUN: 60_000,
    MAX_COURSE_CLASSIFICATIONS_PER_RUN: 0,
    MAX_FETCHES_PER_RUN: 10,
    MAX_RENDERS_PER_RUN: 5,
    MAX_FETCH_MINUTES: 10,
    MAX_FETCHES_PER_HOST_PER_RUN: 5,
    MONTHLY_SPEND_CAP_CENTS: 15_000,
  }),
});

const capValue = z.coerce.number().int().min(0);

/** Resolves a profile's caps, letting env vars of the same name override each one. */
export function resolveBudget(
  profile: BudgetProfile,
  env: Readonly<Record<string, string | undefined>> = {},
): Budget {
  const base = BUDGET_PROFILES[profile];
  const out = { ...base };
  for (const cap of BUDGET_CAPS) {
    const raw = env[cap];
    if (raw !== undefined && raw !== "") {
      const parsed = capValue.safeParse(raw);
      if (!parsed.success) throw new Error(`${cap} must be a non-negative integer, got "${raw}"`);
      out[cap] = parsed.data;
    }
  }
  return out;
}
