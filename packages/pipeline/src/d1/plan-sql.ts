import {
  D1_MAX_STATEMENT_BYTES,
  chunkStatements,
  insertStatements,
  sqlIdent,
  sqlValue,
  type SqlScalar,
} from "../sql/literal.ts";
import { TABLE_PRIMARY_KEYS, tableColumns, type TableName } from "../stages/rows.ts";
import { parseUpsertPlan, type TableOp, type UpsertPlan } from "../stages/types.ts";

/**
 * UpsertPlan to literal-value SQL for `wrangler d1 execute --file` (SPEC.md 8.0):
 * no bound parameters, at most 50 rows per INSERT, every statement under D1's
 * 100 KB limit, and files of at most 1,000 statements (`planToSqlFiles`).
 */

type Row = Readonly<Record<string, SqlScalar>>;

function whereClause(where: Row): string {
  const parts = Object.entries(where).map(([k, v]) =>
    v === null || v === undefined ? `${sqlIdent(k)} IS NULL` : `${sqlIdent(k)} = ${sqlValue(v)}`,
  );
  if (parts.length === 0) throw new Error("refusing an UPDATE or DELETE without a WHERE clause");
  return parts.join(" AND ");
}

function checkSize(stmt: string, table: string): string {
  if (Buffer.byteLength(stmt) >= D1_MAX_STATEMENT_BYTES) {
    throw new Error(`statement on ${table} is over D1's 100 KB limit`);
  }
  return stmt;
}

function upsertSql(
  table: TableName,
  rows: readonly Row[],
  conflict?: readonly string[],
  update?: readonly string[],
): string[] {
  if (rows.length === 0) return [];
  const columns = tableColumns(table);
  const target = conflict ?? TABLE_PRIMARY_KEYS[table];
  const set = update ?? columns.filter((c) => !target.includes(c));
  const action =
    set.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${set.map((c) => `${sqlIdent(c)} = excluded.${sqlIdent(c)}`).join(", ")}`;
  const suffix = `ON CONFLICT(${target.map(sqlIdent).join(", ")}) ${action}`;
  return insertStatements(table, columns, rows, { suffix });
}

function opSql(op: TableOp): string[] {
  const table = op.table;
  switch (op.op) {
    case "upsert":
      return upsertSql(
        table,
        op.rows as readonly Row[],
        op.conflict as readonly string[] | undefined,
        op.update as readonly string[] | undefined,
      );
    case "update": {
      const set = Object.entries(op.set as Row).map(([k, v]) => `${sqlIdent(k)} = ${sqlValue(v)}`);
      if (set.length === 0) return [];
      return [
        checkSize(
          `UPDATE ${sqlIdent(table)} SET ${set.join(", ")} WHERE ${whereClause(op.where as Row)};`,
          table,
        ),
      ];
    }
    case "delete":
      return [
        checkSize(`DELETE FROM ${sqlIdent(table)} WHERE ${whereClause(op.where as Row)};`, table),
      ];
  }
}

/** Validates the plan, then renders each op in order. */
export function planToStatements(plan: UpsertPlan): string[] {
  parseUpsertPlan(plan);
  return plan.ops.flatMap(opSql);
}

/** Statements grouped into files of at most 1,000. */
export function planToFileChunks(plan: UpsertPlan): string[][] {
  return chunkStatements(planToStatements(plan));
}
