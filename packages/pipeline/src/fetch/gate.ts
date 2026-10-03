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

  constructor(opts: { clock: Clock; sleep?: Sleep; floorMs?: number }) {
    this.clock = opts.clock;
    this.sleep = opts.sleep ?? realSleep;
    this.floorMs = opts.floorMs ?? MIN_HOST_SPACING_MS;
  }

  async run<T>(host: string, spacingMs: number, fn: () => Promise<T>): Promise<T> {
    const key = host.toLowerCase();
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      const gap = Math.max(this.floorMs, spacingMs);
      const last = this.lastStart.get(key);
      if (last !== undefined) {
        const wait = last + gap - this.clock.nowMs();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart.set(key, this.clock.nowMs());
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
