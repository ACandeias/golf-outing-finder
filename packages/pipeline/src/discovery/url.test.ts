import { describe, expect, it } from "vitest";
import { hostOf, normalizeUrl, registrableDomain, sameSite } from "./url.ts";

describe("normalizeUrl", () => {
  it("lowercases the host, drops the fragment and the default port", () => {
    expect(normalizeUrl("HTTPS://Www.Example.COM:443/Events/Golf#register")).toBe(
      "https://www.example.com/Events/Golf",
    );
    expect(normalizeUrl("http://EXAMPLE.org:80")).toBe("http://example.org/");
  });

  it("strips tracking parameters and keeps the rest in order", () => {
    expect(
      normalizeUrl(
        "https://example.org/e?id=7&utm_source=fb&UTM_Medium=x&fbclid=abc&gclid=1&mc_cid=2&mc_eid=3&b=2",
      ),
    ).toBe("https://example.org/e?id=7&b=2");
    expect(normalizeUrl("https://example.org/e?utm_campaign=x")).toBe("https://example.org/e");
    expect(normalizeUrl("https://example.org/e?msclkid=1&_hsenc=2&_hsmi=3&igshid=4")).toBe(
      "https://example.org/e",
    );
  });

  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("../golf/classic?utm_source=x#top", "https://Example.org/events/list/")).toBe(
      "https://example.org/events/golf/classic",
    );
    expect(normalizeUrl("//cdn.example.org/a", "https://example.org/")).toBe(
      "https://cdn.example.org/a",
    );
  });

  it("rejects non-http schemes, credentials, bare hosts and junk", () => {
    expect(normalizeUrl("mailto:golf@example.org")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.org/x")).toBeNull();
    expect(normalizeUrl("https://user:pw@example.org/")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("https://localhost/x")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("x".repeat(3000))).toBeNull();
  });

  it("keeps IP literals so the SSRF guard can reject them with a reason", () => {
    expect(normalizeUrl("http://127.0.0.1/")).toBe("http://127.0.0.1/");
    expect(normalizeUrl("http://[::1]/")).toBe("http://[::1]/");
  });

  it("strips a trailing dot from the host", () => {
    expect(normalizeUrl("https://example.org./a")).toBe("https://example.org/a");
  });
});

describe("registrableDomain", () => {
  it("takes the last two labels for ordinary suffixes", () => {
    expect(registrableDomain("support.kidney.org")).toBe("kidney.org");
    expect(registrableDomain("WWW.Example.COM.")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("knows multi-label public suffixes from the committed subset", () => {
    expect(registrableDomain("www.golf.co.uk")).toBe("golf.co.uk");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("www.ci.glendale.ca.us")).toBe("glendale.ca.us");
    expect(registrableDomain("school.k12.ny.us")).toBe("school.k12.ny.us");
  });

  it("treats hosting platforms as suffixes, so each site is its own domain", () => {
    expect(registrableDomain("grady-dads.wixsite.com")).toBe("grady-dads.wixsite.com");
    expect(registrableDomain("club.github.io")).toBe("club.github.io");
    expect(registrableDomain("x.y.blogspot.com")).toBe("y.blogspot.com");
  });

  it("returns IP literals and single labels unchanged", () => {
    expect(registrableDomain("10.0.0.1")).toBe("10.0.0.1");
    expect(registrableDomain("[::1]")).toBe("[::1]");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

describe("hostOf and sameSite", () => {
  it("reads the lowercase host", () => {
    expect(hostOf("https://Support.Kidney.org/x")).toBe("support.kidney.org");
    expect(hostOf("nope")).toBeNull();
  });
  it("compares registrable domains", () => {
    expect(sameSite("https://a.kidney.org/x", "https://support.kidney.org/y")).toBe(true);
    expect(sameSite("https://scramblehunter.com/e", "https://www.golfstatus.com/r")).toBe(false);
  });
});
