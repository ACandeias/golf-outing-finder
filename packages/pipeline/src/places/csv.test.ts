import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv.ts";

describe("csv", () => {
  it("round-trips quoting, commas, quotes and empty fields", () => {
    const rows = [
      ["id", "name", "note"],
      ["1", "Winston-Salem", ""],
      ["2", 'Say "hi"', "a,b"],
      ["3", "line\nbreak", "x"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("ignores a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
