import { type Budget, type BudgetCap, type BudgetProfile, resolveBudget } from "@gof/shared/budget";
import type { Allowance, BudgetCheck, BudgetHit, Clock, RunCounter } from "./stages/types.ts";

/**
 * Budget guard (SPEC.md 8.0 and 14). Per-run caps come from the `nightly` or
 * `monthly` profile with env overrides; `MONTHLY_SPEND_CAP_CENTS` is checked
 * against this calendar month's `runs` rows, passed in as data. A cap that is
 * reached never throws: `check` records a budget hit and returns false, the
 * stage stops that kind of work, and the remaining stages still run.
 */

/** Caps counted per run, each backed by a `runs` counter. */
export const METER_COUNTERS = {
  MAX_SERP_QUERIES_PER_RUN: "serp_queries",
  MAX_EXTRACTIONS_PER_RUN: "extractions",
  MAX_LLM_INPUT_TOKENS_PER_RUN: "llm_input_tokens",
  MAX_COURSE_CLASSIFICATIONS_PER_RUN: "course_classifications",
  MAX_FETCHES_PER_RUN: "fetches",
  MAX_RENDERS_PER_RUN: "renders",
} as const satisfies Partial<Record<BudgetCap, RunCounter>>;
export type Meter = keyof typeof METER_COUNTERS;
export const METERS = Object.keys(METER_COUNTERS) as Meter[];

/** Meters that spend money; blocked when the monthly spend cap is reached. */
export const PAID_METERS: readonly Meter[] = [
  "MAX_SERP_QUERIES_PER_RUN",
  "MAX_EXTRACTIONS_PER_RUN",
  "MAX_LLM_INPUT_TOKENS_PER_RUN",
  "MAX_COURSE_CLASSIFICATIONS_PER_RUN",
];

export function isMeter(cap: BudgetCap): cap is Meter {
  return cap in METER_COUNTERS;
}

/**
 * SPEC.md 14 rates, in millionths of a cent so the arithmetic stays integral:
 * Claude Haiku 4.5 through the Batch API at $0.50 per million input tokens and
 * $2.50 per million output tokens; DataForSEO standard queue at $0.60 per 1,000
 * queries. Check current prices before changing these (CLAUDE.md).
 */
export const RATES_MICROCENTS = {
  llmInputPerToken: 50, // $0.50 / 1e6 tokens = 50e-6 cents
  llmOutputPerToken: 250, // $2.50 / 1e6 tokens
  serpPerQuery: 60_000, // $0.60 / 1e3 queries = 0.06 cents
} as const;

export interface CostUsage {
  llm_input_tokens: number;
  llm_output_tokens: number;
  serp_queries: number;
}

/** Estimated cost in whole cents, rounded up. */
export function estimateCostCents(u: CostUsage): number {
  const micro =
    u.llm_input_tokens * RATES_MICROCENTS.llmInputPerToken +
    u.llm_output_tokens * RATES_MICROCENTS.llmOutputPerToken +
    u.serp_queries * RATES_MICROCENTS.serpPerQuery;
  return Math.ceil(micro / 1_000_000);
}

/** The slice of a `runs` row the monthly cap needs. */
export interface RunSpend {
  id: string;
  started_at: string;
  est_cost_cents: number;
}

/** Sum of `est_cost_cents` over runs started in `now`'s calendar month (UTC), minus `excludeId`. */
export function monthSpentCents(runs: readonly RunSpend[], now: Date, excludeId?: string): number {
  const month = now.toISOString().slice(0, 7);
  let sum = 0;
  for (const r of runs) {
    if (r.id === excludeId) continue;
    if (r.started_at.slice(0, 7) === month) sum += r.est_cost_cents;
  }
  return sum;
}

export interface BudgetGuardOptions {
  profile?: BudgetProfile;
  env?: Readonly<Record<string, string | undefined>>;
  /** Resolved caps; overrides `profile` and `env` when given. */
  caps?: Budget;
  /** The run's logical now (Context.now). */
  now?: Date;
  /** This month's (or all) `runs` rows, from the snapshot. */
  monthRuns?: readonly RunSpend[];
  /** The current run's id, excluded from `monthRuns`. */
  runId?: string;
  /** Wall clock for MAX_FETCH_MINUTES. */
  clock?: Clock;
}

export class BudgetGuard implements BudgetCheck {
  readonly caps: Readonly<Budget>;
  /** Kept as `budget` for the Phase 1 callers. */
  readonly budget: Readonly<Budget>;
  private readonly now: Date;
  private readonly monthRuns: readonly RunSpend[];
  private readonly runId: string | undefined;
  private readonly clock: Clock;
  private readonly used = new Map<Meter, number>();
  private readonly hostFetches = new Map<string, number>();
  private readonly hitList: BudgetHit[] = [];
  private outputTokens = 0;
  private fetchStartedMs: number | null = null;
  private paidBlocked = false;

  constructor(
    profileOrOptions: BudgetProfile | BudgetGuardOptions = {},
    env: Readonly<Record<string, string | undefined>> = {},
  ) {
    const o: BudgetGuardOptions =
      typeof profileOrOptions === "string" ? { profile: profileOrOptions, env } : profileOrOptions;
    this.caps = Object.freeze({
      ...(o.caps ?? resolveBudget(o.profile ?? "nightly", o.env ?? {})),
    });
    this.budget = this.caps;
    this.now = o.now ?? new Date(0);
    this.monthRuns = o.monthRuns ?? [];
    this.runId = o.runId;
    this.clock = o.clock ?? { nowMs: () => Date.now() };
  }

  spent(meter: Meter): number {
    return this.used.get(meter) ?? 0;
  }

  remaining(meter: Meter): number {
    if (this.paidBlocked && PAID_METERS.includes(meter)) return 0;
    return Math.max(0, this.caps[meter] - this.spent(meter));
  }

  /**
   * Before a paid or capped call: consumes `amount` and returns true, or records
   * a budget hit and returns false. Never throws for a reached cap.
   */
  check(cap: BudgetCap, amount = 1, stage = "unknown"): boolean {
    if (cap === "MONTHLY_SPEND_CAP_CENTS") return this.monthlySpendOk(stage);
    if (cap === "MAX_FETCH_MINUTES") return this.checkFetchMinutes(stage);
    if (cap === "MAX_FETCHES_PER_HOST_PER_RUN") {
      throw new Error("use checkHost(host) for MAX_FETCHES_PER_HOST_PER_RUN");
    }
    if (this.paidBlocked && PAID_METERS.includes(cap)) {
      this.recordHit("MONTHLY_SPEND_CAP_CENTS", stage, `${cap} blocked: monthly spend cap reached`);
      return false;
    }
    if (this.remaining(cap) < amount) {
      this.recordHit(cap, stage);
      return false;
    }
    this.used.set(cap, this.spent(cap) + amount);
    return true;
  }

  /** Phase 1 name for `check`. */
  tryConsume(meter: Meter, amount = 1): boolean {
    return this.check(meter, amount);
  }

  /** MAX_FETCHES_PER_HOST_PER_RUN: consumes one fetch for `host`, or records a hit. */
  checkHost(host: string, stage = "fetch"): boolean {
    const h = host.toLowerCase();
    const n = this.hostFetches.get(h) ?? 0;
    if (n >= this.caps.MAX_FETCHES_PER_HOST_PER_RUN) {
      this.recordHit("MAX_FETCHES_PER_HOST_PER_RUN", stage, h);
      return false;
    }
    this.hostFetches.set(h, n + 1);
    return true;
  }

  /** Starts the MAX_FETCH_MINUTES clock (the fetch stage calls this once). */
  startFetchTimer(): void {
    this.fetchStartedMs ??= this.clock.nowMs();
  }

  /** False, with a hit, once the fetch stage has run MAX_FETCH_MINUTES. */
  checkFetchMinutes(stage = "fetch"): boolean {
    this.startFetchTimer();
    const elapsedMs = this.clock.nowMs() - (this.fetchStartedMs ?? 0);
    if (elapsedMs >= this.caps.MAX_FETCH_MINUTES * 60_000) {
      this.recordHit("MAX_FETCH_MINUTES", stage);
      return false;
    }
    return true;
  }

  /** Adds usage a stage reported in its counters (stages account against their allowance). */
  record(counters: Partial<Record<RunCounter, number>>): void {
    for (const meter of METERS) {
      const n = counters[METER_COUNTERS[meter]];
      if (n !== undefined && n > 0) this.used.set(meter, this.spent(meter) + n);
    }
    this.outputTokens += counters.llm_output_tokens ?? 0;
  }

  /** Output tokens are priced but not capped per run. */
  recordOutputTokens(n: number): void {
    this.outputTokens += n;
  }

  outputTokensSpent(): number {
    return this.outputTokens;
  }

  /** This run's estimated cost so far, in cents (SPEC.md 14 rates). */
  estCostCents(): number {
    return estimateCostCents({
      llm_input_tokens: this.spent("MAX_LLM_INPUT_TOKENS_PER_RUN"),
      llm_output_tokens: this.outputTokens,
      serp_queries: this.spent("MAX_SERP_QUERIES_PER_RUN"),
    });
  }

  /** Earlier runs this month plus this run so far. */
  monthSpentCents(): number {
    return monthSpentCents(this.monthRuns, this.now, this.runId) + this.estCostCents();
  }

  /**
   * Before any paid stage (SPEC.md 8.0): at or over MONTHLY_SPEND_CAP_CENTS, block
   * every paid meter for the rest of the run, record a hit and return false.
   */
  monthlySpendOk(stage: string): boolean {
    if (this.paidBlocked) return false;
    const spent = this.monthSpentCents();
    if (spent >= this.caps.MONTHLY_SPEND_CAP_CENTS) {
      this.paidBlocked = true;
      this.recordHit("MONTHLY_SPEND_CAP_CENTS", stage, `month to date ${spent} cents`);
      return false;
    }
    return true;
  }

  get paidWorkBlocked(): boolean {
    return this.paidBlocked;
  }

  /** Remaining units per cap, handed to pure stages as `input.allowance`. */
  allowance(): Allowance {
    const a: Allowance = {};
    for (const m of METERS) a[m] = this.remaining(m);
    a.MAX_FETCHES_PER_HOST_PER_RUN = this.caps.MAX_FETCHES_PER_HOST_PER_RUN;
    a.MAX_FETCH_MINUTES = this.caps.MAX_FETCH_MINUTES;
    a.MONTHLY_SPEND_CAP_CENTS = Math.max(
      0,
      this.caps.MONTHLY_SPEND_CAP_CENTS - this.monthSpentCents(),
    );
    return a;
  }

  /** Records a hit once per (cap, stage); stages that stopped on an allowance report theirs too. */
  recordHit(cap: BudgetCap, stage: string, detail?: string): void {
    if (this.hitList.some((h) => h.cap === cap && h.stage === stage)) return;
    const limit = this.caps[cap];
    this.hitList.push({
      stage,
      cap,
      limit,
      at: this.now.toISOString(),
      ...(detail ? { detail } : {}),
    });
  }

  /** Merges hits a pure stage returned. */
  addHits(hits: readonly BudgetHit[]): void {
    for (const h of hits) this.recordHit(h.cap, h.stage, h.detail);
  }

  hits(): BudgetHit[] {
    return this.hitList.map((h) => ({ ...h }));
  }
}
