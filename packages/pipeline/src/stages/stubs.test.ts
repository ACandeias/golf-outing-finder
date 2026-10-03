import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyOverrides } from "../overrides/load.ts";
import { resolveBudget } from "@gof/shared/budget";
import {
  isImplemented,
  isNotImplementedError,
  type NotImplemented,
  notImplemented,
} from "./not-implemented.ts";
import {
  MONTHLY_STAGES,
  NIGHTLY_STAGES,
  selectStages,
  STAGES,
  STAGE_NAMES,
  stageImplemented,
} from "./registry.ts";
import type { Context } from "./types.ts";

const ctx: Context = {
  now: new Date("2026-09-28T12:00:00Z"),
  caps: resolveBudget("nightly"),
  overrides: emptyOverrides(),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  clock: { nowMs: () => 0 },
};

describe("stage stubs", () => {
  it("throw NotImplemented naming the stage", () => {
    const stub = notImplemented<object, object>("classify");
    expect(isImplemented(stub)).toBe(false);
    let caught: unknown;
    try {
      stub(ctx, {});
    } catch (err) {
      caught = err;
    }
    expect(isNotImplementedError(caught)).toBe(true);
    expect((caught as NotImplemented).stage).toBe("classify");
    expect((caught as Error).message).toBe("stage not implemented: classify");
  });

  it("treats any plain function as implemented", () => {
    expect(isImplemented(() => ({ output: {}, result: {} }))).toBe(true);
    expect(isImplemented(undefined)).toBe(false);
  });

  it("every registered stage function either is real or throws its own stage name", () => {
    for (const name of STAGE_NAMES) {
      for (const fn of STAGES[name].fns) {
        if (isImplemented(fn)) continue;
        expect(() => (fn as (c: Context, i: unknown) => unknown)(ctx, {})).toThrow(
          `stage not implemented: ${name}`,
        );
      }
    }
  });

  it("only the report stage is implemented by workstream A", () => {
    expect(stageImplemented("report")).toBe(true);
    for (const name of STAGE_NAMES) {
      if (STAGES[name].owner === "A") expect(stageImplemented(name)).toBe(true);
    }
  });
});

describe("stage registry", () => {
  it("lists the SPEC 8 stages in run order with report last", () => {
    expect(NIGHTLY_STAGES).toEqual([
      "discover",
      "fetch",
      "normalize",
      "extract-request-build",
      "extract-collect",
      "classify",
      "match",
      "dedupe-upsert",
      "publish",
      "recheck-roll-forward",
      "report",
    ]);
    expect(MONTHLY_STAGES).toEqual(["courses", "irs", "course-types", "report"]);
  });

  it("selects stages by name, keeps run order, always ends with report", () => {
    expect(selectStages(undefined, "nightly")).toEqual([...NIGHTLY_STAGES]);
    expect(selectStages(undefined, "monthly")).toEqual([...MONTHLY_STAGES]);
    expect(selectStages("match,classify", "nightly")).toEqual(["classify", "match", "report"]);
    expect(selectStages("courses,irs,course-types", "monthly")).toEqual([
      "courses",
      "irs",
      "course-types",
      "report",
    ]);
    expect(() => selectStages("classify,bogus", "nightly")).toThrow(/unknown stage\(s\): bogus/);
  });

  it("marks the stages that spend money", () => {
    const paid = STAGE_NAMES.filter((s) => STAGES[s].paid);
    expect(paid).toEqual(["discover", "extract-request-build", "extract-collect", "course-types"]);
  });
});

describe("stage purity", () => {
  const dir = import.meta.dirname;
  const FORBIDDEN = [
    /from\s+["']node:(fs|fs\/promises|net|http|https|child_process|sqlite|dns|tls)["']/,
    /from\s+["'](fs|net|http|https|child_process|dns|undici|playwright|yaml)["']/,
    /from\s+["']\.\.\/(d1|lib|net|run)\//,
    /\bprocess\.env\b/,
    /\bDate\.now\(/,
    /new Date\(\)/,
    /\bfetch\(/,
  ];

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    it(`${file} does no I/O and reads no clock or env`, () => {
      const src = readFileSync(join(dir, file), "utf8");
      for (const pattern of FORBIDDEN)
        expect(src, `${file} matches ${pattern}`).not.toMatch(pattern);
    });
  }
});
