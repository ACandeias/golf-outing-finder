import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkStatements } from "../sql/literal.ts";
import { PATHS } from "./paths.ts";

/**
 * Applies literal SQL to the local D1 through wrangler (SPEC.md 8.0): the
 * statements are split into files of at most 1,000 statements, each run with
 * `wrangler d1 execute gof --local --file`. Remote writes are Phase 2's job.
 */
export interface WranglerTarget {
  persistTo?: string;
  /** Path to the wrangler binary; defaults to apps/site's. */
  bin?: string;
}

export async function writeSqlFiles(statements: readonly string[], dir: string, prefix: string): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const chunks = chunkStatements(statements);
  for (const [i, chunk] of chunks.entries()) {
    const file = join(dir, `${prefix}-${String(i + 1).padStart(3, "0")}.sql`);
    await writeFile(file, `${chunk.join("\n")}\n`);
    files.push(file);
  }
  return files;
}

function wranglerBin(target: WranglerTarget): string {
  if (target.bin) return target.bin;
  const local = join(PATHS.site, "node_modules/.bin/wrangler");
  return existsSync(local) ? local : "wrangler";
}

export function executeLocalD1(files: readonly string[], target: WranglerTarget = {}): void {
  const bin = wranglerBin(target);
  for (const file of files) {
    const args = ["d1", "execute", "gof", "--local", "--config", "wrangler.toml", "--file", file, "--yes"];
    if (target.persistTo) args.push("--persist-to", target.persistTo);
    execFileSync(bin, args, {
      cwd: PATHS.site,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
  }
}

/** Runs a read query against the local D1 and returns its rows. */
export function queryLocalD1(sql: string, target: WranglerTarget = {}): Record<string, unknown>[] {
  const args = ["d1", "execute", "gof", "--local", "--config", "wrangler.toml", "--json", "--command", sql];
  if (target.persistTo) args.push("--persist-to", target.persistTo);
  const out = execFileSync(wranglerBin(target), args, {
    cwd: PATHS.site,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error("unexpected wrangler --json output");
  const first: unknown = parsed[0];
  if (typeof first !== "object" || first === null || !("results" in first) || !Array.isArray(first.results)) {
    throw new Error("unexpected wrangler --json output");
  }
  return first.results as Record<string, unknown>[];
}
