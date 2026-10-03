import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type { z } from "zod";
import type { Snapshot } from "./port.ts";

// node:sqlite through require: Vitest's resolver does not know the builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
export type Sqlite = NodeSqlite.DatabaseSync;

export function openSqlite(path: string, opts: { readOnly?: boolean } = {}): Sqlite {
  return new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
}

/** Loads a `wrangler d1 export` dump in one transaction (seconds become milliseconds). */
export function loadDump(db: Sqlite, dumpSql: string): void {
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  db.exec("BEGIN;");
  try {
    db.exec(dumpSql);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/** A Snapshot over an open database; rows come back validated. */
export function snapshotOver(db: Sqlite, onClose: () => void = () => db.close()): Snapshot {
  return {
    all<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
      const rows = db.prepare(sql).all() as unknown[];
      return rows.map((r, i) => {
        const parsed = schema.safeParse({ ...(r as object) });
        if (!parsed.success)
          throw new Error(`snapshot row ${i} of "${sql}": ${parsed.error.message}`);
        return parsed.data;
      });
    },
    close: onClose,
  };
}
