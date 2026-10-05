import { describe, expect, it } from "vitest";
import { MemoryD1 } from "../d1/memory.ts";
import { createLogger, memoryLogger, secretValues } from "../lib/logger.ts";
import type { FetchLike } from "../report/github-issues.ts";
import { WEEKLY_ISSUE_TITLE } from "../report/weekly-issue.ts";
import { runRowSchema, type RunRow } from "../stages/rows.ts";
import { newRunRow, runRowPlan } from "./accounting.ts";
import { recordWeeklyFailure, weeklyReport, weeklySummaryMarkdown, type WeeklyReportOptions } from "./weekly.ts";

const TOKEN = "ghs_FAKE0123456789abcdefTOKEN";
const NOW = new Date("2026-09-28T07:20:00.000Z");

function row(id: string, startedAt: string, patch: Partial<RunRow> = {}): RunRow {
  return runRowSchema.parse({
    ...newRunRow(id, "nightly", new Date(startedAt)),
    finished_at: startedAt,
    fetches: 100,
    est_cost_cents: 200,
    ...patch,
  });
}

async function seeded(): Promise<MemoryD1> {
  const d1 = new MemoryD1();
  await d1.apply(runRowPlan(row("run_old", "2026-09-20T07:15:00.000Z", { est_cost_cents: 9999 })));
  await d1.apply(runRowPlan(row("run_a", "2026-09-22T07:15:00.000Z")));
  await d1.apply(runRowPlan(row("run_b", "2026-09-27T07:15:00.000Z", { fetches: 50 })));
  await d1.apply(runRowPlan(row("run_now", "2026-09-28T07:15:00.000Z", { fetches: 25, est_cost_cents: 100 })));
  return d1;
}

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

function github(respond: (c: Call) => { status: number; body: unknown } | "throw"): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const c: Call = { method: init.method ?? "GET", url, body: typeof init.body === "string" ? init.body : undefined };
      calls.push(c);
      const r = respond(c);
      if (r === "throw") throw new TypeError(`connect ECONNREFUSED (token ${TOKEN})`);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    },
  };
}

const issue = (n: number) => ({
  number: n,
  title: WEEKLY_ISSUE_TITLE,
  state: "open",
  html_url: `https://github.com/ACandeias/golf_outing/issues/${n}`,
});

function opts(patch: Partial<WeeklyReportOptions> = {}): WeeklyReportOptions {
  return {
    action: "post",
    now: NOW,
    runId: "run_now",
    monthlyCapCents: 15_000,
    token: TOKEN,
    repo: "ACandeias/golf_outing",
    secrets: [TOKEN],
    ...patch,
  };
}

describe("weeklyReport", () => {
  it("creates the issue when none is open, with the last 7 days of runs", async () => {
    const d1 = await seeded();
    const gh = github((c) => (c.method === "GET" ? { status: 200, body: [] } : { status: 201, body: issue(31) }));
    const r = await weeklyReport(opts(), { d1, log: memoryLogger(), fetch: gh.fetch, sleep: async () => {} });
    expect(r).toMatchObject({ status: "posted", action: "created", number: 31 });
    const post = gh.calls.find((c) => c.method === "POST")!;
    const sent = JSON.parse(post.body!) as { title: string; body: string; labels: string[] };
    expect(sent.title).toBe(WEEKLY_ISSUE_TITLE);
    expect(sent.labels).toEqual(["pipeline-report"]);
    // run_old is outside the window; the other three are summed.
    expect(sent.body).toContain("| Runs | 3 (3 nightly, 0 monthly) |");
    expect(sent.body).toContain("| fetches | 175 |");
    expect(sent.body).toContain("Estimated cost this week: $5.00.");
    expect(sent.body).toContain("### Holds by reason");
    expect(weeklySummaryMarkdown(r)).toContain("created: https://github.com/ACandeias/golf_outing/issues/31");
  });

  it("updates the open issue when there is one", async () => {
    const d1 = await seeded();
    const gh = github((c) => (c.method === "GET" ? { status: 200, body: [issue(31)] } : { status: 200, body: issue(31) }));
    const r = await weeklyReport(opts(), { d1, log: memoryLogger(), fetch: gh.fetch, sleep: async () => {} });
    expect(r).toMatchObject({ status: "posted", action: "updated", number: 31 });
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(weeklySummaryMarkdown(r)).toContain("Weekly report issue #31 updated");
  });

  it("only renders when asked to (a dry run): no request at all", async () => {
    const d1 = await seeded();
    const gh = github(() => ({ status: 500, body: {} }));
    const r = await weeklyReport(opts({ action: "render", token: undefined, repo: undefined }), {
      d1,
      log: memoryLogger(),
      fetch: gh.fetch,
    });
    expect(gh.calls).toEqual([]);
    expect(r.status).toBe("rendered");
    const md = weeklySummaryMarkdown(r);
    expect(md).toContain("not posted (dry run)");
    expect(md).toContain("| Runs | 3 (3 nightly, 0 monthly) |");
  });

  it("a GitHub failure is reported, not thrown, and the token never reaches the logs or the summary", async () => {
    const d1 = await seeded();
    const lines: string[] = [];
    const log = createLogger({ level: "debug", secrets: secretValues({ GH_TOKEN: TOKEN }), sink: (l) => lines.push(l) });
    const raw = memoryLogger();
    const gh = github(() => "throw");
    for (const logger of [log, raw]) {
      const r = await weeklyReport(opts(), { d1, log: logger, fetch: gh.fetch, sleep: async () => {} });
      expect(r.status).toBe("failed");
      const md = weeklySummaryMarkdown(r);
      expect(md).toContain("Weekly report issue: not posted");
      expect(md).not.toContain(TOKEN);
    }
    expect(lines.some((l) => l.includes("weekly report issue"))).toBe(true);
    expect([...lines, ...raw.lines].join("\n")).not.toContain(TOKEN);
    // GET is retried three times per attempt; no POST is made after a failed lookup.
    expect(gh.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("redacts secret values from the body before it goes to the public issue", async () => {
    const d1 = await seeded();
    await d1.apply(
      runRowPlan(
        row("run_leak", "2026-09-26T07:15:00.000Z", {
          errors: JSON.stringify([{ stage: "fetch", kind: "internal", message: `oops ${TOKEN}` }]),
        }),
      ),
    );
    const gh = github((c) => (c.method === "GET" ? { status: 200, body: [] } : { status: 201, body: issue(2) }));
    await weeklyReport(opts(), { d1, log: memoryLogger(), fetch: gh.fetch, sleep: async () => {} });
    const post = gh.calls.find((c) => c.method === "POST")!;
    expect(post.body).not.toContain(TOKEN);
    expect(post.body).toContain("[REDACTED]");
  });

  it("recordWeeklyFailure adds a report error to the runs row without failing the run", () => {
    const r = row("run_now", "2026-09-28T07:15:00.000Z");
    const next = recordWeeklyFailure(r, "GitHub GET /repos/x/y/issues returned 401");
    expect(JSON.parse(next.errors)).toEqual([
      { stage: "report", kind: "network", message: "weekly report issue: GitHub GET /repos/x/y/issues returned 401" },
    ]);
  });
});
