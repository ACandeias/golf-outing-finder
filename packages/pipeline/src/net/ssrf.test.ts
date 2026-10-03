import { describe, expect, it } from "vitest";
import { emptyOverrides } from "../overrides/load.ts";
import { checkUrl, guardedLookup, isBlockedAddress, staticResolver, type Resolver } from "./ssrf.ts";

describe("isBlockedAddress", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1", // CGNAT
    "100.127.255.254",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.170",
    "192.0.2.5",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1", // multicast
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1", // v4-mapped
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe", // NAT64 to metadata
    "2002:a9fe:a9fe::1", // 6to4 to metadata
    "fc00::1",
    "fd00:ec2::254", // AWS metadata v6
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1", // multicast
    "2001:db8::1",
    "100::1",
    "not-an-ip",
  ];
  const allowed = [
    "8.8.8.8",
    "93.184.216.34",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "2002:808:808::1",
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  for (const ip of allowed) it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
});

const PUBLIC: Resolver = staticResolver({
  "example.org": ["93.184.216.34"],
  "dual.example.org": ["93.184.216.34", "10.0.0.5"],
  "rebind.example.org": ["127.0.0.1"],
  "v6.example.org": ["2606:4700::6810:84e5"],
});

describe("checkUrl", () => {
  const overrides = emptyOverrides({
    exclusions: { domains: ["blocked.example"], url_patterns: ["https://example.org/private/*"] },
  });
  const opts = { resolver: PUBLIC, exclusions: overrides.exclusions };

  it("allows a public http(s) URL on 80 or 443 and returns the addresses", async () => {
    const r = await checkUrl("https://example.org/golf", opts);
    expect(r).toEqual({
      ok: true,
      url: "https://example.org/golf",
      host: "example.org",
      addresses: ["93.184.216.34"],
    });
    expect((await checkUrl("http://example.org:80/", opts)).ok).toBe(true);
    expect((await checkUrl("http://example.org:443/", opts)).ok).toBe(true);
  });

  it("rejects other schemes and ports", async () => {
    expect(await checkUrl("ftp://example.org/", opts)).toMatchObject({ ok: false, reason: "scheme" });
    expect(await checkUrl("file:///etc/passwd", opts)).toMatchObject({ ok: false, reason: "scheme" });
    expect(await checkUrl("https://example.org:8443/", opts)).toMatchObject({
      ok: false,
      reason: "port",
    });
    expect(await checkUrl("http://example.org:22/", opts)).toMatchObject({ ok: false, reason: "port" });
  });

  it("rejects credentials in the URL", async () => {
    expect(await checkUrl("https://u:p@example.org/", opts)).toMatchObject({
      ok: false,
      reason: "credentials",
    });
  });

  it("rejects private IP literals without resolving", async () => {
    let called = false;
    const spy: Resolver = async () => {
      called = true;
      return [];
    };
    const o = { ...opts, resolver: spy };
    expect(await checkUrl("http://127.0.0.1/", o)).toMatchObject({ ok: false, reason: "private_address" });
    expect(await checkUrl("http://[::1]/", o)).toMatchObject({ ok: false, reason: "private_address" });
    expect(await checkUrl("http://169.254.169.254/latest/meta-data", o)).toMatchObject({
      ok: false,
      reason: "private_address",
    });
    expect(await checkUrl("http://[::ffff:169.254.169.254]/", o)).toMatchObject({
      ok: false,
      reason: "private_address",
    });
    expect(called).toBe(false);
  });

  it("rejects a host when any resolved address is private", async () => {
    expect(await checkUrl("https://dual.example.org/", opts)).toMatchObject({
      ok: false,
      reason: "private_address",
    });
    expect(await checkUrl("https://rebind.example.org/", opts)).toMatchObject({
      ok: false,
      reason: "private_address",
    });
  });

  it("rejects metadata host names and hosts that do not resolve", async () => {
    expect(await checkUrl("http://metadata.google.internal/", opts)).toMatchObject({
      ok: false,
      reason: "metadata_host",
    });
    expect(await checkUrl("https://nxdomain.example.org/", opts)).toMatchObject({
      ok: false,
      reason: "dns",
    });
  });

  it("applies exclusions.yaml", async () => {
    expect(await checkUrl("https://www.blocked.example/x", opts)).toMatchObject({
      ok: false,
      reason: "excluded",
    });
    expect(await checkUrl("https://example.org/private/a", opts)).toMatchObject({
      ok: false,
      reason: "excluded",
    });
  });

  it("allows public IPv6 hosts", async () => {
    expect((await checkUrl("https://v6.example.org/", opts)).ok).toBe(true);
  });
});

describe("guardedLookup (connect-time check against DNS rebinding)", () => {
  it("returns a vetted public address", async () => {
    const lookup = guardedLookup(PUBLIC);
    const res = await new Promise<{ err: unknown; address: unknown; family: unknown }>((resolve) =>
      lookup("example.org", {}, (err, address, family) => resolve({ err, address, family })),
    );
    expect(res).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("fails the connect when the host resolves private", async () => {
    const lookup = guardedLookup(PUBLIC);
    const err = await new Promise<unknown>((resolve) =>
      lookup("rebind.example.org", {}, (e) => resolve(e)),
    );
    expect(String(err)).toMatch(/private/);
  });

  it("answers the all:true form", async () => {
    const lookup = guardedLookup(PUBLIC);
    const res = await new Promise<unknown>((resolve) =>
      lookup("v6.example.org", { all: true }, (_e, addresses) => resolve(addresses)),
    );
    expect(res).toEqual([{ address: "2606:4700::6810:84e5", family: 6 }]);
  });
});
