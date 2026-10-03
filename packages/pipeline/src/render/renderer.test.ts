import { lookup } from "node:dns/promises";
import { describe, expect, it } from "vitest";
import { staticResolver } from "../net/ssrf.ts";
import { emptyOverrides } from "../overrides/load.ts";
import {
  createRenderer,
  decideSubrequest,
  launchChromium,
  RenderBlockedError,
  type BrowserLike,
  type ContextLike,
  type ContextOptions,
  type RouteLike,
} from "./renderer.ts";

const resolver = staticResolver({
  "support.kidney.org": ["104.18.1.1"],
  "evil.example": ["10.0.0.1"],
});
const guard = { resolver, exclusions: emptyOverrides().exclusions };

interface Sub {
  url: string;
  type: string;
}

/** A fake browser: `goto` replays the document and `subrequests` through the route handler. */
function fakeBrowser(opts: { subrequests?: Sub[]; finalUrl?: string; html?: string }) {
  const log = {
    contexts: [] as ContextOptions[],
    closed: 0,
    continued: [] as string[],
    aborted: [] as string[],
  };
  const browser: BrowserLike = {
    async newContext(o) {
      log.contexts.push(o);
      let handler: ((r: RouteLike) => Promise<void>) | null = null;
      const ctx: ContextLike = {
        async route(_p, h) {
          handler = h;
        },
        async newPage() {
          let current = "";
          return {
            async goto(url) {
              current = opts.finalUrl ?? url;
              for (const s of [{ url, type: "document" }, ...(opts.subrequests ?? [])]) {
                const route: RouteLike = {
                  request: () => ({ url: () => s.url, resourceType: () => s.type }),
                  abort: async () => {
                    log.aborted.push(s.url);
                  },
                  continue: async () => {
                    log.continued.push(s.url);
                  },
                };
                await handler?.(route);
              }
              return { status: () => 200 };
            },
            async waitForLoadState() {},
            async content() {
              return opts.html ?? "<html><body>rendered</body></html>";
            },
            url: () => current,
          };
        },
        async close() {
          log.closed++;
        },
      };
      return ctx;
    },
    async close() {},
  };
  return { browser, log };
}

describe("decideSubrequest", () => {
  const ok = async () => true;
  it("allows same-host documents, scripts and XHR", async () => {
    expect(await decideSubrequest("https://a.org/x.js", "script", "a.org", ok)).toBe("continue");
  });
  it("blocks images, fonts and media even on the same host", async () => {
    for (const t of ["image", "font", "media"]) {
      expect(await decideSubrequest("https://a.org/x", t, "a.org", ok)).toBe("type");
    }
  });
  it("blocks other hosts, schemes, ports and private resolutions", async () => {
    expect(await decideSubrequest("https://cdn.a.org/x.js", "script", "a.org", ok)).toBe("host");
    expect(await decideSubrequest("file:///etc/passwd", "document", "a.org", ok)).toBe("scheme");
    expect(await decideSubrequest("https://a.org:8443/x", "xhr", "a.org", ok)).toBe("host");
    expect(await decideSubrequest("https://a.org/x", "xhr", "a.org", async () => false)).toBe(
      "private",
    );
  });
  it("lets inline data: scripts through but not data: images", async () => {
    expect(await decideSubrequest("data:text/javascript,1", "script", "a.org", ok)).toBe(
      "continue",
    );
    expect(await decideSubrequest("data:image/png;base64,AA", "image", "a.org", ok)).toBe("type");
  });
});

describe("createRenderer", () => {
  it("refuses a URL the guard rejects, without launching a browser", async () => {
    let launched = false;
    const r = createRenderer({
      launch: async () => {
        launched = true;
        return fakeBrowser({}).browser;
      },
      guard,
      userAgent: "UA/1",
    });
    await expect(r.render("https://evil.example/")).rejects.toBeInstanceOf(RenderBlockedError);
    await expect(r.render("http://169.254.169.254/")).rejects.toBeInstanceOf(RenderBlockedError);
    await expect(r.render("https://support.kidney.org:8080/")).rejects.toBeInstanceOf(
      RenderBlockedError,
    );
    expect(launched).toBe(false);
  });

  it("uses a fresh context per page with our UA and aborts off-host and heavy requests", async () => {
    const { browser, log } = fakeBrowser({
      subrequests: [
        { url: "https://support.kidney.org/app.js", type: "script" },
        { url: "https://support.kidney.org/logo.png", type: "image" },
        { url: "https://www.google-analytics.com/collect", type: "xhr" },
        { url: "https://evil.example/x", type: "xhr" },
        { url: "https://support.kidney.org/font.woff2", type: "font" },
      ],
    });
    const r = createRenderer({ launch: async () => browser, guard, userAgent: "UA/1" });
    const url = "https://support.kidney.org/event/2026-nkf-golf-classic/e1";
    const out = await r.render(url);
    await r.render(url);
    expect(out).toEqual({ status: 200, finalUrl: url, html: "<html><body>rendered</body></html>" });
    expect(log.contexts).toHaveLength(2);
    expect(log.closed).toBe(2);
    expect(log.contexts[0]).toMatchObject({
      userAgent: "UA/1",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    expect(log.continued.slice(0, 2)).toEqual([url, "https://support.kidney.org/app.js"]);
    expect(log.aborted.slice(0, 4)).toEqual([
      "https://support.kidney.org/logo.png",
      "https://www.google-analytics.com/collect",
      "https://evil.example/x",
      "https://support.kidney.org/font.woff2",
    ]);
  });

  it("fails when the page ends up on another host", async () => {
    const { browser, log } = fakeBrowser({ finalUrl: "https://evil.example/landing" });
    const r = createRenderer({ launch: async () => browser, guard, userAgent: "UA/1" });
    await expect(r.render("https://support.kidney.org/a")).rejects.toThrow(
      /left the document host/,
    );
    expect(log.closed).toBe(1);
  });
});

describe.skipIf(process.env.RUN_BROWSER !== "1")("Chromium smoke test (RUN_BROWSER=1)", () => {
  it("renders example.com through the guard", { timeout: 60_000 }, async () => {
    const r = createRenderer({
      launch: launchChromium,
      guard: {
        resolver: async (h) => (await lookup(h, { all: true })).map((x) => x.address),
        exclusions: emptyOverrides().exclusions,
      },
      userAgent: "GolfOutingFinderBot/1.0 (+http://localhost:8787/bot)",
    });
    try {
      const out = await r.render("https://example.com/");
      expect(out.status).toBe(200);
      expect(out.html).toMatch(/Example Domain/);
    } finally {
      await r.close();
    }
  });
});
