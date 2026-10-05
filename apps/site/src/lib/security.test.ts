import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSiteEnv } from "@gof/shared/env";
import { adsConfig } from "./ads.ts";
import { CSP_POLICY, cspPolicy, SECURITY_HEADERS, securityHeaders } from "./security.ts";

/** Headers public/_headers sets on every static asset (the `/*` block). */
function staticHeaders(): Record<string, string> {
  const text = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  let inAll = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inAll = line.trim() === "/*";
      continue;
    }
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (inAll && m?.[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

describe("security headers", () => {
  it("public/_headers repeats the Worker's base headers exactly (static assets and prerendered pages)", () => {
    expect(staticHeaders()).toEqual(SECURITY_HEADERS);
  });

  it("stays report-only", () => {
    expect(Object.keys(SECURITY_HEADERS)).toContain("Content-Security-Policy-Report-Only");
    expect(Object.keys(SECURITY_HEADERS)).not.toContain("Content-Security-Policy");
    const ads = adsConfig(parseSiteEnv({ PUBLIC_SITE_URL: "https://x.example", PUBLIC_ADSENSE_CLIENT: "ca-pub-0000000000000000" }));
    expect(Object.keys(securityHeaders(ads.cspOrigins))).not.toContain("Content-Security-Policy");
  });

  it("adds the ad and analytics origins only when they're configured", () => {
    const off = adsConfig(parseSiteEnv({ PUBLIC_SITE_URL: "https://x.example" }));
    expect(cspPolicy(off.cspOrigins)).toBe(CSP_POLICY);
    const on = adsConfig(
      parseSiteEnv({ PUBLIC_SITE_URL: "https://x.example", PUBLIC_ADSENSE_CLIENT: "ca-pub-0000000000000000", PUBLIC_GA4_ID: "G-TEST12345" }),
    );
    const policy = cspPolicy(on.cspOrigins);
    expect(policy).toMatch(/script-src 'self' https:\/\/pagead2\.googlesyndication\.com .*https:\/\/www\.googletagmanager\.com/);
    // frame-src 'none' is replaced, not appended to.
    expect(policy).toMatch(/frame-src https:\/\/googleads\.g\.doubleclick\.net/);
    expect(policy).not.toMatch(/frame-src 'none'/);
    expect(policy).toContain("connect-src 'self' https://tiles.openfreemap.org https://pagead2.googlesyndication.com");
    expect(policy).not.toMatch(/'unsafe-eval'/);
    expect(policy).toContain("object-src 'none'");
  });
});
