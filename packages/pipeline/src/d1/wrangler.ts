import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { PATHS } from "../lib/paths.ts";
import { writeSqlFiles } from "../lib/wrangler.ts";
import type { UpsertPlan } from "../stages/types.ts";
import { planToStatements } from "./plan-sql.ts";
import type { ApplyReport, D1Port, Snapshot } from "./port.ts";
import { loadDump, openSqlite, snapshotOver } from "./sqlite.ts";

const run = promisify(execFile);

export const D1_DATABASE_NAME = "gof";

export interface WranglerD1Options {
  target: "remote" | "local";
  /** Working directory for snapshot and SQL files; defaults to .cache/d1/<runId>. */
  workDir: string;
  /** Local only: wrangler's --persist-to directory. */
  persistTo?: string;
  /** wrangler binary; defaults to apps/site's. */
  bin?: string;
  /** apps/site, where wrangler.toml lives. */
  siteDir?: string;
}

function locationFlag(target: "remote" | "local"): string {
  return target === "remote" ? "--remote" : "--local";
}

/** `wrangler d1 export` arguments (pure, tested). */
export function exportArgs(
  o: Pick<WranglerD1Options, "target" | "persistTo">,
  output: string,
): string[] {
  const args = [
    "d1",
    "export",
    D1_DATABASE_NAME,
    locationFlag(o.target),
    "--config",
    "wrangler.toml",
    "--output",
    output,
  ];
  if (o.target === "local" && o.persistTo) args.push("--persist-to", o.persistTo);
  return args;
}

/** `wrangler d1 execute --command --json` arguments for a read (pure, tested). */
export function queryArgs(
  o: Pick<WranglerD1Options, "target" | "persistTo">,
  sql: string,
): string[] {
  const args = [
    "d1",
    "execute",
    D1_DATABASE_NAME,
    locationFlag(o.target),
    "--config",
    "wrangler.toml",
    "--json",
    "--command",
    sql,
  ];
  if (o.target === "local" && o.persistTo) args.push("--persist-to", o.persistTo);
  return args;
}

const wranglerJson = z.array(z.object({ results: z.array(z.unknown()) }).passthrough()).min(1);

/** `wrangler d1 execute --json` writes `[{ results: [...] }]`. */
export function parseQueryOutput<T>(
  stdout: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T[] {
  const parsed = wranglerJson.parse(JSON.parse(stdout));
  return (parsed[0]?.results ?? []).map((r) => schema.parse(r));
}

/** `wrangler d1 execute --file` arguments (pure, tested). */
export function executeArgs(
  o: Pick<WranglerD1Options, "target" | "persistTo">,
  file: string,
): string[] {
  const args = [
    "d1",
    "execute",
    D1_DATABASE_NAME,
    locationFlag(o.target),
    "--config",
    "wrangler.toml",
    "--file",
    file,
    "--yes",
  ];
  if (o.target === "local" && o.persistTo) args.push("--persist-to", o.persistTo);
  return args;
}

/**
 * D1 through wrangler (SPEC.md 8.0). `snapshot` exports the database to a SQL
 * dump and loads it into a SQLite file opened with node:sqlite; `apply` writes
 * literal SQL files of at most 1,000 statements and executes each. Credentials
 * come from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment and
 * are never passed on the command line. Tests never call this class.
 */
export class WranglerD1 implements D1Port {
  readonly target: "remote" | "local";
  private readonly o: WranglerD1Options;
  private applyCount = 0;

  constructor(o: WranglerD1Options) {
    this.o = o;
    this.target = o.target;
  }

  private bin(): string {
    if (this.o.bin) return this.o.bin;
    const local = join(this.siteDir(), "node_modules/.bin/wrangler");
    return existsSync(local) ? local : "wrangler";
  }

  private siteDir(): string {
    return this.o.siteDir ?? PATHS.site;
  }

  private async wrangler(args: string[]): Promise<string> {
    const { stdout } = await run(this.bin(), args, {
      cwd: this.siteDir(),
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async query<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
    return parseQueryOutput(await this.wrangler(queryArgs(this.o, sql)), schema);
  }

  async snapshot(): Promise<Snapshot> {
    await mkdir(this.o.workDir, { recursive: true });
    const dump = join(this.o.workDir, "snapshot.sql");
    const file = join(this.o.workDir, "snapshot.sqlite");
    await rm(file, { force: true });
    await this.wrangler(exportArgs(this.o, dump));
    const db = openSqlite(file);
    loadDump(db, await readFile(dump, "utf8"));
    return snapshotOver(db);
  }

  async apply(plan: UpsertPlan): Promise<ApplyReport> {
    const statements = planToStatements(plan);
    if (statements.length === 0) return { statements: 0, files: 0 };
    this.applyCount += 1;
    const dir = join(this.o.workDir, `apply-${String(this.applyCount).padStart(3, "0")}`);
    const files = await writeSqlFiles(statements, dir, "plan");
    for (const f of files) await this.wrangler(executeArgs(this.o, f));
    return { statements: statements.length, files: files.length };
  }
}
