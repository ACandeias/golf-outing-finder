import { describe, expect, it } from "vitest";
import { BudgetGuard } from "../budget.ts";
import { staticResolver } from "../net/ssrf.ts";
import type { Renderer } from "../render/renderer.ts";
import type { FetchPlanItem } from "../stages/types.ts";
import {
  createPageFetcher,
  fetchAll,
  memoryValidatorStore,
  userAgentFor,
  type PageFetcherDeps,
} from "./fetcher.ts";
import { HostGate } from "./gate.ts";
import { decodeBody, httpGet, type FetchFn, type FetchInit } from "./http.ts";
import { pdfText } from "./pdf.ts";

const UA = userAgentFor("http://localhost:8787/");

const resolver = staticResolver({
  "example.org": ["93.184.216.34"],
  "www.example.org": ["93.184.216.34"],
  "other.example": ["93.184.216.35"],
  "a.example": ["93.184.216.36"],
  "b.example": ["93.184.216.37"],
  "internal.example": ["10.0.0.7"],
});
const guard = {
  resolver,
  exclusions: { domains: ["excluded.example"], url_patterns: [] },
};

type Handler = (init: FetchInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: string; init: FetchInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const h = routes[url];
    if (!h) return new Response("not here", { status: 404 });
    return h(init);
  };
  return { fn, calls };
}

const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

function item(url: string, patch: Partial<FetchPlanItem> = {}): FetchPlanItem {
  return {
    url,
    found_via: "submission",
    kind: "submission",
    priority: 2,
    bypass_dedupe: false,
    recheck_outing_id: null,
    directory_host: null,
    render: false,
    host: new URL(url).hostname,
    ...patch,
  };
}

function deps(fetchFn: FetchFn, patch: Partial<PageFetcherDeps> = {}): PageFetcherDeps {
  let t = 0;
  return {
    fetchFn,
    guard,
    userAgent: UA,
    clock: { nowMs: () => t },
    nowIso: () => "2026-09-28T12:00:00.000Z",
    pdfText,
    sleep: async (ms) => {
      t += ms;
    },
    ...patch,
  };
}

const guardFor = (env: Record<string, string> = {}) =>
  new BudgetGuard({ profile: "nightly", env, now: new Date("2026-09-28T12:00:00Z"), clock: { nowMs: () => 0 } });

describe("userAgentFor", () => {
  it("builds the SPEC user agent", () => {
    expect(UA).toBe("GolfOutingFinderBot/1.0 (+http://localhost:8787/bot)");
  });
});

describe("httpGet", () => {
  const vetAll = async () => null;

  it("sends our user agent, no cookie, manual redirects", async () => {
    const { fn, calls } = fakeFetch({ "https://example.org/": () => html("<p>hi</p>") });
    const r = await httpGet("https://example.org/", { fetchFn: fn, vet: vetAll, userAgent: UA });
    expect(r.kind).toBe("response");
    expect(calls[0]?.init.headers["user-agent"]).toBe(UA);
    expect(calls[0]?.init.headers.cookie).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("follows at most 5 redirects, vetting every hop", async () => {
    const routes: Record<string, Handler> = {};
    for (let i = 0; i < 7; i++) {
      routes[`https://example.org/r${i}`] = () =>
        new Response(null, { status: 302, headers: { location: `/r${i + 1}` } });
    }
    routes["https://example.org/r5"] = () => html("done");
    const vetted: string[] = [];
    const { fn } = fakeFetch(routes);
    const ok = await httpGet("https://example.org/r0", {
      fetchFn: fn,
      userAgent: UA,
      vet: async (u) => {
        vetted.push(u);
        return null;
      },
    });
    expect(ok).toMatchObject({ kind: "response", url: "https://example.org/r5" });
    expect(vetted).toHaveLength(6);
    const tooMany = await httpGet("https://example.org/r0", {
      fetchFn: fakeFetch({ ...routes, "https://example.org/r5": routes["https://example.org/r4"]! }).fn,
      userAgent: UA,
      vet: vetAll,
    });
    expect(tooMany).toMatchObject({ kind: "redirect_error" });
  });

  it("stops a redirect into a private address", async () => {
    const { fn, calls } = fakeFetch({
      "https://example.org/go": () =>
        new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest" } }),
    });
    const r = await httpGet("https://example.org/go", {
      fetchFn: fn,
      userAgent: UA,
      vet: async (u) => {
        const { checkUrl } = await import("../net/ssrf.ts");
        const g = await checkUrl(u, guard);
        return g.ok ? null : { kind: "ssrf", reason: g.reason };
      },
    });
    expect(r).toMatchObject({ kind: "ssrf_blocked", reason: "private_address" });
    expect(calls).toHaveLength(1);
  });

  it("caps the body at 5 MB, by header and while streaming", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const declared = fakeFetch({
      "https://example.org/big": () =>
        new Response(big, { status: 200, headers: { "content-length": String(big.byteLength) } }),
    });
    expect(
      await httpGet("https://example.org/big", { fetchFn: declared.fn, vet: vetAll, userAgent: UA }),
    ).toMatchObject({ kind: "too_large" });
    const streamed = fakeFetch({
      "https://example.org/big": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024));
              c.close();
            },
          }),
          { status: 200 },
        ),
    });
    expect(
      await httpGet("https://example.org/big", { fetchFn: streamed.fn, vet: vetAll, userAgent: UA }),
    ).toMatchObject({ kind: "too_large" });
  });

  it("times out", async () => {
    const fn: FetchFn = (_u, init) =>
      new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(
      await httpGet("https://example.org/slow", { fetchFn: fn, vet: vetAll, userAgent: UA, timeoutMs: 10 }),
    ).toMatchObject({ kind: "timeout" });
  });

  it("reports network errors", async () => {
    const fn: FetchFn = async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    };
    expect(await httpGet("https://example.org/", { fetchFn: fn, vet: vetAll, userAgent: UA })).toMatchObject({
      kind: "network_error",
      message: "fetch failed: ECONNREFUSED",
    });
  });

  it("sends conditional headers on the first hop", async () => {
    const { fn, calls } = fakeFetch({ "https://example.org/": () => new Response(null, { status: 304 }) });
    const r = await httpGet("https://example.org/", {
      fetchFn: fn,
      vet: vetAll,
      userAgent: UA,
      validators: { etag: '"abc"', lastModified: "Mon, 21 Sep 2026 10:00:00 GMT" },
    });
    expect(r).toMatchObject({ kind: "response", status: 304 });
    expect(calls[0]?.init.headers["if-none-match"]).toBe('"abc"');
    expect(calls[0]?.init.headers["if-modified-since"]).toBe("Mon, 21 Sep 2026 10:00:00 GMT");
  });
});

describe("decodeBody", () => {
  it("honors the charset from the header or a meta tag", () => {
    const latin1 = new Uint8Array([0x43, 0x61, 0x66, 0xe9]);
    expect(decodeBody(latin1, "text/html; charset=iso-8859-1")).toBe("Café");
    const meta = new TextEncoder().encode('<meta charset="windows-1252">');
    const body = new Uint8Array([...meta, 0x93, 0x94]);
    expect(decodeBody(body, "text/html")).toContain("“”");
    expect(decodeBody(new TextEncoder().encode("é"), null)).toBe("é");
  });
});

describe("HostGate", () => {
  it("spaces requests to one host by at least the floor and runs them one at a time", async () => {
    let t = 0;
    const starts: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const gate = new HostGate({
      clock: { nowMs: () => t },
      sleep: async (ms) => {
        t += ms;
      },
    });
    const job = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      starts.push(t);
      t += 100;
      await Promise.resolve();
      running--;
    };
    await Promise.all([gate.run("a.example", 0, job), gate.run("A.example", 0, job), gate.run("a.example", 12_000, job)]);
    expect(maxRunning).toBe(1);
    expect(starts).toEqual([0, 5000, 17_000]);
  });
});

describe("createPageFetcher", () => {
  it("fetches an HTML page after robots.txt and records validators", async () => {
    const { fn, calls } = fakeFetch({
      "https://example.org/robots.txt": () => new Response("User-agent: *\nDisallow: /private\n"),
      "https://example.org/golf": () => html("<h1>Golf Classic</h1>", { etag: '"v1"' }),
    });
    const validators = memoryValidatorStore();
    const f = createPageFetcher(deps(fn, { validators }));
    const budget = guardFor();
    const p = await f.fetchPage(item("https://example.org/golf"), budget);
    expect(p).toMatchObject({
      requested_url: "https://example.org/golf",
      url: "https://example.org/golf",
      outcome: "ok",
      http_status: 200,
      html: "<h1>Golf Classic</h1>",
      rendered: false,
      fetched_at: "2026-09-28T12:00:00.000Z",
    });
    expect(calls.map((c) => c.url)).toEqual(["https://example.org/robots.txt", "https://example.org/golf"]);
    expect(validators.get("https://example.org/golf")).toEqual({ etag: '"v1"', lastModified: null });
    expect(budget.spent("MAX_FETCHES_PER_RUN")).toBe(1);
  });

  it("returns robots_blocked and ssrf_blocked without fetching the page", async () => {
    const { fn, calls } = fakeFetch({
      "https://example.org/robots.txt": () => new Response("User-agent: GolfOutingFinderBot\nDisallow: /private\n"),
    });
    const f = createPageFetcher(deps(fn));
    const budget = guardFor();
    expect((await f.fetchPage(item("https://example.org/private/x"), budget)).outcome).toBe("robots_blocked");
    expect((await f.fetchPage(item("https://internal.example/"), budget)).outcome).toBe("ssrf_blocked");
    expect((await f.fetchPage(item("http://127.0.0.1/"), budget)).outcome).toBe("ssrf_blocked");
    expect((await f.fetchPage(item("https://excluded.example/"), budget)).outcome).toBe("ssrf_blocked");
    expect(calls.map((c) => c.url)).toEqual(["https://example.org/robots.txt"]);
    expect(budget.spent("MAX_FETCHES_PER_RUN")).toBe(0);
  });

  it("checks robots.txt on the host a redirect lands on", async () => {
    const { fn } = fakeFetch({
      "https://example.org/e": () =>
        new Response(null, { status: 302, headers: { location: "https://other.example/blocked" } }),
      "https://other.example/robots.txt": () => new Response("User-agent: *\nDisallow: /blocked\n"),
    });
    const p = await createPageFetcher(deps(fn)).fetchPage(item("https://example.org/e"), guardFor());
    expect(p).toMatchObject({ outcome: "robots_blocked", url: "https://other.example/blocked" });
  });

  it("maps statuses to outcomes", async () => {
    const { fn } = fakeFetch({
      "https://example.org/gone": () => new Response("", { status: 410 }),
      "https://example.org/err": () => new Response("", { status: 503 }),
      "https://example.org/forbidden": () => new Response("", { status: 403 }),
      "https://example.org/img": () => new Response("x", { status: 200, headers: { "content-type": "image/png" } }),
      "https://example.org/same": () => new Response(null, { status: 304 }),
    });
    const f = createPageFetcher(deps(fn));
    const b = guardFor();
    const out = async (path: string) => (await f.fetchPage(item(`https://example.org${path}`), b)).outcome;
    expect(await out("/missing")).toBe("not_found");
    expect(await out("/gone")).toBe("gone");
    expect(await out("/err")).toBe("server_error");
    expect(await out("/forbidden")).toBe("client_error");
    expect(await out("/img")).toBe("unsupported_type");
    expect(await out("/same")).toBe("not_modified");
  });

  it("extracts PDF text at 2 MB or less and refuses bigger PDFs", async () => {
    const pdf = makePdf("Charity Golf Scramble October 12 2026");
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(new TextEncoder().encode("%PDF-1.4"));
    const { fn } = fakeFetch({
      "https://example.org/flyer.pdf": () =>
        new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
      "https://example.org/big.pdf": () =>
        new Response(big, { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    const f = createPageFetcher(deps(fn));
    const p = await f.fetchPage(item("https://example.org/flyer.pdf"), guardFor());
    expect(p).toMatchObject({ outcome: "ok", html: null, pdf_text: "Charity Golf Scramble October 12 2026" });
    expect((await f.fetchPage(item("https://example.org/big.pdf"), guardFor())).outcome).toBe("too_large");
  });

  it("renders js-platform items through the renderer and counts a render", async () => {
    const rendered: string[] = [];
    const renderer: Renderer = {
      async render(url) {
        rendered.push(url);
        return { status: 200, finalUrl: url, html: "<main>rendered</main>" };
      },
      async close() {},
    };
    const { fn, calls } = fakeFetch({});
    const f = createPageFetcher(deps(fn, { renderer }));
    const b = guardFor();
    const p = await f.fetchPage(item("https://example.org/e", { render: true }), b);
    expect(p).toMatchObject({ outcome: "ok", rendered: true, html: "<main>rendered</main>" });
    expect(rendered).toEqual(["https://example.org/e"]);
    expect(calls.map((c) => c.url)).toEqual(["https://example.org/robots.txt"]);
    expect(b.spent("MAX_RENDERS_PER_RUN")).toBe(1);
    expect(b.spent("MAX_FETCHES_PER_RUN")).toBe(1);
  });

  it("falls back to a plain fetch when the render cap is used up", async () => {
    const renderer: Renderer = {
      render: async () => {
        throw new Error("should not render");
      },
      close: async () => {},
    };
    const { fn } = fakeFetch({ "https://example.org/e": () => html("<p>plain</p>") });
    const f = createPageFetcher(deps(fn, { renderer }));
    const b = guardFor({ MAX_RENDERS_PER_RUN: "0" });
    const p = await f.fetchPage(item("https://example.org/e", { render: true }), b);
    expect(p).toMatchObject({ outcome: "ok", rendered: false, html: "<p>plain</p>" });
  });
});

describe("fetchAll", () => {
  function pages(hosts: string[]) {
    const routes: Record<string, Handler> = {};
    for (const h of hosts) for (let i = 0; i < 3; i++) routes[`https://${h}/p${i}`] = () => html(`<p>${h} ${i}</p>`);
    return routes;
  }

  it("fetches every item, hosts in parallel, and keeps plan order in the output", async () => {
    const { fn } = fakeFetch(pages(["a.example", "b.example"]));
    const f = createPageFetcher(deps(fn, { hostSpacingMs: 0 }));
    const items = ["a.example", "b.example"].flatMap((h) => [0, 1, 2].map((i) => item(`https://${h}/p${i}`)));
    const r = await fetchAll(items, f, guardFor());
    expect(r.deferred).toEqual([]);
    expect(r.pages.map((p) => p.url)).toEqual(items.map((i) => i.url));
  });

  it("stops at MAX_FETCHES_PER_RUN and defers the rest", async () => {
    const { fn } = fakeFetch(pages(["a.example"]));
    const f = createPageFetcher(deps(fn, { hostSpacingMs: 0 }));
    const items = [0, 1, 2].map((i) => item(`https://a.example/p${i}`));
    const b = guardFor({ MAX_FETCHES_PER_RUN: "2" });
    const r = await fetchAll(items, f, b);
    expect(r.pages).toHaveLength(2);
    expect(r.deferred.map((d) => d.url)).toEqual(["https://a.example/p2"]);
    expect(b.hits().map((h) => h.cap)).toContain("MAX_FETCHES_PER_RUN");
  });

  it("enforces the per-host cap", async () => {
    const { fn } = fakeFetch(pages(["a.example", "b.example"]));
    const f = createPageFetcher(deps(fn, { hostSpacingMs: 0 }));
    const items = ["a.example", "b.example"].flatMap((h) => [0, 1, 2].map((i) => item(`https://${h}/p${i}`)));
    const b = guardFor({ MAX_FETCHES_PER_HOST_PER_RUN: "1" });
    const r = await fetchAll(items, f, b);
    expect(r.pages.map((p) => p.url)).toEqual(["https://a.example/p0", "https://b.example/p0"]);
    expect(r.deferred).toHaveLength(4);
  });

  it("stops when MAX_FETCH_MINUTES has passed", async () => {
    let t = 0;
    const { fn } = fakeFetch({
      ...pages(["a.example"]),
      "https://a.example/p0": () => {
        t += 46 * 60_000;
        return html("<p>slow</p>");
      },
    });
    const f = createPageFetcher(deps(fn, { hostSpacingMs: 0, clock: { nowMs: () => t } }));
    const b = new BudgetGuard({ profile: "nightly", now: new Date("2026-09-28T12:00:00Z"), clock: { nowMs: () => t } });
    const r = await fetchAll([0, 1, 2].map((i) => item(`https://a.example/p${i}`)), f, b);
    expect(r.pages).toHaveLength(1);
    expect(r.deferred).toHaveLength(2);
    expect(b.hits().map((h) => h.cap)).toContain("MAX_FETCH_MINUTES");
  });
});

/** A one-page PDF with a single line of Helvetica text. */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
