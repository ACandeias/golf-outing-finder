import { AsyncLocalStorage } from "node:async_hooks";
import type { Clock } from "../stages/types.ts";

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SPEC.md 8.3: at least 5 seconds between requests to one host. */
export const MIN_HOST_SPACING_MS = 5_000;

/**
 * One request at a time per host, with at least `spacingMs` between the start
 * of one request and the start of the next (robots.txt crawl-delay raises it).
 */
export class HostGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStart = new Map<string, number>();
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly floorMs: number;
  /** Hosts the current async call chain holds (a robots.txt fetch during a redirect re-enters). */
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(opts: { clock: Clock; sleep?: Sleep; floorMs?: number }) {
    this.clock = opts.clock;
    this.sleep = opts.sleep ?? realSleep;
    this.floorMs = opts.floorMs ?? MIN_HOST_SPACING_MS;
  }

  async run<T>(host: string, spacingMs: number, fn: () => Promise<T>): Promise<T> {
    const key = host.toLowerCase();
    const holding = this.held.getStore();
    if (holding?.has(key)) {
      // Re-entry from inside this host's own slot (a redirect to the host's other
      // origin needs that origin's robots.txt): waiting on our own tail would never
      // end. Run in place, still spaced from the previous request.
      await this.space(key, spacingMs);
      return fn();
    }
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      await this.space(key, spacingMs);
      return await this.held.run(new Set([...(holding ?? []), key]), fn);
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private async space(key: string, spacingMs: number): Promise<void> {
    const gap = Math.max(this.floorMs, spacingMs);
    const last = this.lastStart.get(key);
    if (last !== undefined) {
      const wait = last + gap - this.clock.nowMs();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart.set(key, this.clock.nowMs());
  }
}
