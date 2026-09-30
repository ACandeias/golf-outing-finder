import { z } from "zod";

// Caps from SPEC.md section 14. Defaults live here; env vars override.
export const budgetSchema = z.object({
  MAX_SERP_QUERIES_PER_RUN: z.coerce.number().int().min(0).default(450),
  MAX_EXTRACTIONS_PER_RUN: z.coerce.number().int().min(0).default(600),
  MAX_LLM_INPUT_TOKENS_PER_RUN: z.coerce.number().int().min(0).default(2_000_000),
  MAX_COURSE_CLASSIFICATIONS_PER_RUN: z.coerce.number().int().min(0).default(4000),
  MAX_FETCHES_PER_RUN: z.coerce.number().int().min(0).default(2500),
  MAX_RENDERS_PER_RUN: z.coerce.number().int().min(0).default(400),
});
export type Budget = z.infer<typeof budgetSchema>;

export type Meter = keyof Budget;

export class BudgetGuard {
  readonly budget: Budget;
  private readonly counts = new Map<Meter, number>();
  private readonly hits = new Set<Meter>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.budget = budgetSchema.parse(env);
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
