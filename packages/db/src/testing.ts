import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { GofDb } from "../src/queries.ts";

// Node's built-in SQLite, loaded through require because Vitest 2's resolver does
// not know the `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
export type Sqlite = NodeSqlite.DatabaseSync;

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** A fresh in-memory database with every migration applied. */
export function migratedSqlite(): Sqlite {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

type Param = null | number | bigint | string | NodeJS.ArrayBufferView;

/**
 * Drizzle over node:sqlite through the sqlite-proxy driver, the same async query
 * builder the Worker uses with D1. Rows go back as arrays so joined columns with
 * the same name do not collide.
 */
export function drizzleOver(sqlite: Sqlite): GofDb {
  return drizzle(async (query, params, method) => {
    const stmt = sqlite.prepare(query);
    const args = params as Param[];
    if (method === "run") {
      stmt.run(...args);
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    if (method === "get") {
      const row = stmt.get(...args) as unknown;
      return { rows: (row ?? undefined) as unknown[] };
    }
    return { rows: stmt.all(...args) as unknown[] };
  });
}
