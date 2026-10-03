import { describe, expect, it } from "vitest";
import { CsvStreamParser, csvRows } from "./csv-stream.ts";

describe("CsvStreamParser", () => {
  it("parses rows split across arbitrary chunk boundaries", () => {
    const text = 'EIN,NAME\r\n1,"ACME, INC"\n2,"SAY ""HI"""\n3,"LINE\nBREAK"\n4,LAST';
    for (let size = 1; size <= text.length; size++) {
      const p = new CsvStreamParser();
      const rows: string[][] = [];
      for (let i = 0; i < text.length; i += size) rows.push(...p.push(text.slice(i, i + size)));
      rows.push(...p.end());
      expect(rows).toEqual([
        ["EIN", "NAME"],
        ["1", "ACME, INC"],
        ["2", 'SAY "HI"'],
        ["3", "LINE\nBREAK"],
        ["4", "LAST"],
      ]);
    }
  });

  it("does not emit a trailing empty row after the final newline", () => {
    const p = new CsvStreamParser();
    expect([...p.push("a,b\n"), ...p.end()]).toEqual([["a", "b"]]);
  });

  it("csvRows batches rows from an async chunk source", async () => {
    async function* chunks() {
      yield "h1,h2\n1,";
      yield "x\n2,y\n3,z";
    }
    const batches: string[][][] = [];
    for await (const b of csvRows(chunks(), 2)) batches.push(b);
    expect(batches).toEqual([
      [
        ["h1", "h2"],
        ["1", "x"],
      ],
      [
        ["2", "y"],
        ["3", "z"],
      ],
    ]);
  });
});
