/**
 * Literal-value SQL for D1 (SPEC.md 8.0): `wrangler d1 execute --file` with no
 * bound parameters, at most 50 rows per statement, at most 1,000 statements per
 * file, and every statement under D1's 100 KB limit.
 */
export const D1_MAX_ROWS_PER_STATEMENT = 50;
export const D1_MAX_STATEMENTS_PER_FILE = 1000;
export const D1_MAX_STATEMENT_BYTES = 100_000;

export type SqlScalar = string | number | boolean | null | undefined;

export function sqlValue(v: SqlScalar): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
    return String(v);
  }
  if (v.includes("\u0000")) throw new Error("NUL character in a SQL string literal");
  return `'${v.replace(/'/g, "''")}'`;
}

export function sqlIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

export interface InsertOptions {
  verb?: "INSERT" | "INSERT OR IGNORE" | "INSERT OR REPLACE";
  maxRows?: number;
  maxBytes?: number;
  /** Appended after VALUES, e.g. an `ON CONFLICT ... DO UPDATE` clause. */
  suffix?: string;
}

export function insertStatements<R extends Readonly<Record<string, SqlScalar>>>(
  table: string,
  columns: readonly (keyof R & string)[],
  rows: readonly R[],
  options: InsertOptions = {},
): string[] {
  const verb = options.verb ?? "INSERT";
  const maxRows = options.maxRows ?? D1_MAX_ROWS_PER_STATEMENT;
  const maxBytes = options.maxBytes ?? D1_MAX_STATEMENT_BYTES;
  const head = `${verb} INTO ${sqlIdent(table)} (${columns.map(sqlIdent).join(", ")}) VALUES `;
  const suffix = options.suffix ? ` ${options.suffix}` : "";
  const headBytes = Buffer.byteLength(head) + Buffer.byteLength(suffix) + 1; // + ";"
  const out: string[] = [];
  let tuples: string[] = [];
  let bytes = headBytes;
  const flush = (): void => {
    if (tuples.length > 0) out.push(`${head}${tuples.join(",")}${suffix};`);
    tuples = [];
    bytes = headBytes;
  };
  for (const row of rows) {
    const tuple = `(${columns.map((c) => sqlValue(row[c])).join(", ")})`;
    const tupleBytes = Buffer.byteLength(tuple) + 1;
    if (headBytes + tupleBytes >= maxBytes) {
      throw new Error(`row too large for one D1 statement (${tupleBytes} bytes) in ${table}`);
    }
    if (tuples.length >= maxRows || bytes + tupleBytes >= maxBytes) flush();
    tuples.push(tuple);
    bytes += tupleBytes;
  }
  flush();
  return out;
}

export function chunkStatements(
  statements: readonly string[],
  maxPerFile = D1_MAX_STATEMENTS_PER_FILE,
): string[][] {
  const files: string[][] = [];
  for (let i = 0; i < statements.length; i += maxPerFile) {
    files.push(statements.slice(i, i + maxPerFile));
  }
  return files;
}
