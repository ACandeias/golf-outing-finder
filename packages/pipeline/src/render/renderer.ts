import { checkUrl, isBlockedAddress, type GuardOptions } from "../net/ssrf.ts";

/**
 * Headless render with Playwright Chromium behind the SSRF guard (SPEC.md 8.3
 * and 10). Only URLs the guard has vetted are opened; inside the page every
 * request whose host is not the document's host, that is not http(s), or that
 * resolves to a private range is aborted, and images, fonts and media are
 * blocked. A fresh browser context per page, no service workers, no downloads,
 * no stored state, and a 25-second budget per page.
 *
 * Residual risk, accepted: Chromium resolves the document host itself, so a
 * DNS answer that changes between our check and Chromium's lookup is not
 * caught here. The plain fetcher pins its connection to the vetted addresses.
 */

export const RENDER_TIMEOUT_MS = 25_000;
const BLOCKED_TYPES = new Set(["image", "font", "media"]);

export interface RenderResult {
  status: number;
  /** After in-page redirects (always the document's host). */
  finalUrl: string;
  html: string;
}

export interface Renderer {
  render(url: string): Promise<RenderResult>;
  close(): Promise<void>;
}

export class RenderBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderBlockedError";
  }
}

// The slice of Playwright's API the renderer uses, so tests can mock it.
export interface RouteLike {
  request(): { url(): string; resourceType(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface PageLike {
  goto(
    url: string,
    opts: { timeout: number; waitUntil: "domcontentloaded" },
  ): Promise<{ status(): number } | null>;
  waitForLoadState(state: "networkidle", opts: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
}
export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface ContextOptions {
  userAgent: string;
  javaScriptEnabled: boolean;
  serviceWorkers: "block";
  acceptDownloads: boolean;
  bypassCSP: boolean;
}
export interface BrowserLike {
  newContext(opts: ContextOptions): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface RendererOptions {
  launch: () => Promise<BrowserLike>;
  guard: GuardOptions;
  userAgent: string;
  timeoutMs?: number;
  nowMs?: () => number;
}

/** Launches Playwright Chromium lazily (the import stays out of tests and dry runs). */
export async function launchChromium(): Promise<BrowserLike> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  return browser as unknown as BrowserLike;
}

export type SubrequestVerdict = "continue" | "type" | "scheme" | "host" | "private";

/** Decides one in-page request: "continue", or why it is aborted. */
export async function decideSubrequest(
  requestUrl: string,
  resourceType: string,
  documentHost: string,
  resolveOk: (host: string) => Promise<boolean>,
): Promise<SubrequestVerdict> {
  if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
    return BLOCKED_TYPES.has(resourceType) ? "type" : "continue";
  }
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return "scheme";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "scheme";
  if (u.port !== "" && u.port !== "80" && u.port !== "443") return "host";
  if (BLOCKED_TYPES.has(resourceType)) return "type";
  if (u.hostname.toLowerCase() !== documentHost) return "host";
  if (!(await resolveOk(u.hostname.toLowerCase()))) return "private";
  return "continue";
}

export function createRenderer(o: RendererOptions): Renderer {
  const timeoutMs = o.timeoutMs ?? RENDER_TIMEOUT_MS;
  const nowMs = o.nowMs ?? (() => performance.now());
  let browser: Promise<BrowserLike> | null = null;

  return {
    async render(url: string): Promise<RenderResult> {
      const vetted = await checkUrl(url, o.guard);
      if (!vetted.ok) throw new RenderBlockedError(`render refused (${vetted.reason}): ${url}`);
      const docHost = vetted.host;
      // The document host was vetted just now; every other host is aborted by name.
      const resolved = new Map<string, Promise<boolean>>([[docHost, Promise.resolve(true)]]);
      const resolveOk = (host: string): Promise<boolean> => {
        let p = resolved.get(host);
        if (!p) {
          p = o.guard
            .resolver(host)
            .then((addrs) => addrs.length > 0 && !addrs.some(isBlockedAddress))
            .catch(() => false);
          resolved.set(host, p);
        }
        return p;
      };
      browser ??= o.launch();
      const b = await browser;
      const context = await b.newContext({
        userAgent: o.userAgent,
        javaScriptEnabled: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        bypassCSP: false,
      });
      const start = nowMs();
      try {
        await context.route("**/*", async (route) => {
          const req = route.request();
          const verdict = await decideSubrequest(req.url(), req.resourceType(), docHost, resolveOk);
          if (verdict === "continue") await route.continue();
          else await route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        const resp = await page.goto(vetted.url, {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        });
        const left = timeoutMs - (nowMs() - start);
        if (left > 0) {
          try {
            await page.waitForLoadState("networkidle", { timeout: Math.min(10_000, left) });
          } catch {
            // Long-polling pages never go idle; take what is there.
          }
        }
        const finalUrl = page.url();
        let finalHost: string | null;
        try {
          finalHost = new URL(finalUrl).hostname.toLowerCase();
        } catch {
          finalHost = null;
        }
        if (finalHost !== docHost) {
          throw new RenderBlockedError(`render left the document host: ${finalUrl}`);
        }
        return { status: resp?.status() ?? 0, finalUrl, html: await page.content() };
      } finally {
        await context.close();
      }
    },
    async close(): Promise<void> {
      if (browser) {
        const b = await browser;
        browser = null;
        await b.close();
      }
    },
  };
}
