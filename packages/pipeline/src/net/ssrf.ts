import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isExcludedUrl, type Exclusions } from "../overrides/load.ts";

/**
 * SSRF guard (SPEC.md 8.3 and 10). Every URL the fetcher or the renderer opens
 * goes through `checkUrl` first, and again after every redirect: http or https
 * only, ports 80 and 443 only, no credentials in the URL, exclusions.yaml
 * applied, and every address the host resolves to must be public. The resolver
 * is injected so tests need no DNS. `guardedLookup` repeats the check at
 * connect time inside the HTTP client, so a host cannot pass the check and then
 * resolve to a private address for the real connection (DNS rebinding).
 */

/** Resolves a host name to every A and AAAA address. Throws or returns [] when it does not resolve. */
export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const rows = await dnsLookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/** A fixed table, for tests and dry runs. Unknown hosts do not resolve. */
export function staticResolver(table: Readonly<Record<string, readonly string[]>>): Resolver {
  return async (host) => [...(table[host.toLowerCase()] ?? [])];
}

export type GuardReason =
  | "invalid"
  | "scheme"
  | "port"
  | "credentials"
  | "excluded"
  | "metadata_host"
  | "dns"
  | "private_address";

export type GuardResult =
  | { ok: true; url: string; host: string; addresses: string[] }
  | { ok: false; url: string; reason: GuardReason; detail?: string };

export interface GuardOptions {
  resolver: Resolver;
  exclusions: Exclusions;
}

/** Cloud metadata endpoints reachable by name. */
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
]);

// --- address classification ----------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [network, prefix length] blocks that are not public unicast (IANA special-purpose registry). */
const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including 169.254.169.254 metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
];

const V4_RANGES = V4_BLOCKED.map(([net, len]) => {
  const base = v4ToInt(net) ?? 0;
  const size = 2 ** (32 - len);
  return [base, base + size - 1] as const;
});

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  return V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Expands an IPv6 address (with an optional dotted IPv4 tail) into eight 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const n = v4ToInt(tail[1] ?? "");
    if (n === null) return null;
    s = `${s.slice(0, -(tail[1] ?? "").length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return true; // ::
  if (zeroTo(7) && g7 === 1) return true; // ::1
  if (zeroTo(5) && g5 === 0xffff) return isBlockedV4(v4FromGroups(g6, g7)); // ::ffff:a.b.c.d
  if (zeroTo(6)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(v4FromGroups(g6, g7)); // NAT64 64:ff9b::/96
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // local NAT64 64:ff9b:1::/48
  if (g0 === 0x2002) return isBlockedV4(v4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard 100::/64
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo etc.)
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7 (fd00:ec2::254 metadata)
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True unless `ip` is a public unicast address. Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isBlockedV4(bare);
  if (family === 6) return isBlockedV6(bare);
  return true;
}

// --- URL check --------------------------------------------------------------

/** Vets one URL. Call it before the first request and after every redirect. */
export async function checkUrl(url: string, opts: GuardOptions): Promise<GuardResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, url, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, url, reason: "scheme" };
  if (u.port !== "" && u.port !== "80" && u.port !== "443") {
    return { ok: false, url, reason: "port", detail: u.port };
  }
  if (u.username !== "" || u.password !== "") return { ok: false, url, reason: "credentials" };
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return { ok: false, url, reason: "invalid" };
  if (isExcludedUrl(url, opts.exclusions)) return { ok: false, url, reason: "excluded" };
  if (METADATA_HOSTS.has(host) || host.endsWith(".internal")) {
    return { ok: false, url, reason: "metadata_host" };
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    return isBlockedAddress(bare)
      ? { ok: false, url, reason: "private_address", detail: bare }
      : { ok: true, url, host, addresses: [bare] };
  }
  let addresses: string[];
  try {
    addresses = await opts.resolver(host);
  } catch (err) {
    return { ok: false, url, reason: "dns", detail: err instanceof Error ? err.message : String(err) };
  }
  if (addresses.length === 0) return { ok: false, url, reason: "dns" };
  const bad = addresses.find(isBlockedAddress);
  if (bad !== undefined) return { ok: false, url, reason: "private_address", detail: bad };
  return { ok: true, url, host, addresses };
}

export class SsrfBlockedError extends Error {
  readonly reason: GuardReason;
  constructor(reason: GuardReason, target: string) {
    super(`blocked by the SSRF guard (${reason}): ${target}`);
    this.name = "SsrfBlockedError";
    this.reason = reason;
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `lookup` for undici's `connect` option: resolves with `resolver`, refuses
 * the connection when any address is private, and hands back only vetted
 * addresses, so the socket connects to exactly what was checked.
 */
export function guardedLookup(
  resolver: Resolver,
): (hostname: string, options: { all?: boolean; family?: number | string }, cb: LookupCallback) => void {
  return (hostname, options, cb) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    const resolved = isIP(host) !== 0 ? Promise.resolve([host]) : resolver(host);
    resolved.then(
      (addresses) => {
        if (addresses.length === 0) {
          cb(Object.assign(new Error(`no address for ${host}`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        const bad = addresses.find(isBlockedAddress);
        if (bad !== undefined) {
          cb(new SsrfBlockedError("private_address", `${host} -> ${bad}`), "", 0);
          return;
        }
        const rows = addresses.map((a) => ({ address: a, family: isIP(a) }));
        if (options.all) cb(null, rows);
        else cb(null, rows[0]?.address ?? "", rows[0]?.family ?? 4);
      },
      (err: unknown) =>
        cb(
          Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
            code: "ENOTFOUND",
          }),
          "",
          0,
        ),
    );
  };
}
