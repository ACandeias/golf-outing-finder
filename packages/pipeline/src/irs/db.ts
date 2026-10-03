import { mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { z } from "zod";
import { irsNameTokens } from "../stages/irs-memory.ts";
import { irs } from "../stages/irs.ts";
import { irsRecordSchema, type Context, type IrsLookup, type IrsRecord } from "../stages/types.ts";
import { csvRows } from "./csv-stream.ts";

// node:sqlite through require: Vitest's resolver does not know the builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type Db = NodeSqlite.DatabaseSync;

/**
 * The local IRS lookup database (SPEC.md 8.1 step 6, 8.5): one node:sqlite file
 * per month, `.cache/irs/irs-YYYY-MM.sqlite`, cached by Actions under the key
 * `irs-YYYY-MM` and rebuilt when missing.
 *
 *   orgs(ein PK, name, sort_name, city, state, subsection, norm_name)
 *     index orgs_state_name (state, norm_name); ein is the primary key
 *   tokens(token, state, ein) PK (token, state, ein): name and sort-name tokens,
 *     the same tokens `memoryIrsLookup` uses, so `candidates` returns the same
 *     records in the same order for the same data
 *   meta(key, value): built_at, month, records, skipped, sources
 */

export const IRS_SCHEMA_VERSION = "1";

const SCHEMA = `
CREATE TABLE orgs (
  ein TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  subsection TEXT NOT NULL,
  norm_name TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE tokens (
  token TEXT NOT NULL,
  state TEXT NOT NULL,
  ein TEXT NOT NULL,
  PRIMARY KEY (token, state, ein)
) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const INDEXES = `CREATE INDEX orgs_state_name ON orgs(state, norm_name);`;

/** `irs-YYYY-MM.sqlite` for the run's calendar month (UTC). */
export function irsDbFileName(now: Date): string {
  return `irs-${now.toISOString().slice(0, 7)}.sqlite`;
}

/** Name used in the lookup's state + name index. */
export function irsNormalizedName(name: string): string {
  return irsNameTokens(name).join(" ");
}

function recordTokens(r: IrsRecord): string[] {
  return [...new Set([...irsNameTokens(r.name), ...(r.sort_name ? irsNameTokens(r.sort_name) : [])])];
}

export interface IrsSource {
  /** A label for logs and meta (the URL or file path). */
  name: string;
  /** The CSV text, in chunks of any size. */
  chunks: AsyncIterable<string>;
}

export interface IrsBuildReport {
  path: string;
  records: number;
  skipped: number;
  sources: string[];
}

/**
 * Streams BMF CSV sources through the pure `irs` stage in batches and writes the
 * database to `path` (via a temp file and rename, so a killed build never leaves
 * a half-written file under the final name). A header row in each source sets
 * the columns for the rows after it.
 */
export async function buildIrsDb(
  ctx: Context,
  path: string,
  sources: readonly IrsSource[],
  opts: { batchSize?: number } = {},
): Promise<IrsBuildReport> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  const db: Db = new DatabaseSync(tmp);
  let records = 0;
  let skipped = 0;
  try {
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
    db.exec(SCHEMA);
    const insOrg = db.prepare(
      "INSERT OR IGNORE INTO orgs (ein, name, sort_name, city, state, subsection, norm_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insTok = db.prepare("INSERT OR IGNORE INTO tokens (token, state, ein) VALUES (?, ?, ?)");
    for (const source of sources) {
      let header: string[] | null = null;
      for await (const batch of csvRows(source.chunks, opts.batchSize ?? 5000)) {
        const first = batch[0];
        if (first && first[0]?.trim().toUpperCase() === "EIN") header = first;
        const rows = header && batch[0] !== header ? [header, ...batch] : batch;
        const out = irs(ctx, { rows });
        skipped += out.output.skipped;
        db.exec("BEGIN");
        for (const r of out.output.records) {
          const res = insOrg.run(r.ein, r.name, r.sort_name, r.city, r.state, r.subsection, irsNormalizedName(r.name));
          if (Number(res.changes) === 0) {
            skipped++;
            continue;
          }
          records++;
          for (const t of recordTokens(r)) insTok.run(t, r.state, r.ein);
        }
        db.exec("COMMIT");
      }
      ctx.log.info("irs source loaded", { source: source.name, records });
    }
    db.exec(INDEXES);
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("schema_version", IRS_SCHEMA_VERSION);
    meta.run("built_at", ctx.now.toISOString());
    meta.run("month", ctx.now.toISOString().slice(0, 7));
    meta.run("records", String(records));
    meta.run("skipped", String(skipped));
    meta.run("sources", JSON.stringify(sources.map((s) => s.name)));
    db.exec("ANALYZE");
  } catch (err) {
    db.close();
    await rm(tmp, { force: true });
    throw err;
  }
  db.close();
  if (records === 0) {
    await rm(tmp, { force: true });
    throw new Error("IRS build produced no records; keeping the previous database");
  }
  await rename(tmp, path);
  return { path, records, skipped, sources: sources.map((s) => s.name) };
}

const orgRowSchema = irsRecordSchema;
const metaRowSchema = z.object({ key: z.string(), value: z.string() });

export interface SqliteIrsLookup extends IrsLookup {
  readonly path: string;
  meta(): Record<string, string>;
  close(): void;
}

/**
 * The node:sqlite `IrsLookup` over a built database (read-only). Same contract as
 * `memoryIrsLookup`: `candidates` returns records in `state` (nationwide when
 * null) whose NAME or SORT_NAME shares a token with `name`, most shared tokens
 * first, then by EIN.
 */
export function openIrsLookup(path: string): SqliteIrsLookup {
  const db: Db = new DatabaseSync(path, { readOnly: true });
  const byEin = db.prepare(
    "SELECT ein, name, city, state, subsection, sort_name FROM orgs WHERE ein = ?",
  );
  const stmts = new Map<string, NodeSqlite.StatementSync>();
  const candidatesStmt = (n: number, withState: boolean): NodeSqlite.StatementSync => {
    const key = `${n}:${withState}`;
    let s = stmts.get(key);
    if (!s) {
      const marks = Array.from({ length: n }, () => "?").join(", ");
      s = db.prepare(
        `SELECT o.ein, o.name, o.city, o.state, o.subsection, o.sort_name, count(*) AS shared
         FROM tokens t JOIN orgs o ON o.ein = t.ein
         WHERE t.token IN (${marks})${withState ? " AND t.state = ?" : ""}
         GROUP BY t.ein ORDER BY shared DESC, t.ein ASC LIMIT ?`,
      );
      stmts.set(key, s);
    }
    return s;
  };
  const toRecord = (row: unknown): IrsRecord => {
    const { ein, name, city, state, subsection, sort_name } = row as Record<string, unknown>;
    return orgRowSchema.parse({ ein, name, city, state, subsection, sort_name });
  };
  return {
    path,
    byEin(ein) {
      const row = byEin.get(ein.replace(/\D/g, ""));
      return row ? toRecord(row) : null;
    },
    candidates(name, state, limit) {
      const tokens = [...new Set(irsNameTokens(name))];
      if (tokens.length === 0 || limit <= 0) return [];
      const params: (string | number)[] = [...tokens];
      if (state !== null) params.push(state.toUpperCase());
      params.push(limit);
      return candidatesStmt(tokens.length, state !== null)
        .all(...params)
        .map(toRecord);
    },
    meta() {
      const out: Record<string, string> = {};
      for (const r of db.prepare("SELECT key, value FROM meta").all()) {
        const m = metaRowSchema.parse({ ...r });
        out[m.key] = m.value;
      }
      return out;
    },
    close() {
      db.close();
    },
  };
}
