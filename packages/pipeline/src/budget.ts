import {
  type Budget,
  type BudgetCap,
  type BudgetProfile,
  resolveBudget,
} from "@gof/shared/budget";

/** Caps that are counted per run (minutes and the monthly spend cap are checked elsewhere). */
export type Meter = Exclude<BudgetCap, "MAX_FETCH_MINUTES" | "MONTHLY_SPEND_CAP_CENTS">;

export class BudgetGuard {
  readonly budget: Budget;
  private readonly counts = new Map<Meter, number>();
  private readonly hits = new Set<Meter>();

  constructor(
    profile: BudgetProfile = "nightly",
    env: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.budget = resolveBudget(profile, env);
  }

  spent(meter: Meter): number {
    return this.counts.get(meter) ?? 0;
  }

  remaining(meter: Meter): number {
    return Math.max(0, this.budget[meter] - this.spent(meter));
  }

  tryConsume(meter: Meter, amount = 1): boolean {
    if (this.remaining(meter) < amount) {
      this.hits.add(meter);
      return false;
    }
    this.counts.set(meter, this.spent(meter) + amount);
    return true;
  }

  hitList(): Meter[] {
    return [...this.hits];
  }
}
