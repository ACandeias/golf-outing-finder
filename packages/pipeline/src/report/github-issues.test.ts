import { describe, expect, it } from "vitest";
import {
  createGitHubIssues,
  GITHUB_API_VERSION,
  GitHubApiError,
  upsertIssue,
  type FetchLike,
} from "./github-issues.ts";

const TOKEN = "ghs_FAKE0123456789abcdefTOKEN";
const REPO = "ACandeias/golf_outing";
const TITLE = "Weekly pipeline report";
const LABEL = "pipeline-report";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (c: Call) => { status: number; body: unknown; headers?: Record<string, string> } | "throw";

/** A fake GitHub: records every request and answers from `respond`. */
function fakeFetch(respond: Responder): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = {
      method: init.method ?? "GET",
      url,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  };
  return { fetch, calls };
}

function issue(number: number, title = TITLE, extra: Record<string, unknown> = {}) {
  return {
    number,
    title,
    state: "open",
    html_url: `https://github.com/${REPO}/issues/${number}`,
    labels: [{ name: LABEL }],
    user: { login: "github-actions[bot]" },
    body: "old",
    ...extra,
  };
}

const noSleep = async (): Promise<void> => {};

function client(fetch: FetchLike) {
  return createGitHubIssues({ token: TOKEN, repo: REPO, fetch, sleep: noSleep });
}

describe("GitHub issues client", () => {
  it("sends the bearer token, the API version and JSON headers to api.github.com", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    await client(fetch).listOpen({ label: LABEL, page: 1 });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.url).toBe(
      `https://api.github.com/repos/ACandeias/golf_outing/issues?state=open&per_page=100&page=1&labels=${LABEL}`,
    );
    expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers["x-github-api-version"]).toBe(GITHUB_API_VERSION);
    expect(c.headers.accept).toBe("application/vnd.github+json");
    expect(c.headers["user-agent"]).toMatch(/golf-outing-finder/);
  });

  it("refuses a repository that isn't owner/name", () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: [] }));
    expect(() => createGitHubIssues({ token: TOKEN, repo: "../evil", fetch })).toThrow(/GITHUB_REPOSITORY/);
    expect(() => createGitHubIssues({ token: TOKEN, repo: "a/b/c", fetch })).toThrow(/GITHUB_REPOSITORY/);
  });

  it("rejects a malformed response with zod and never returns it", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: [{ number: "seven", title: 3 }] }));
    await expect(client(fetch).listOpen({ page: 1 })).rejects.toThrow(/unexpected response/);
    const { fetch: f2 } = fakeFetch(() => ({ status: 201, body: { ok: true } }));
    await expect(client(f2).create({ title: TITLE, body: "b", labels: [] })).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("retries GET and PATCH on 5xx, 429 and network errors, then gives up", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => {
      n++;
      if (n === 1) return "throw";
      if (n === 2) return { status: 502, body: { message: "Bad gateway" } };
      return { status: 200, body: [] };
    });
    await expect(client(fetch).listOpen({ page: 1 })).resolves.toEqual([]);
    expect(calls).toHaveLength(3);

    const always = fakeFetch(() => ({ status: 503, body: { message: "unavailable" } }));
    await expect(client(always.fetch).update(7, "b")).rejects.toThrow(/503/);
    expect(always.calls).toHaveLength(3);
  });

  it("never retries a POST (a retried create could open a second issue)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 502, body: { message: "Bad gateway" } }));
    await expect(client(fetch).create({ title: TITLE, body: "b", labels: [LABEL] })).rejects.toThrow(/502/);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 4xx and keeps the token out of the error", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 401,
      body: { message: `Bad credentials for ${TOKEN}` },
    }));
    const err = await client(fetch)
      .listOpen({ page: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(401);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).message)).toContain("401");
    expect(calls).toHaveLength(1);
  });
});

describe("upsertIssue", () => {
  it("creates the issue with its label when none is open", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "GET") return { status: 200, body: [issue(3, "Something else")] };
      return { status: 201, body: issue(12) };
    });
    const r = await upsertIssue(client(fetch), { title: TITLE, label: LABEL, body: "week 1" });
    expect(r).toEqual({ action: "created", number: 12, url: `https://github.com/${REPO}/issues/12` });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/ACandeias/golf_outing/issues");
    expect(post.body).toEqual({ title: TITLE, body: "week 1", labels: [LABEL] });
  });

  it("updates the open issue found by its label", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "GET") return { status: 200, body: [issue(12)] };
      return { status: 200, body: issue(12, TITLE, { body: "week 2" }) };
    });
    const r = await upsertIssue(client(fetch), { title: TITLE, label: LABEL, body: "week 2" });
    expect(r).toEqual({ action: "updated", number: 12, url: `https://github.com/${REPO}/issues/12` });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/ACandeias/golf_outing/issues/12");
    expect(calls[1]!.body).toEqual({ body: "week 2" });
  });

  it("falls back to an exact title match among open issues, skipping pull requests", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "GET" && c.url.includes("labels=")) return { status: 200, body: [] };
      if (c.method === "GET")
        return {
          status: 200,
          body: [
            issue(20, TITLE, { pull_request: { url: "x" }, labels: [] }),
            issue(15, "Weekly pipeline report (old)", { labels: [] }),
            issue(9, TITLE, { labels: [] }),
          ],
        };
      return { status: 200, body: issue(9) };
    });
    const r = await upsertIssue(client(fetch), { title: TITLE, label: LABEL, body: "b" });
    expect(r).toMatchObject({ action: "updated", number: 9 });
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.url)).toEqual([
      "https://api.github.com/repos/ACandeias/golf_outing/issues/9",
    ]);
  });

  it("creates without the label when GitHub refuses it (422)", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "GET") return { status: 200, body: [] };
      const labels = (c.body as { labels?: string[] }).labels ?? [];
      return labels.length > 0
        ? { status: 422, body: { message: "Validation Failed" } }
        : { status: 201, body: issue(4) };
    });
    const r = await upsertIssue(client(fetch), { title: TITLE, label: LABEL, body: "b" });
    expect(r).toMatchObject({ action: "created", number: 4 });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { title: TITLE, body: "b", labels: [LABEL] },
      { title: TITLE, body: "b" },
    ]);
  });
});
