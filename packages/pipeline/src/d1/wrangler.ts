import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { PATHS } from "../lib/paths.ts";
import { writeSqlFiles } from "../lib/wrangler.ts";
import type { UpsertPlan } from "../stages/types.ts";
import { planToStatements } from "./plan-sql.ts";
import type { ApplyReport, D1Port, Snapshot } from "./port.ts";
import { loadDump, openSqlite, snapshotOver, type Sqlite } from "./sqlite.ts";

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
  // `wrangler d1 export` has no --persist-to (wrangler 4.147: "Unknown arguments");
  // a local snapshot under --persist-to is copied with `copyLocalD1` instead.
  return args;
}

/**
 * The SQLite file wrangler keeps the local `gof` D1 in under a --persist-to
 * directory: `<dir>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`. The one
 * holding an `outings` table; more than one is refused rather than guessed.
 */
export function localD1File(persistTo: string): string {
  const dir = join(persistTo, "v3/d1/miniflare-D1DatabaseObject");
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    : [];
  const withOutings = files.filter((f) => {
    const db = openSqlite(join(dir, f), { readOnly: true });
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outings'").get() !== undefined;
    } finally {
      db.close();
    }
  });
  if (withOutings.length === 0) throw new Error(`no local D1 with an outings table under ${dir} (run pnpm db:migrate:local)`);
  if (withOutings.length > 1) throw new Error(`more than one local D1 database under ${dir}: ${withOutings.join(", ")}`);
  return join(dir, withOutings[0] as string);
}

/** A consistent copy of a local D1 file (WAL included) at `dest`, via VACUUM INTO. */
export function copyLocalD1(source: string, dest: string): void {
  const db = openSqlite(source);
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
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
 *
 * The snapshot is a working copy: every plan `apply` sends to D1 is also run on
 * the open snapshot file (`writeThrough`), so later stages in the same run
 * (publish, recheck) read the rows earlier stages wrote, exactly as they would
 * against the in-memory port.
 */
export class WranglerD1 implements D1Port {
  readonly target: "remote" | "local";
  private readonly o: WranglerD1Options;
  private applyCount = 0;
  private local: Sqlite | null = null;

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
    let db: Sqlite;
    if (this.o.target === "local" && this.o.persistTo) {
      copyLocalD1(localD1File(this.o.persistTo), file);
      db = openSqlite(file);
    } else {
      await this.wrangler(exportArgs(this.o, dump));
      db = openSqlite(file);
      loadDump(db, await readFile(dump, "utf8"));
    }
    this.local = db;
    return snapshotOver(db, () => {
      if (this.local === db) this.local = null;
      db.close();
    });
  }

  async apply(plan: UpsertPlan): Promise<ApplyReport> {
    const statements = planToStatements(plan);
    if (statements.length === 0) return { statements: 0, files: 0 };
    this.applyCount += 1;
    const dir = join(this.o.workDir, `apply-${String(this.applyCount).padStart(3, "0")}`);
    const files = await writeSqlFiles(statements, dir, "plan");
    for (const f of files) await this.wrangler(executeArgs(this.o, f));
    if (this.local) writeThrough(this.local, statements);
    return { statements: statements.length, files: files.length };
  }
}

/** Runs statements D1 already accepted on the run's snapshot copy, in one transaction. */
export function writeThrough(db: Sqlite, statements: readonly string[]): void {
  if (statements.length === 0) return;
  db.exec("BEGIN;");
  try {
    for (const s of statements) db.exec(s);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw new Error(
      `D1 accepted the write but the local snapshot copy failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
