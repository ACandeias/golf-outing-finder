import type { z } from "zod";
import type { UpsertPlan } from "../stages/types.ts";

/** Read access to the run's database snapshot (node:sqlite over the export). */
export interface Snapshot {
  /** Every row, each validated with `schema`. */
  all<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[];
  close(): void;
}

export interface ApplyReport {
  statements: number;
  files: number;
}

export type D1Target = "remote" | "local" | "memory";

/**
 * The pipeline's only database edge. A run starts from `snapshot()` and writes
 * through `apply()`; stages see neither.
 */
export interface D1Port {
  readonly target: D1Target;
  snapshot(): Promise<Snapshot>;
  apply(plan: UpsertPlan): Promise<ApplyReport>;
  /** A live read after writes (run report hold counts); rows validated with `schema`. */
  query<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]>;
}
