import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveBudget } from "@gof/shared/budget";
import { MemoryD1 } from "../d1/memory.ts";
import { memoryLogger } from "../lib/logger.ts";
import { PATHS } from "../lib/paths.ts";
import { loadOverrides, type Overrides } from "../overrides/load.ts";
import { newRunRow, runRowPlan } from "../run/accounting.ts";
import { stubHandlers, type StageHandlers } from "../run/handlers.ts";
import { runPipeline } from "../run/runner.ts";
import { runRowSchema } from "../stages/rows.ts";
import type { Context } from "../stages/types.ts";
import { completedStates, coursesHandler, type CoursesHandlerDeps } from "./monthly.ts";
import type { OsmFeature } from "./overpass.ts";

const NOW = new Date("2026-10-01T10:30:00.000Z");
let overrides: Overrides | null = null;

async function ctx(env: Record<string, string> = {}): Promise<Context> {
  overrides ??= await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
  let t = 0;
  return {
    now: NOW,
    caps: resolveBudget("monthly", env),
    overrides,
    log: memoryLogger(),
    clock: { nowMs: () => (t += 1) },
  };
}

async function runCourses(
  deps: CoursesHandlerDeps,
  opts: {
    d1?: MemoryD1;
    env?: Record<string, string>;
    mode?: "dry-run" | "live";
    runId?: string;
  } = {},
) {
  const d1 = opts.d1 ?? new MemoryD1();
  const handlers: StageHandlers = { ...stubHandlers(), courses: coursesHandler(deps) };
  const outcome = await runPipeline(
    {
      mode: opts.mode ?? "dry-run",
      job: "monthly",
      stages: ["courses", "report"],
      failStage: null,
      strict: true,
    },
    { ctx: await ctx(opts.env), d1, handlers, runId: opts.runId ?? "run_courses" },
  );
  const row = runRowSchema.parse({
    ...d1.db.prepare(`SELECT * FROM runs WHERE id = '${opts.runId ?? "run_courses"}'`).get(),
  });
  return { outcome, d1, row, stagesDone: JSON.parse(row.stages_done) as string[] };
}

const courseRow = z.object({
  osm_ref: z.string(),
  slug: z.string(),
  state: z.string(),
  course_type: z.string(),
  course_type_source: z.string().nullable(),
});
const coursesIn = (d1: MemoryD1) =>
  d1.db
    .prepare("SELECT osm_ref, slug, state, course_type, course_type_source FROM courses")
    .all()
    .map((r) => courseRow.parse({ ...r }));

const feature = (
  osmRef: string,
  name: string,
  lat: number,
  lng: number,
  tags: Record<string, string> = {},
): OsmFeature => ({
  osmRef,
  state: "XX",
  lat,
  lng,
  tags: { leisure: "golf_course", name, ...tags },
});

describe("completedStates", () => {
  it("collects courses:XX from earlier runs and stops at a finished stage", () => {
    expect(
      completedStates(
        [
          { id: "a", stages_done: '["courses:AZ","courses:CA"]' },
          { id: "me", stages_done: '["courses:NY"]' },
          { id: "b", stages_done: "not json" },
        ],
        "me",
      ),
    ).toEqual(new Set(["AZ", "CA"]));
    expect(completedStates([{ id: "a", stages_done: '["courses:AZ","courses"]' }], "me")).toBe(
      "all",
    );
  });
});

describe("courses handler (SPEC.md 8.1 step 1)", () => {
  it("imports every fixture state in a dry run and records each state in stages_done", async () => {
    const { outcome, d1, stagesDone } = await runCourses({});
    expect(outcome.exitCode).toBe(0);
    expect(stagesDone).toEqual([
      "courses:AZ",
      "courses:CA",
      "courses:CT",
      "courses:FL",
      "courses:GA",
      "courses:IL",
      "courses:MO",
      "courses:NJ",
      "courses:NY",
      "courses:PA",
      "courses",
      "report",
    ]);
    const rows = coursesIn(d1);
    expect(rows.length).toBeGreaterThan(50);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    // Seeded course types (course-types.yaml) keep `override` as their source.
    const overridden = (overrides?.courseTypes ?? []).filter((o) => o.osm_ref);
    expect(overridden.length).toBeGreaterThan(0);
    for (const o of overridden) {
      const r = rows.find((x) => x.osm_ref === o.osm_ref);
      if (!r) continue;
      expect(r, o.osm_ref).toMatchObject({
        course_type: o.course_type,
        course_type_source: "override",
      });
    }
    expect(outcome.state.counters.courses_imported).toBe(rows.length);
  });

  it("re-importing keeps slugs and ids stable", async () => {
    const d1 = new MemoryD1();
    await runCourses({}, { d1, runId: "run_first" });
    const before = d1.db.prepare("SELECT id, slug, osm_ref FROM courses ORDER BY osm_ref").all();
    // A later month re-imports everything.
    const later = { ...(await ctx()), now: new Date("2026-11-01T10:30:00.000Z") };
    const handlers: StageHandlers = { ...stubHandlers(), courses: coursesHandler({}) };
    await runPipeline(
      {
        mode: "dry-run",
        job: "monthly",
        stages: ["courses", "report"],
        failStage: null,
        strict: true,
      },
      { ctx: later, d1, handlers, runId: "run_second" },
    );
    expect(d1.db.prepare("SELECT id, slug, osm_ref FROM courses ORDER BY osm_ref").all()).toEqual(
      before,
    );
  });

  it("resumes after the states an earlier run this month finished", async () => {
    const d1 = new MemoryD1();
    const prior = {
      ...newRunRow("run_killed", "monthly", new Date("2026-10-01T08:00:00.000Z")),
      stages_done: '["courses:AZ","courses:CA"]',
    };
    await d1.apply(runRowPlan(prior));
    const asked: string[] = [];
    const { stagesDone } = await runCourses(
      {
        states: async () => ["AZ", "CA", "NY"],
        featuresFor: async (state) => {
          asked.push(state);
          return [feature("way/9001", "Resume Test Golf Club", 40.95, -73.74)];
        },
      },
      { d1 },
    );
    expect(asked).toEqual(["NY"]);
    expect(stagesDone).toEqual(["courses:NY", "courses", "report"]);
  });

  it("skips the import when an earlier run this month finished it", async () => {
    const d1 = new MemoryD1();
    await d1.apply(
      runRowPlan({ ...newRunRow("run_done", "monthly", NOW), stages_done: '["courses"]' }),
    );
    const asked: string[] = [];
    await runCourses({ featuresFor: async (s) => (asked.push(s), []) }, { d1 });
    expect(asked).toEqual([]);
  });

  it("records a failed state, keeps going, and leaves it for the next run", async () => {
    const { outcome, stagesDone, row } = await runCourses({
      states: async () => ["NJ", "NY"],
      featuresFor: async (state) => {
        if (state === "NJ") throw new Error("Overpass HTTP 504");
        return [feature("way/9002", "Fail Test Golf Club", 40.95, -73.74)];
      },
    });
    expect(stagesDone).toEqual(["courses:NY", "courses", "report"]);
    expect(JSON.parse(row.errors)).toEqual([
      { stage: "courses", kind: "network", message: "Overpass NJ: Overpass HTTP 504" },
    ]);
    expect(outcome.state.counters.fetch_errors).toBe(1);
  });

  it("stops at MAX_FETCHES_PER_RUN and records the budget hit", async () => {
    const asked: string[] = [];
    const { row, stagesDone } = await runCourses(
      {
        states: async () => ["CT", "NJ", "NY"],
        featuresFor: async (s) => (asked.push(s), []),
      },
      { env: { MAX_FETCHES_PER_RUN: "2" } },
    );
    expect(asked).toEqual(["CT", "NJ"]);
    expect(stagesDone).toEqual(["courses:CT", "courses:NJ", "courses", "report"]);
    expect(JSON.parse(row.budget_hits)).toMatchObject([
      { stage: "courses", cap: "MAX_FETCHES_PER_RUN", limit: 2 },
    ]);
    expect(row.fetches).toBe(2);
  });

  it("keeps a course on a state line under the state that stored it first", async () => {
    const d1 = new MemoryD1();
    const shared = (s: string) => ({
      ...feature("way/9003", "Border Golf Club", 40.99, -73.66),
      state: s,
    });
    await runCourses(
      { states: async () => ["NY", "CT"], featuresFor: async (s) => [shared(s)] },
      { d1 },
    );
    expect(
      coursesIn(d1)
        .filter((r) => r.osm_ref === "way/9003")
        .map((r) => r.state),
    ).toEqual(["NY"]);
  });
});
