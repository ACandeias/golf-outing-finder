import { describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { emptyOverrides } from "../overrides/load.ts";
import { irs } from "./irs.ts";
import type { Context } from "./types.ts";

const ctx: Context = {
  now: new Date("2026-09-28T12:00:00Z"),
  caps: resolveBudget("monthly"),
  overrides: emptyOverrides(),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  clock: { nowMs: () => 0 },
};

const HEADER = [
  "EIN",
  "NAME",
  "ICO",
  "STREET",
  "CITY",
  "STATE",
  "ZIP",
  "GROUP",
  "SUBSECTION",
  "AFFILIATION",
  "CLASSIFICATION",
  "RULING",
  "DEDUCTIBILITY",
  "FOUNDATION",
  "ACTIVITY",
  "ORGANIZATION",
  "STATUS",
  "TAX_PERIOD",
  "ASSET_CD",
  "INCOME_CD",
  "FILING_REQ_CD",
  "PF_FILING_REQ_CD",
  "ACCT_PD",
  "ASSET_AMT",
  "INCOME_AMT",
  "REVENUE_AMT",
  "NTEE_CD",
  "SORT_NAME",
];

function row(p: {
  ein: string;
  name: string;
  city?: string;
  state?: string;
  sub?: string;
  sort?: string;
}): string[] {
  const r = HEADER.map(() => "");
  r[0] = p.ein;
  r[1] = p.name;
  r[4] = p.city ?? "NEW YORK";
  r[5] = p.state ?? "NY";
  r[8] = p.sub ?? "03";
  r[27] = p.sort ?? "";
  return r;
}

describe("irs stage (SPEC.md 8.1 step 6)", () => {
  it("keeps EIN, name, sort name, city, state and subsection by header name", () => {
    const out = irs(ctx, {
      rows: [HEADER, row({ ein: "990000118", name: "BOYS CLUB OF NEW YORK", sort: "BCNY" })],
    });
    expect(out.output.records).toEqual([
      {
        ein: "990000118",
        name: "BOYS CLUB OF NEW YORK",
        city: "NEW YORK",
        state: "NY",
        subsection: "03",
        sort_name: "BCNY",
      },
    ]);
    expect(out.output.skipped).toBe(0);
    expect(out.result.counters.irs_records).toBe(1);
  });

  it("finds columns by name when the order differs, and re-reads a repeated header", () => {
    const reordered = ["NAME", "STATE", "EIN", "SUBSECTION", "CITY", "SORT_NAME"];
    const out = irs(ctx, {
      rows: [
        reordered,
        ["GUILD HALL OF EAST HAMPTON INC", "NY", "990000104", "03", "EAST HAMPTON", "GUILD HALL"],
        HEADER,
        row({ ein: "990000122", name: "BUILDERS INSTITUTE INC", sub: "06", city: "TARRYTOWN" }),
      ],
    });
    expect(out.output.records.map((r) => [r.ein, r.subsection, r.sort_name])).toEqual([
      ["990000104", "03", "GUILD HALL"],
      ["990000122", "06", null],
    ]);
  });

  it("pads short EINs and one-digit subsections, trims and collapses spaces", () => {
    const out = irs(ctx, {
      rows: [HEADER, row({ ein: "10000101", name: "  ACME   FUND  ", sub: "3", state: "ny" })],
    });
    expect(out.output.records[0]).toMatchObject({
      ein: "010000101",
      name: "ACME FUND",
      subsection: "03",
      state: "NY",
    });
  });

  it("skips rows without a header, bad EINs, foreign states, blank names and duplicate EINs", () => {
    const out = irs(ctx, {
      rows: [
        row({ ein: "990000001", name: "BEFORE HEADER" }),
        HEADER,
        row({ ein: "12-34", name: "BAD EIN" }),
        row({ ein: "990000002", name: "OVERSEAS", state: "" }),
        row({ ein: "990000003", name: "" }),
        row({ ein: "990000004", name: "KEEP ME" }),
        row({ ein: "990000004", name: "KEEP ME AGAIN" }),
        [""],
      ],
    });
    expect(out.output.records.map((r) => r.name)).toEqual(["KEEP ME"]);
    expect(out.output.skipped).toBe(5);
  });

  it("returns nothing for no rows", () => {
    const out = irs(ctx, { rows: [] });
    expect(out.output).toEqual({ records: [], skipped: 0 });
  });
});
