import type { z } from "zod";
import { migratedSqlite } from "@gof/db/testing";
import { D1_MAX_ROWS_PER_STATEMENT, D1_MAX_STATEMENTS_PER_FILE } from "../sql/literal.ts";
import type { UpsertPlan } from "../stages/types.ts";
import { planToFileChunks } from "./plan-sql.ts";
import type { ApplyReport, D1Port, Snapshot } from "./port.ts";
import { snapshotOver, type Sqlite } from "./sqlite.ts";

/**
 * In-memory D1 for tests and `--d1=memory`: node:sqlite with every migration
 * applied. `apply` runs the same literal SQL the wrangler port would send, file
 * by file, so tests exercise the real statements.
 */
export class MemoryD1 implements D1Port {
  readonly target = "memory" as const;
  readonly db: Sqlite;
  /** Every file applied, as statement lists, for assertions. */
  readonly applied: string[][] = [];

  constructor(db: Sqlite = migratedSqlite()) {
    this.db = db;
  }

  async snapshot(): Promise<Snapshot> {
    return snapshotOver(this.db, () => {});
  }

  async query<T>(sql: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
    return snapshotOver(this.db, () => {}).all(sql, schema);
  }

  async apply(plan: UpsertPlan): Promise<ApplyReport> {
    const files = planToFileChunks(plan);
    let statements = 0;
    for (const file of files) {
      if (file.length > D1_MAX_STATEMENTS_PER_FILE) throw new Error("file over 1,000 statements");
      for (const stmt of file) {
        // Literal SQL only: a `?` outside a string literal would be a bound parameter.
        const outside = stmt.replace(/'(?:[^']|'')*'/g, "''");
        if (outside.includes("?")) throw new Error(`bound parameter in ${stmt.slice(0, 80)}`);
        const tuples = (outside.match(/\),\s*\(/g) ?? []).length + 1;
        if (stmt.startsWith("INSERT") && tuples > D1_MAX_ROWS_PER_STATEMENT)
          throw new Error("statement over 50 rows");
      }
      this.db.exec(`BEGIN;\n${file.join("\n")}\nCOMMIT;`);
      this.applied.push(file);
      statements += file.length;
    }
    return { statements, files: files.length };
  }
}
