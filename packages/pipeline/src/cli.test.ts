import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.ts";
import { main } from "./cli.ts";
import { MemoryD1 } from "./d1/memory.ts";
import { defaultHandlers, type StageHandler, type StageHandlers } from "./run/handlers.ts";
import { emptyResult } from "./stages/types.ts";

const ENV = { NODE_ENV: "test", PIPELINE_NOW: "2026-09-28" };

describe("parseCliArgs", () => {
  it("defaults to a nightly dry run on the local D1", () => {
    const o = parseCliArgs([], ENV);
    expect(o).toMatchObject({
      mode: "dry-run",
      budget: "nightly",
      d1: "local",
      strict: false,
      failStage: null,
      now: null,
    });
    expect(o.stages.at(-1)).toBe("report");
  });

  it("parses the nightly.yml and monthly.yml invocations", () => {
    expect(
      parseCliArgs(["--", "--live", "--budget=nightly"], { NODE_ENV: "production" }),
    ).toMatchObject({
      mode: "live",
      d1: "remote",
    });
    expect(
      parseCliArgs(["--live", "--budget=monthly", "--stages=courses,irs,course-types"], {}).stages,
    ).toEqual(["courses", "irs", "course-types", "report"]);
  });

  it("rejects bad combinations", () => {
    expect(() => parseCliArgs(["--dry-run", "--live"], ENV)).toThrow(/mutually exclusive/);
    expect(() => parseCliArgs(["--budget=weekly"], ENV)).toThrow(/--budget/);
    expect(() => parseCliArgs(["--stages=classify,nope"], ENV)).toThrow(/unknown stage/);
    expect(() => parseCliArgs(["--fail-stage=nope"], ENV)).toThrow(/--fail-stage/);
    expect(() => parseCliArgs(["--fail-stage=report"], ENV)).toThrow(/--fail-stage/);
    expect(() => parseCliArgs(["--stages=classify", "--fail-stage=match"], ENV)).toThrow(
      /not among/,
    );
    expect(() => parseCliArgs(["--d1=remote"], ENV)).toThrow(/never writes the remote/);
    expect(() => parseCliArgs(["--bogus"], ENV)).toThrow();
  });

  it("allows --now only outside production", () => {
    expect(parseCliArgs(["--now=2026-09-28"], ENV).now).toBe("2026-09-28");
    expect(() => parseCliArgs(["--now=2026-09-28"], { NODE_ENV: "production" })).toThrow(
      /production/,
    );
    expect(() => parseCliArgs(["--now=yesterday"], ENV)).toThrow(/ISO/);
  });
});

async function runMain(
  argv: string[],
  handlers: StageHandlers = defaultHandlers,
  env: Record<string, string> = ENV,
) {
  const out: string[] = [];
  const err: string[] = [];
  const d1 = new MemoryD1();
  const r = await main(argv, {
    env,
    d1,
    handlers,
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  });
  return { ...r, out: out.join(""), err, d1 };
}

describe("pipeline CLI", () => {
  it("--dry-run reports each unimplemented stage, writes a runs row, makes no network call and exits 0", async () => {
    const r = await runMain(["--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.networkAttempts).toEqual([]);
    for (const s of [
      "discover",
      "fetch",
      "normalize",
      "extract-request-build",
      "extract-collect",
      "classify",
      "match",
    ]) {
      expect(r.out).toContain(`| ${s} | not implemented`);
    }
    expect(r.err.join("\n")).toMatch(
      /not implemented: discover, fetch, .*recheck-roll-forward \(allowed without --strict\)/,
    );
    const rows = r.d1.db.prepare("SELECT id, kind, started_at, finished_at FROM runs").all();
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "nightly",
        started_at: "2026-09-28T12:00:00.000Z",
        finished_at: expect.any(String),
      }),
    ]);
  });

  it("--strict turns unimplemented stages into a failing exit", async () => {
    expect((await runMain(["--dry-run", "--strict"])).exitCode).toBe(1);
  });

  it("blocks network access during a dry run and fails the run when a stage tries", async () => {
    const leaky: StageHandler = async () => {
      await fetch("https://api.dataforseo.com/v3/serp/google/organic/task_post");
      return { result: emptyResult() };
    };
    const r = await runMain(["--dry-run"], { ...defaultHandlers, discover: leaky });
    expect(r.exitCode).toBe(1);
    expect(r.networkAttempts).toEqual([
      "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    ]);
    expect(r.outcome?.statuses[0]).toMatchObject({ stage: "discover", status: "failed" });
  });

  it("--fail-stage makes that stage throw and the job exit non-zero", async () => {
    const r = await runMain(["--dry-run", "--fail-stage=classify"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("| classify | FAILED (forced failure (--fail-stage=classify)) |");
  });

  it("exits 2 on a usage error", async () => {
    const r = await runMain(["--now=2026-09-28"], defaultHandlers, {
      NODE_ENV: "production",
      PUBLIC_SITE_URL: "https://x.org",
    });
    expect(r.exitCode).toBe(2);
    expect(r.err.join("\n")).toMatch(/--now is not allowed/);
  });

  it("pins the clock with --now and writes $GITHUB_STEP_SUMMARY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gof-summary-"));
    const file = join(dir, "summary.md");
    const r = await runMain(["--dry-run", "--now=2026-10-01"], defaultHandlers, {
      NODE_ENV: "test",
      GITHUB_STEP_SUMMARY: file,
    });
    expect(r.outcome?.run.started_at).toBe("2026-10-01T12:00:00.000Z");
    expect(await readFile(file, "utf8")).toContain("## Pipeline run `run_");
  });

  it("never logs secret values", async () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRET";
    const leaky: StageHandler = async ({ ctx }) => {
      ctx.log.info(`calling with key ${secret}`);
      return { result: emptyResult() };
    };
    const r = await runMain(
      ["--dry-run"],
      { ...defaultHandlers, discover: leaky },
      { ...ENV, ANTHROPIC_API_KEY: secret },
    );
    const all = r.err.join("\n");
    expect(all).toContain("calling with key [REDACTED]");
    expect(all).not.toContain(secret);
  });
});
