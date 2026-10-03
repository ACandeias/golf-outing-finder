import net from "node:net";
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";

/**
 * `--dry-run` guarantees zero network calls (SPEC.md 13, Phase 2): an undici
 * global dispatcher that refuses every request (Node's built-in fetch uses the
 * same global dispatcher), plus a guard on TCP socket connects for anything that
 * bypasses undici (node:http, node:https, raw sockets). Unix-socket and pipe
 * connects stay allowed. Child processes (wrangler for the local D1) are not
 * affected and must not use the network themselves in a dry run.
 */

export class NetworkBlockedError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`network access blocked in --dry-run: ${target}`);
    this.name = "NetworkBlockedError";
    this.target = target;
  }
}

export interface NetworkBlock {
  /** Requests refused so far, as "origin/path" or "host:port". */
  readonly attempts: readonly string[];
  restore(): void;
}

class RefusingDispatcher extends Dispatcher {
  private readonly onAttempt: (target: string) => void;
  constructor(onAttempt: (target: string) => void) {
    super();
    this.onAttempt = onAttempt;
  }

  override dispatch(options: Dispatcher.DispatchOptions): boolean {
    const target = `${String(options.origin ?? "")}${options.path}`;
    this.onAttempt(target);
    throw new NetworkBlockedError(target);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(a?: Error | null | (() => void), b?: () => void): Promise<void> | void {
    const cb = typeof a === "function" ? a : b;
    if (cb) {
      cb();
      return;
    }
    return Promise.resolve();
  }
}

type ConnectFn = (...args: unknown[]) => net.Socket;

function connectTarget(args: readonly unknown[]): string | null {
  const [first, second] = args;
  if (typeof first === "number")
    return `${typeof second === "string" ? second : "localhost"}:${first}`;
  if (typeof first === "string" && /^\d+$/.test(first)) return `localhost:${first}`;
  if (Array.isArray(first)) return connectTarget(first);
  if (typeof first === "object" && first !== null) {
    const o = first as { port?: unknown; host?: unknown; path?: unknown };
    if (o.path !== undefined && o.port === undefined) return null; // IPC
    if (o.port !== undefined)
      return `${typeof o.host === "string" ? o.host : "localhost"}:${String(o.port)}`;
  }
  return null; // a pipe path
}

let active: NetworkBlock | null = null;

/** Installs the block; idempotent. `restore()` puts the previous dispatcher back. */
export function installNetworkBlock(): NetworkBlock {
  if (active) return active;
  const attempts: string[] = [];
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(new RefusingDispatcher((t) => attempts.push(t)));

  const proto = net.Socket.prototype as unknown as { connect: ConnectFn };
  const originalConnect = proto.connect;
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    if (target !== null) {
      attempts.push(target);
      throw new NetworkBlockedError(target);
    }
    return originalConnect.apply(this, args);
  };

  const block: NetworkBlock = {
    attempts,
    restore() {
      setGlobalDispatcher(previous);
      proto.connect = originalConnect;
      active = null;
    },
  };
  active = block;
  return block;
}
