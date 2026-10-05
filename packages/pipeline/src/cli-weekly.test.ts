import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { main } from "./cli.ts";
import { MemoryD1 } from "./d1/memory.ts";
import type { ApplyReport, D1Port, Snapshot } from "./d1/port.ts";
import type { FetchLike } from "./report/github-issues.ts";
import { HANDLED_STAGES, type StageHandler, type StageHandlers } from "./run/handlers.ts";
import { emptyResult, type UpsertPlan } from "./stages/types.ts";

/**
 * SPEC.md 13 Phase 5: "The weekly report issue is created and updated." The
 * CLI runs the weekly report after the run report: on a Monday (UTC) in a live
 * nightly against the production D1 it creates the issue, the next Monday it
 * updates the same one, on other days it does nothing, a dry run renders it
 * without a request, and a GitHub failure leaves the exit code alone.
 */

const TOKEN = "ghs_FAKE0123456789abcdefTOKEN";
const DB_ID = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const LIVE_ENV = {
  NODE_ENV: "test",
  PUBLIC_SITE_URL: "https://golfoutingfinder.example",
  ANTHROPIC_API_KEY: "sk-ant-fake-key-0123456789",
  SERP_API_KEY: "login:password1234",
  CLOUDFLARE_API_TOKEN: "cf-fake-token-0123456789",
  CLOUDFLARE_ACCOUNT_ID: "acct0123456789",
  D1_DATABASE_ID: DB_ID,
  GH_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "ACandeias/golf_outing",
};
const WRANGLER_TOML = `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "gof"\ndatabase_id = "${DB_ID}"\n`;

/** The in-memory D1 standing in for the remote one (a live run posts only against production). */
class RemoteLike implements D1Port {
  readonly target = "remote" as const;
  constructor(readonly inner: MemoryD1) {}
  snapshot(): Promise<Snapshot> {
    return this.inner.snapshot();
  }
  apply(plan: UpsertPlan): Promise<ApplyReport> {
    return this.inner.apply(plan);
  }
  query<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
    return this.inner.query(sql, schema);
  }
}

const done: StageHandler = async () => ({ result: emptyResult() });
const allDone = Object.fromEntries(HANDLED_STAGES.map((k) => [k, done])) as StageHandlers;

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

/** A GitHub that keeps one repo's issues in memory. */
function fakeGitHub(fail = false): { fetch: FetchLike; calls: Call[]; issues: { number: number; title: string; body: string }[] } {
  const calls: Call[] = [];
  const issues: { number: number; title: string; body: string }[] = [];
  const view = (i: (typeof issues)[number]) => ({
    ...i,
    state: "open",
    html_url: `https://github.com/ACandeias/golf_outing/issues/${i.number}`,
  });
  const fetch: FetchLike = async (url, init) => {
    const c: Call = {
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(c);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (fail) return json(500, { message: "Server Error" });
    if (c.method === "GET") return json(200, issues.map(view));
    if (c.method === "POST") {
      const b = JSON.parse(c.body!) as { title: string; body: string };
      const i = { number: issues.length + 1, title: b.title, body: b.body };
      issues.push(i);
      return json(201, view(i));
    }
    const n = Number(url.split("/").at(-1));
    const i = issues.find((x) => x.number === n)!;
    i.body = (JSON.parse(c.body!) as { body: string }).body;
    return json(200, view(i));
  };
  return { fetch, calls, issues };
}

async function live(now: string, gh: ReturnType<typeof fakeGitHub>, d1 = new MemoryD1(), extra: string[] = []) {
  const err: string[] = [];
  const out: string[] = [];
  const r = await main(["--live", ...extra], {
    env: { ...LIVE_ENV, PIPELINE_NOW: now },
    d1: new RemoteLike(d1),
    handlers: allDone,
    wranglerToml: WRANGLER_TOML,
    githubFetch: gh.fetch,
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  });
  return { ...r, err, out: out.join(""), d1 };
}

describe("weekly report issue from the CLI", () => {
  it("is created on a Monday and updated the next Monday; other days leave it alone", async () => {
    const gh = fakeGitHub();
    const d1 = new MemoryD1();
    const first = await live("2026-09-28T07:15:00Z", gh, d1);
    expect(first.exitCode).toBe(0);
    expect(first.weekly).toMatchObject({ status: "posted", action: "created", number: 1 });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.title).toBe("Weekly pipeline report");
    expect(gh.issues[0]!.body).toContain("| Runs | 1 (1 nightly, 0 monthly) |");
    expect(first.out).toContain("Weekly report issue #1 created");

    const tuesday = await live("2026-09-29T07:15:00Z", gh, d1);
    expect(tuesday.weekly).toBeNull();
    const before = gh.calls.length;

    const next = await live("2026-10-05T07:15:00Z", gh, d1);
    expect(next.weekly).toMatchObject({ status: "posted", action: "updated", number: 1 });
    expect(gh.issues).toHaveLength(1);
    // Runs started after 2026-09-28T07:15: Tuesday's and this one.
    expect(gh.issues[0]!.body).toContain("| Runs | 2 (2 nightly, 0 monthly) |");
    expect(gh.calls.slice(before).map((c) => c.method)).toEqual(["GET", "PATCH"]);

    for (const c of gh.calls) {
      expect(new URL(c.url).origin).toBe("https://api.github.com");
      expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    for (const r of [first, tuesday, next]) expect(r.err.join("\n")).not.toContain(TOKEN);
  });

  it("--weekly-report posts on any day", async () => {
    const gh = fakeGitHub();
    const r = await live("2026-09-30T07:15:00Z", gh, new MemoryD1(), ["--weekly-report"]);
    expect(r.weekly).toMatchObject({ status: "posted", action: "created" });
  });

  it("a GitHub failure is reported, stored as a report error, and does not fail the job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-weekly-"));
    const summary = join(dir, "summary.md");
    const gh = fakeGitHub(true);
    const err: string[] = [];
    const d1 = new MemoryD1();
    const r = await main(["--live"], {
      env: { ...LIVE_ENV, PIPELINE_NOW: "2026-09-28T07:15:00Z", GITHUB_STEP_SUMMARY: summary },
      d1: new RemoteLike(d1),
      handlers: allDone,
      wranglerToml: WRANGLER_TOML,
      githubFetch: gh.fetch,
      stdout: () => {},
      stderr: (l) => err.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(r.weekly?.status).toBe("failed");
    expect(await readFile(summary, "utf8")).toContain("Weekly report issue: not posted");
    const [row] = d1.db.prepare("SELECT errors FROM runs").all() as { errors: string }[];
    expect(JSON.parse(row!.errors)).toContainEqual(
      expect.objectContaining({ stage: "report", kind: "network", message: expect.stringContaining("500") }),
    );
    expect(err.join("\n")).not.toContain(TOKEN);
  });

  it("a live run on a local D1 never posts", async () => {
    const gh = fakeGitHub();
    const r = await main(["--live", "--d1=local"], {
      env: { ...LIVE_ENV, PIPELINE_NOW: "2026-09-28T07:15:00Z" },
      d1: new MemoryD1(),
      handlers: allDone,
      wranglerToml: WRANGLER_TOML,
      githubFetch: gh.fetch,
      stdout: () => {},
      stderr: () => {},
    });
    expect(r.weekly).toBeNull();
    expect(gh.calls).toEqual([]);
  });

  it("a dry run on a Monday renders the body into the summary and makes no request, even with a token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-weekly-"));
    const summary = join(dir, "summary.md");
    const gh = fakeGitHub();
    const r = await main(["--dry-run"], {
      env: { NODE_ENV: "test", PIPELINE_NOW: "2026-09-28", GH_TOKEN: TOKEN, GITHUB_REPOSITORY: "ACandeias/golf_outing", GITHUB_STEP_SUMMARY: summary },
      d1: new MemoryD1(),
      handlers: allDone,
      githubFetch: gh.fetch,
      stdout: () => {},
      stderr: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.networkAttempts).toEqual([]);
    expect(gh.calls).toEqual([]);
    expect(r.weekly?.status).toBe("rendered");
    const md = await readFile(summary, "utf8");
    expect(md).toContain("Weekly report issue: not posted (dry run)");
    expect(md).toContain("## Weekly pipeline report");
  });
});
