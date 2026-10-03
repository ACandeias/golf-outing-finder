import type { Stage } from "./types.ts";

/** Thrown by a stage stub. The runner reports it by name; `--strict` makes it fatal. */
export class NotImplemented extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`stage not implemented: ${stage}`);
    this.name = "NotImplemented";
    this.stage = stage;
  }
}

const STUB = Symbol.for("gof.pipeline.stageStub");

/**
 * A placeholder for a stage another workstream implements. Replace the export
 * with the real function; `isImplemented` then turns true and the golden tests
 * gated on it start running.
 */
export function notImplemented<I, O>(stage: string): Stage<I, O> {
  const fn: Stage<I, O> = () => {
    throw new NotImplemented(stage);
  };
  Object.defineProperty(fn, STUB, { value: stage });
  return fn;
}

export function isImplemented(fn: unknown): boolean {
  return typeof fn === "function" && !(STUB in fn);
}

export function isNotImplementedError(err: unknown): err is NotImplemented {
  return err instanceof NotImplemented;
}
