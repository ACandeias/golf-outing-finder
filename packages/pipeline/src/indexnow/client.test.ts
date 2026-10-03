import { describe, expect, it } from "vitest";
import { indexNowClient, type FetchLike } from "./client.ts";

describe("IndexNow client", () => {
  it("resolves paths against the site, drops other hosts, and posts one body", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 202 };
    };
    const client = indexNowClient({ siteUrl: "https://golfoutingfinder.com", key: "abcdef0123456789" }, fetchFn);
    await client.ping([
      "/outings/2026/nkf-golf-classic-winged-foot",
      "/outings/2026/nkf-golf-classic-winged-foot",
      "https://evil.example/x",
    ]);
    expect(calls).toEqual([
      {
        url: "https://api.indexnow.org/indexnow",
        body: {
          host: "golfoutingfinder.com",
          key: "abcdef0123456789",
          keyLocation: "https://golfoutingfinder.com/abcdef0123456789.txt",
          urlList: ["https://golfoutingfinder.com/outings/2026/nkf-golf-classic-winged-foot"],
        },
      },
    ]);
  });

  it("does nothing for an empty list and throws on an error status", async () => {
    let n = 0;
    const client = indexNowClient({ siteUrl: "https://g.example", key: "abcdef0123456789" }, async () => {
      n++;
      return { ok: false, status: 422 };
    });
    await client.ping([]);
    expect(n).toBe(0);
    await expect(client.ping(["/outings/x"])).rejects.toThrow("HTTP 422");
  });

  it("refuses a malformed key", () => {
    expect(() => indexNowClient({ siteUrl: "https://g.example", key: "short" }, async () => ({ ok: true, status: 200 }))).toThrow();
  });
});
