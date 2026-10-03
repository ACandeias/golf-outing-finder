import { describe, expect, it } from "vitest";
import {
  D1_MAX_ROWS_PER_STATEMENT,
  D1_MAX_STATEMENTS_PER_FILE,
  D1_MAX_STATEMENT_BYTES,
  chunkStatements,
  insertStatements,
  sqlValue,
} from "./literal.ts";

describe("sqlValue", () => {
  it("renders literals with no bound parameters", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(undefined)).toBe("NULL");
    expect(sqlValue(42)).toBe("42");
    expect(sqlValue(-73.7538567)).toBe("-73.7538567");
    expect(sqlValue(true)).toBe("1");
    expect(sqlValue(false)).toBe("0");
    expect(sqlValue("O'Fallon")).toBe("'O''Fallon'");
    expect(sqlValue("Hope & Heroes; DROP TABLE x;--")).toBe("'Hope & Heroes; DROP TABLE x;--'");
  });
  it("rejects values that cannot be literals", () => {
    expect(() => sqlValue(Number.NaN)).toThrow();
    expect(() => sqlValue(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => sqlValue("a\u0000b")).toThrow(/NUL/);
  });
});

describe("insertStatements", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `n${i}` }));

  it("puts at most 50 rows in one statement", () => {
    const stmts = insertStatements("t", ["id", "name"], rows);
    expect(D1_MAX_ROWS_PER_STATEMENT).toBe(50);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^INSERT INTO t \(id, name\) VALUES \(0, 'n0'\),/);
    expect(stmts[2]?.match(/\),\(|\)\s*,\s*\(/g)?.length).toBe(19);
    for (const s of stmts) expect(s).not.toContain("?");
  });

  it("splits further to stay under the statement byte limit", () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: i, text: "x".repeat(30_000) }));
    const stmts = insertStatements("t", ["id", "text"], big);
    expect(D1_MAX_STATEMENT_BYTES).toBe(100_000);
    for (const s of stmts) expect(Buffer.byteLength(s)).toBeLessThan(D1_MAX_STATEMENT_BYTES);
    expect(stmts.length).toBeGreaterThanOrEqual(4);
  });

  it("throws when a single row is over the limit", () => {
    expect(() => insertStatements("t", ["text"], [{ text: "x".repeat(200_000) }])).toThrow(/too large/);
  });

  it("supports INSERT OR IGNORE and returns nothing for no rows", () => {
    expect(insertStatements("t", ["id"], [{ id: 1 }], { verb: "INSERT OR IGNORE" })[0]).toMatch(
      /^INSERT OR IGNORE INTO t/,
    );
    expect(insertStatements("t", ["id"], [])).toEqual([]);
  });
});

describe("chunkStatements", () => {
  it("puts at most 1,000 statements in a file", () => {
    const stmts = Array.from({ length: 2500 }, (_, i) => `SELECT ${i};`);
    const files = chunkStatements(stmts);
    expect(D1_MAX_STATEMENTS_PER_FILE).toBe(1000);
    expect(files.map((f) => f.length)).toEqual([1000, 1000, 500]);
  });
});
