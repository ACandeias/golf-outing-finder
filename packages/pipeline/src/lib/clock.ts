import { resolveNow } from "@gof/shared/env";

/** The run clock: PIPELINE_NOW outside production, else the system clock (SPEC.md 8.0). */
export function pipelineNow(env: NodeJS.ProcessEnv = process.env): number {
  return resolveNow(env.PIPELINE_NOW, env.NODE_ENV, Date.now());
}
