/**
 * The suite's `test`: every browser request to a host other than the site under
 * test is aborted, so runs are offline and deterministic (CLAUDE.md: tests never
 * touch the network; map tiles, ad and analytics scripts never load). Blocked
 * URLs are attached to the test as an annotation for debugging.
 */
import { test as base, expect, type Page } from "@playwright/test";

export const test = base.extend<{ blockExternalRequests: void }>({
  blockExternalRequests: [
    async ({ context, baseURL }, use, testInfo) => {
      const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
      const blocked = new Set<string>();
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("blob:") || new URL(url).origin === origin) {
          return route.continue();
        }
        blocked.add(new URL(url).origin);
        return route.abort("blockedbyclient");
      });
      await use();
      if (blocked.size > 0) {
        testInfo.annotations.push({
          type: "blocked-offline",
          description: [...blocked].sort().join(" "),
        });
      }
    },
    { auto: true },
  ],
});

export { expect };

export function siteOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("E2E_BASE_URL is not set; global-setup did not run");
  return new URL(baseURL).origin;
}

export interface CardInfo {
  /** Rendered text of the smallest element around the outing link that also holds a Register link. */
  text: string;
  /** href attributes of links in the card whose text says "Register". */
  registerHrefs: string[];
}

/**
 * Finds the listing card for an outing without depending on the site's markup:
 * start at the first link to `/outings/{slug}` and walk up to the nearest
 * ancestor that also contains a "Register" or "See site" link (SPEC.md 9.3).
 */
export async function cardFor(page: Page, slug: string): Promise<CardInfo | null> {
  return page.evaluate((path) => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(
      (a) => new URL(a.href, location.href).pathname === path,
    );
    const start = links[0];
    if (!start) return null;
    const isCta = (a: HTMLAnchorElement) => /\b(register|see site)\b/i.test(a.textContent ?? "");
    let el: HTMLElement | null = start.parentElement;
    while (el && el !== document.body) {
      const ctas = [...el.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(isCta);
      if (ctas.length > 0) {
        return {
          text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
          registerHrefs: ctas
            .filter((a) => /\bregister\b/i.test(a.textContent ?? ""))
            .map((a) => a.getAttribute("href") ?? ""),
        };
      }
      el = el.parentElement;
    }
    return {
      text: (start.parentElement?.innerText ?? "").replace(/\s+/g, " ").trim(),
      registerHrefs: [],
    };
  }, `/outings/${slug}`);
}

/** Pathnames of every same-origin link to an outing page. */
export async function outingLinkSlugs(page: Page): Promise<string[]> {
  const paths = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map((a) => new URL(a.href, location.href))
      .filter((u) => u.origin === location.origin && u.pathname.startsWith("/outings/"))
      .map((u) => u.pathname.slice("/outings/".length)),
  );
  return [...new Set(paths)];
}

/** Same-origin link pathnames on the page. */
export async function linkPaths(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((a) => new URL(a.href, location.href))
        .filter((u) => u.origin === location.origin)
        .map((u) => u.pathname),
    ),
  ]);
}

/** Text of the nearest list row or table row around the first link to `path`. */
export async function rowTextForLink(page: Page, path: string): Promise<string | null> {
  return page.evaluate((p) => {
    const a = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find(
      (x) => new URL(x.href, location.href).pathname === p,
    );
    if (!a) return null;
    const row = a.closest<HTMLElement>("li, tr, dd, dt") ?? a.parentElement;
    // innerText separates table cells, where textContent would run "Arizona" "3" "0" together.
    return (row?.innerText ?? row?.textContent ?? "").replace(/\s+/g, " ").trim();
  }, path);
}

/** Two URLs are the same resource (normalizes percent-encoding and default ports). */
export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
