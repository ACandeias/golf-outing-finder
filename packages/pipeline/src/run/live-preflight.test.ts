import { describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import { MemoryD1 } from "../d1/memory.ts";
import { stubHandlers } from "./handlers.ts";
import { livePreflight, wranglerDatabaseId } from "./live-preflight.ts";

const TOML_OK = '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "gof"\ndatabase_id = "0f1e2d3c-aaaa-bbbb-cccc-123456789abc"\n';
const TOML_PLACEHOLDER = TOML_OK.replace(/database_id = ".*"/, 'database_id = "REPLACE_WITH_D1_DATABASE_ID"');
const SECRETS = {
  NODE_ENV: "production",
  PUBLIC_SITE_URL: "https://golfoutingfinder.com",
  ANTHROPIC_API_KEY: "sk-ant-api03-TESTKEYTESTKEYTESTKEY",
  SERP_API_KEY: "login@example.com:password",
  CLOUDFLARE_API_TOKEN: "cf-token",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  D1_DATABASE_ID: "0f1e2d3c-aaaa-bbbb-cccc-123456789abc",
};

describe("livePreflight", () => {
  it("passes with every nightly secret and the real database id in wrangler.toml", () => {
    const r = livePreflight("nightly", SECRETS, { d1: "remote", wranglerToml: TOML_OK });
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(wranglerDatabaseId(TOML_OK)).toBe(SECRETS.D1_DATABASE_ID);
  });

  it("names each missing secret, never a value", () => {
    const { ANTHROPIC_API_KEY: _a, SERP_API_KEY: _s, CLOUDFLARE_API_TOKEN: _c, ...rest } = SECRETS;
    const r = livePreflight("nightly", rest, { d1: "remote", wranglerToml: TOML_OK });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "ANTHROPIC_API_KEY is not set",
      "SERP_API_KEY is not set",
      "CLOUDFLARE_API_TOKEN is not set",
    ]);
  });

  it("validates the env with the shared zod schema", () => {
    const r = livePreflight("nightly", { ...SECRETS, SERP_API_KEY: "no-colon" }, { d1: "remote", wranglerToml: TOML_OK });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/SERP_API_KEY: .*login:password/);
    expect(r.problems.join("\n")).not.toContain("no-colon");
  });

  it("refuses the remote D1 while wrangler.toml holds the placeholder or a different id", () => {
    expect(livePreflight("nightly", SECRETS, { d1: "remote", wranglerToml: TOML_PLACEHOLDER }).problems).toEqual([
      expect.stringMatching(/wrangler\.toml still has no database_id/),
    ]);
    expect(
      livePreflight("nightly", { ...SECRETS, D1_DATABASE_ID: "other" }, { d1: "remote", wranglerToml: TOML_OK }).problems,
    ).toEqual([expect.stringMatching(/does not match/)]);
  });

  it("monthly needs no SERP key; a live run on the local D1 needs no Cloudflare secrets", () => {
    const { SERP_API_KEY: _s, ...noSerp } = SECRETS;
    expect(livePreflight("monthly", noSerp, { d1: "remote", wranglerToml: TOML_OK }).ok).toBe(true);
    const { CLOUDFLARE_API_TOKEN: _t, CLOUDFLARE_ACCOUNT_ID: _i, D1_DATABASE_ID: _d, ...local } = SECRETS;
    expect(livePreflight("nightly", local, { d1: "local", wranglerToml: TOML_PLACEHOLDER }).ok).toBe(true);
  });
});

describe("pnpm run pipeline --live without its secrets", () => {
  it("refuses to start: exit 2, a clear message, no runs row, nothing fetched", async () => {
    const err: string[] = [];
    const d1 = new MemoryD1();
    const r = await main(["--live", "--budget=nightly"], {
      env: { NODE_ENV: "production", PUBLIC_SITE_URL: "https://golfoutingfinder.com" },
      d1,
      wranglerToml: TOML_PLACEHOLDER,
      handlers: stubHandlers(),
      stdout: () => {},
      stderr: (l) => err.push(l),
    });
    expect(r.exitCode).toBe(2);
    expect(r.outcome).toBeNull();
    const text = err.join("\n");
    expect(text).toMatch(/refusing to start a live nightly run/);
    expect(text).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(text).toMatch(/wrangler\.toml still has no database_id/);
    expect(d1.db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("--budget=smoke is checked like a nightly run", async () => {
    const err: string[] = [];
    const r = await main(["--live", "--budget=smoke"], {
      env: { NODE_ENV: "production", PUBLIC_SITE_URL: "https://golfoutingfinder.com" },
      d1: new MemoryD1(),
      wranglerToml: TOML_OK,
      stdout: () => {},
      stderr: (l) => err.push(l),
    });
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/live nightly run[\s\S]*SERP_API_KEY is not set/);
  });
});
