import { classify } from "./classify.ts";
import { courseTypesCollect, courseTypesRequestBuild } from "./course-types.ts";
import { courses } from "./courses.ts";
import { dedupeUpsert } from "./dedupe-upsert.ts";
import { discover, planSearch } from "./discover.ts";
import { extractCollect } from "./extract-collect.ts";
import { extractRequestBuild } from "./extract-request-build.ts";
import { planFetch } from "./fetch-plan.ts";
import { irs } from "./irs.ts";
import { match } from "./match.ts";
import { isImplemented } from "./not-implemented.ts";
import { normalize } from "./normalize.ts";
import { publish } from "./publish.ts";
import { recheckRollForward } from "./recheck-roll-forward.ts";
import { report } from "./report.ts";

/** Stage names as `--stages` and `--fail-stage` take them, in run order. */
export const NIGHTLY_STAGES = [
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
] as const;

/** SPEC.md 12: monthly.yml runs `--stages=courses,irs,course-types`; report always runs. */
export const MONTHLY_STAGES = ["courses", "irs", "course-types", "report"] as const;

export const STAGE_NAMES = [
  ...NIGHTLY_STAGES,
  ...MONTHLY_STAGES.filter((s) => s !== "report"),
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export function isStageName(name: string): name is StageName {
  return (STAGE_NAMES as readonly string[]).includes(name);
}

export type Workstream = "A" | "B" | "C" | "D";

export interface StageInfo {
  name: StageName;
  /** Which Phase 2 workstream implements it. */
  owner: Workstream;
  spec: string;
  /** Spends money (SERP or LLM): checks MONTHLY_SPEND_CAP_CENTS first. */
  paid: boolean;
  /** The pure functions behind the stage. */
  fns: readonly unknown[];
}

export const STAGES: Readonly<Record<StageName, StageInfo>> = Object.freeze({
  discover: { name: "discover", owner: "B", spec: "8.2", paid: true, fns: [planSearch, discover] },
  fetch: { name: "fetch", owner: "B", spec: "8.3", paid: false, fns: [planFetch] },
  normalize: { name: "normalize", owner: "B", spec: "8.3", paid: false, fns: [normalize] },
  "extract-request-build": {
    name: "extract-request-build",
    owner: "C",
    spec: "8.4",
    paid: true,
    fns: [extractRequestBuild],
  },
  "extract-collect": {
    name: "extract-collect",
    owner: "C",
    spec: "8.4",
    paid: true,
    fns: [extractCollect],
  },
  classify: { name: "classify", owner: "C", spec: "8.5", paid: false, fns: [classify] },
  match: { name: "match", owner: "C", spec: "8.6", paid: false, fns: [match] },
  "dedupe-upsert": {
    name: "dedupe-upsert",
    owner: "C",
    spec: "8.7",
    paid: false,
    fns: [dedupeUpsert],
  },
  publish: { name: "publish", owner: "C", spec: "8.8", paid: false, fns: [publish] },
  "recheck-roll-forward": {
    name: "recheck-roll-forward",
    owner: "C",
    spec: "8.9",
    paid: false,
    fns: [recheckRollForward],
  },
  report: { name: "report", owner: "A", spec: "8.10", paid: false, fns: [report] },
  courses: { name: "courses", owner: "D", spec: "8.1", paid: false, fns: [courses] },
  irs: { name: "irs", owner: "D", spec: "8.1", paid: false, fns: [irs] },
  "course-types": {
    name: "course-types",
    owner: "D",
    spec: "8.1",
    paid: true,
    fns: [courseTypesRequestBuild, courseTypesCollect],
  },
});

/** True once every pure function behind the stage has replaced its stub. */
export function stageImplemented(name: StageName): boolean {
  return STAGES[name].fns.every(isImplemented);
}

/** `--stages=a,b,c`: validates names and keeps run order. */
export function selectStages(list: string | undefined, job: "nightly" | "monthly"): StageName[] {
  const order: readonly StageName[] = job === "monthly" ? MONTHLY_STAGES : NIGHTLY_STAGES;
  if (list === undefined || list.trim() === "") return [...order];
  const wanted = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = wanted.filter((s) => !isStageName(s));
  if (unknown.length > 0) {
    throw new Error(`unknown stage(s): ${unknown.join(", ")}. Known: ${STAGE_NAMES.join(", ")}`);
  }
  const set = new Set(wanted);
  // Run order is nightly order, then monthly; report always runs last.
  const all: StageName[] = [
    ...NIGHTLY_STAGES.filter((s) => s !== "report"),
    "courses",
    "irs",
    "course-types",
  ];
  const picked = all.filter((s) => set.has(s));
  return [...picked, "report"];
}
